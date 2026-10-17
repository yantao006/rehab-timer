# 同步 API 契约

所有数据接口仅同源 HTTPS 调用，绑定 D1 名称为 `DB`，环境变量为 `APP_ENV`（`preview` 或 `production`）、`SHARED_PASSPHRASE` 和 `SESSION_SECRET`。
缺少配置时返回 503，认证失败返回 401，来源不符返回 403，格式错误返回 400，版本或写入权冲突返回 409。
错误统一为 `{ok:false,error:{code,message},session?}`，其中 `session` 是冲突发生时的服务器会话。
所有 JSON 响应为 `Cache-Control: no-store`。
口令至少 8 个字符，SESSION_SECRET 至少 32 个字符，并应使用密码学随机值且跨部署保持不变。
更换共享口令会使已有登录 Cookie 失效，不必更换 SESSION_SECRET。
写入令牌只保存 SHA-256 摘要；接管令牌通过持久服务端密钥和操作信息重新派生，使丢失响应可以幂等重试。

## 认证与读取

- `POST /api/login` 输入 `{passphrase}`，成功返回 `{ok:true,environment}` 并设置 `rehab_session` 安全 Cookie。
- `POST /api/logout` 输入 `{}`，成功清除 Cookie。
- `GET /api/state` 返回 `{ok:true,environment,records,sessions}`。
- 会话为 `{id,program,status,snapshot,revision,writerEpoch,updatedAt}`，`status` 为 `active`、`completed`、`abandoned`。
- 快照与训练核心一致：`{version:1,planRevision:2,program,unitMs:1000,id,index,remaining,state,completion}`。
- `records` 包含撤销记录，以 `{id,program,date,finishedAt,source,timeZone,revoked,revokedAt}` 表示。
- `source` 为 `training`、`manual`、`legacy`，`finishedAt` 对手工补记可为 null，旧时区用 null。
- 客户端统计时仅使用 `revoked === false` 的记录。
- 所有会话的 `snapshot` 读取后必须以暂停或就位恢复，不能自动播放，也不能直接接管。

## 幂等操作

`POST /api/operation` 请求必须包含 `{operationId,type}`。
标识允许 8 至 100 个英文字母、数字、下划线、连字符。
`program` 仅接受 `five-stage-v1` 或 `lower-limb-joints-v1`。
同一 operationId 和相同 JSON 内容（忽略字段顺序）返回第一次结果，内容不同返回 `operation_id_reused`。
成功响应为 `{ok:true,operationId,session?,record?,import?,writerToken?}`。
客户端只在成功响应后移除待同步操作，不因 409 覆盖服务器数据或自动换令牌。

| type | 必需输入 | 行为 |
| --- | --- | --- |
| create | program, sessionId, snapshot, writerToken | 首次创建 active 会话，revision=1、writerEpoch=1；writerToken 由客户端随机生成，至少 32 字符。 |
| progress | program, sessionId, snapshot, expectedRevision, writerEpoch, writerToken | 有条件保存 active 快照，revision 增加 1。 |
| complete | program, sessionId, snapshot, record, expectedRevision, writerEpoch, writerToken | finished 快照和训练记录原子写入，revision 增加 1；完成时间与日期须与 snapshot.completion 一致。 |
| abandon | program, sessionId, expectedRevision, writerEpoch, writerToken | 终止会话并增加 revision；不产生完成记录。 |
| claim | program, sessionId, expectedRevision | 明确手动接管 active 会话，revision 和 writerEpoch 都增加 1，返回新 writerToken。 |
| manual | program, record | 创建补记记录；record 为 `{id,program,date,finishedAt:null,source:"manual",timeZone?}`。 |
| revoke | program, recordId | 只撤销指定记录，不影响同日的任何其他记录。 |
| import | sourceId, records, overrides, progress | 下述迁移格式，一批最多 500 条完成记录、500 条覆盖、2 条进度。 |

训练记录输入为 `{id,program,date,finishedAt,source:"training",timeZone?}`。
`id` 必须等于 sessionId，完成日期保留设备完成时的本地日期，timeZone 使用 IANA 名称或 null。
服务端不使用接收日期覆盖完成日期。
日期不得晚于全球当前最早进入的日历日期，完成时间不得明显晚于服务器当前时间。
create 可接受实际训练中途的非 finished 快照，离线开始后上传无需回放。
终态不可恢复；迟到进度及旧 epoch 均返回冲突。

