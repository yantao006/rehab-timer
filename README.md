# 康复训练计时器

两套固定康复训练计划的语音教练：声音带你练，屏幕远看一眼就懂，完成记录在后台自动保存。
正式入口：

https://train.yantao006.com/

https://rehab-timer.pages.dev/

训练剂量和流程以 [PRODUCT.md](PRODUCT.md) 为准，视觉规则见 [DESIGN.md](DESIGN.md)，口令素材见 [audio/README.md](audio/README.md)。

## 使用

- 首页选一套计划；有未练完的进度时卡片上直接点“继续”。
- 训练准备页看器材清单、选组间休息、试听声音，然后“开始训练”。
- 训练中把手机放在一旁，跟着口令练：升调开始，降调放松，最后三秒倒数。
- 每项结束后点“准备好了，开始”，有 10 秒就位倒数。
- 暂停后继续：保持段这一次从头开始，休息从停下的地方接着计时。
- “记录”是一张月历，可以补记或撤销单条记录。
- 建议把网页添加到手机主屏幕，全屏打开；训练时页面会尽量保持屏幕常亮。

## 源码和构建

需要 Node.js 22.13 或更新版本；CI 使用 Node.js 24。不依赖前端框架或运行时第三方包。

| 路径 | 职责 |
| --- | --- |
| `src/core.js` | 两套计划、时间线与口令排程、训练状态（纯逻辑，测试直接执行） |
| `src/audio.js` | 解码口令素材，离线合成连续音轨 |
| `src/store.js` | 偏好、本机进度、完成记录与后台上传、旧数据接续 |
| `src/app.js` | 页面切换、播放时钟、中断处理、记录页 |
| `src/template.html`、`src/styles.css` | 页面结构、动作示意图、样式 |
| `audio/voice.wav`、`audio/voice.json` | 全部口令素材及每句的位置 |
| `images/` | 双腿关节训练的动作示意图（来源见 `images/README.md`） |
| `functions/` | Pages Functions：完成记录的读、写、撤销 |
| `migrations/` | D1 表结构（沿用，不需要新迁移） |
| `index.html` | 构建生成，不手工修改 |

```sh
npm run build          # 生成 index.html
npm run validate       # 构建一致性 + 全部测试 + diff 空白检查
npm run build:publish  # 生成 .publish/（页面、口令素材、路由和缓存头）
```

## 测试和浏览器验收

`npm test` 覆盖：

- 剂量回归：左腿计划 104 段、默认 1520 秒，双腿计划 99 段，四档组休逐档加 2 分钟；
- 口令时序：口令互不重叠，“放松”不早于边界，保持段只有“三二一”，就位介绍在倒数前说完；
- 暂停与跳过：保持段从头重来、休息原处继续、只有允许的段落能跳过；
- 完整训练流程、手动两组的连点保护、快照恢复不消耗离线时间；
- 本机存储与静默上传、断网重试、上一版本待上传数据和最初本机历史的接续；
- 接口：幂等写入、冲突、补记、撤销、输入校验、同源检查（Node 原生 SQLite 运行真实表结构）；
- 页面：脚本可解析、元素齐全、界面文字不出现同步等字样。

浏览器操作只用 ego-browser，通过 `file://` 或 Pages 分支预览，不启动本地服务器。

| 入口 | 行为 |
| --- | --- |
| `?debugMs=100` | 100 毫秒代表 1 秒，静音，隔离的本机存储，不请求接口 |
| `?test=1` | 标准时长带声音，隔离的本机存储，不请求接口 |
| `file://` | 隔离预览；浏览器无法从本地文件读取口令素材，因此静音 |
| 分支预览无参数 | 标准规则，连接预览 D1 |
| 正式域名无参数 | 正式 D1；自动验收不写训练记录 |

`window.__rehabTimer.state()` 只读暴露当前屏幕、声音状态和训练位置。
在 `file://?test=1` 下，`window.__rehabTimer.loadVoice(arrayBuffer)` 可以把 `voice.wav` 交给页面，用来在浏览器里验证合成与播放。
自动化只能证明合成和播放管线在运行，真机外放与锁屏播放需要在目标 iPhone 上确认。

## 记录与接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/records` | 全部完成记录，含撤销标记 |
| `POST /api/records` | 写入一条记录 `{ record }`，按 `(program, id)` 幂等；同标识不同内容返回 409 |
| `POST /api/records/revoke` | 撤销一条记录 `{ program, id }`，原记录保留 |

旧接口 `/api/state`、`/api/operation` 返回 410，提示缓存的旧页面刷新。
不需要口令、登录或会话密钥；服务端只检查同源、输入格式和日期。
原有 `records` 与 `calendar_adjustments` 表直接沿用，会话等旧表保留只读，不删除。

## Cloudflare 部署

继续使用已有的直接上传 Pages 项目 `rehab-timer`，不使用 Git 自动部署。
`wrangler.jsonc` 保存生产与预览两套 D1 绑定和 `APP_ENV`。
不再需要 `SESSION_SECRET`；已有的 secret 可以保留，也可以之后删除。
表结构没有变化，不需要执行新的迁移。

预览：

```sh
npm run build:publish
npx wrangler pages deploy .publish --project-name rehab-timer --branch redesign-voice-coach
```

生产遵循 PR 流程，验证并合并后从合并提交构建：

```sh
npm run build:publish
npx wrangler pages deploy .publish --project-name rehab-timer --branch main
```

PR 合并不等于部署完成；发布后核对正式域名页面、`/api/records` 和 `audio/voice.wav`。
回滚页面不要删除数据库或记录。