## 旧数据导入

sourceId 为本浏览器迁移来源的持久随机 ID，不随重试或刷新改变。
导入应读取原始 done、date、progress 键，不能读取投影后的 Store.history()。
records 为 `[{key,program,record:{version:1,id,date,finishedAt}}]`。
overrides 为 `[{key,program,date,completed:true|false}]`。
progress 为 `[{key,program,snapshot,writerToken}]`，writerToken 为客户端持久生成的至少 32 字符随机令牌。
key 必须与正式前缀一致：原计划 `rehab-timer:v1`，新计划 `rehab-timer:v1:joint`，禁止 test 前缀。
每项 key 必须与其 ID、日期或 progress 后缀一致。
未结束进度创建 active 会话，revision=1、writerEpoch=1，恢复必须手动继续；finished 进度修复对应完成记录。
非法条目整批返回 400，客户端预览时保留并单独列出损坏项，不上传这些项。
返回 `import:{sourceId,insertedRecords,insertedSessions,revokedRecordIds,manualRecordIds,conflicts}`，前三种 ID 列表中记录 ID 均用 `{program,id}`，conflicts 为 `{program,id?,date?,reason}`。
同 program 和 id 的云记录不会重复插入，也不会被改写。
false 仅撤销本批新插入的指定日期记录，云端已有同 ID 记录列为 `existing_record_not_revoked` 冲突。
true 仅在该日期没有有效云记录时生成一条补记。
导入调整使用 sourceId、旧 key 和值的稳定摘要生成记录或操作 ID，重复导入不会重复增加次数。
同源此前已导入 false 覆盖不会在之后新完成时再次隐藏新记录。
原始覆盖内容及核对结果保存在 legacy_imports，旧浏览器键不删除。

## 数据库事务与测试

所有业务写入通过 app_state 的递增版本串行确认，事务中的 CHECK 断言在版本不符时使整个 D1 batch 回滚。
竞争重试仍验证客户端原始 expectedRevision 和 writerEpoch，不能将旧操作隐式变成新版操作。
迁移的同类 INSERT 通过 json_each 读取一个绑定 JSON 参数，500 条记录和 500 条覆盖仍低于 50 条数据库查询。
operation_log 保存操作摘要和原始成功响应，不能在正常清理中删除尚可能重试的操作。
原始会话和记录不物理删除，撤销只追加 calendar_adjustments。
服务端异常只记录错误类型，不输出口令、请求体、Cookie 或训练内容。

本地验证使用真实 SQLite 的外键、CHECK、唯一性和事务回滚，无本地服务器。
`node --test tests/api.test.mjs tests/integration.test.mjs` 同时检查 API 行为、实际训练计划一致性和浏览器仓储到 API 的完整协议。
部署后还需要在独立预览 D1 上检查 Pages Functions 绑定、Cookie 和远程事务，不能用本地测试代替线上验证。

## 排程修订与旧快照兼容

planRevision 与记录格式 version 分开管理。
当前所有新快照输出 planRevision:2，完成记录的 version 仍为 1。
原计划第五项在前三轮踮脚和拉伸之后各增加 30 秒 round-rest，可明确跳过，第四轮拉伸后直接完成。
新原计划共 104 段、固定计时 1520 秒；下肢关节计划仍为 99 段。

没有 planRevision 或显式 planRevision:1 的快照，必须先按旧的 101 段原计划校验。
第五项旧索引 93、94、95、96、97、98、99、100 对应新索引 93、94、96、97、99、100、102、103。
动作身份、剩余毫秒和原完成日期保持不变，旧动作不能被解释为新增的轮间休息。
其他原计划索引和全部下肢计划索引不变。
新版本的索引 95、98、101 则分别表示前三轮轮休，不能再套用旧索引转换。
未知 planRevision 拒绝恢复与写入，不猜测排程。

浏览器恢复、旧数据导入、服务器已有会话读取、手动接管以及旧操作日志重放均采用这一转换。
接管或下一次合法写入将保存当前 planRevision，读取不会改变会话版本号或写入权。
已发送或已持久化的待同步请求必须保留原始请求体和操作 ID，由服务端识别旧排程，不能因为页面更新重写请求内容。
旧幂等响应中的进度会转换为相同动作的新版快照，其完成日期、会话版本和写入令牌保持不变。
