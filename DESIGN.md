---
name: 康复训练计时器
description: A voice-first rehab coach. Light screens for choosing and waiting, a dark full-screen pool for timed training.
colors:
  tile: "#eef6f5"
  card: "#ffffff"
  ink: "#08283c"
  muted: "#4a6670"
  line: "#d3e6e4"
  pool: "#087e8b"
  night: "#062033"
  signal: "#f36a32"
  work: "#f07038"
  work-deep: "#c94d1c"
  rest: "#1c9ba6"
  rest-deep: "#0b6f7a"
  danger: "#a32d20"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.55
  phase:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "clamp(2rem, 9vw, 3rem)"
    fontWeight: 700
  count:
    fontFamily: "DIN Condensed, Avenir Next Condensed, Bahnschrift, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(9rem, 46vw, 15rem)"
    fontWeight: 700
    lineHeight: 1
rounded:
  control: "12px"
  card: "20px"
  primary: "16px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ink}"
    rounded: "{rounded.primary}"
    height: "56px"
  pause:
    backgroundColor: "#ffffff"
    textColor: "{colors.night}"
    size: "84px"
    shape: circle
---

# Design System: 康复训练计时器

## 视觉方向

延续水疗泳池的配色：浅水蓝瓷砖底、深夜蓝、安全橙。
两种模式用明暗区分：浅色界面用于选择和等待你操作，深色全屏用于计时进行中。
训练中屏幕从下往上注满“水”，水位随这一段剩余时间平稳下降：橙色是用力，青色是放松和休息，蓝灰是准备与就位。
水位只降不跳，静力保持时不使用脉动、缩放或旋转，避免被理解成反复发力。
不使用成就卡片、励志口号或游戏化反馈。

## 信息层级

越接近训练，信息越少。
首页只回答“今天练哪一套”；训练准备列出器材和动作；训练中只剩阶段、秒数、本组进度和暂停。
训练中的阶段词和秒数是全屏最大的两样东西，手机放在 1.5 米外也能读。
“这一段还剩几秒”是主读数；“第几组第几次”和进度点是次要信息，放在数字下方。
阶段始终有文字，颜色只是加强，不单独承载含义。

## 屏幕

### 首页

日期、“今天练哪一套？”、本周七天圆点和次数。
两张计划卡：计划名、预计时长、五个动作的小图示，以及“开始”或带进度的“继续”。
底部只有“训练 / 记录”两个标签。
同步、声音、设置都不在首页出现。

### 训练准备

顶部返回和计划名；“先准备好这些”器材标签；五个动作的图示、完整名称、剂量与器材。
组间休息用四段选择，一眼看到当前值。
声音开关和“试听”放在开始按钮上方。
底部固定“开始训练”；本套计划有未练完的进度时，第一下变成“确认从头开始”。

### 训练进行中（深色全屏）

顶部：左“×”（先暂停再询问是否结束）、中间“2 / 5 · 动作短名”、右声音开关。
中间：动作图示、阶段词、秒数（不足一分钟显示秒，否则 m:ss）、组次说明、进度点（两组时上下两行，非当前组变淡）。
底部：大圆暂停键；只有可跳过的段落在它上方出现“跳过准备 / 立即开始 / 跳过休息”。

### 已暂停与手动计次（深色，无水位）

已暂停：暂停标记、“已暂停”、所在位置、继续规则的一句说明、“继续”主按钮和“结束训练”。
手动计次：图示、“第 1 组”、“8–10 次 · 不计时”，主按钮写明“完成第 1 组”；完成后变为“第 1 组完成”和“开始第 2 组”。

### 换下一项（浅色）

从深色切到浅色，表示计时已停、在等你操作。
“第 N 项完成”、大图示、完整动作名、器材与剂量标签，底部“准备好了，开始”和就位倒数说明。
不显示静止的秒数。

### 完成

对勾、“今天的训练完成了”、计划与用时、本周圆点和“本周第 N 次”，一个“好”按钮。
不出现任何保存或同步状态。

### 记录

周一开头的月历，橙点是左腿抗阻训练，青点是双腿关节训练；今天描边，选中日期深色填充，未来日期不可点。
下方显示本周两套计划各自的次数，以及选中日期的每条记录、撤销和“补记一次完成”。
撤销和补记都是同一位置的二次确认，不弹窗。

## 组件与尺寸

主按钮宽度占满、至少 56px 高、橙底深字；危险操作用红色文字，不做成主按钮。
暂停键是 84px 白色圆形；“跳过”是描边胶囊按钮。
卡片 20px 圆角，控件 12px，主按钮 16px。
页面最大宽度 560px（训练页 640px），左右至少 18px 并考虑安全区。
底部固定区域考虑 `safe-area-inset-bottom`，内容可以滚动到按钮上方。
嵌套网格使用 `minmax(0, 1fr)`，长动作名自然换行。

## 动作示意图

每个动作一幅 64×40 的线稿，深色线条，器材用安全橙标出。
当前是占位线稿，姿势需按康复师的要求核对；拿到照片后替换为照片转成的线稿，保持同样的尺寸和配色规则。

## 字体

不加载网络字体。
正文和阶段词用系统中文字体；秒数用设备自带的窄体数字并开启等宽数字。

## 无障碍与动效

所有操作支持键盘并有可见焦点，触控目标不小于 44px。
屏幕切换时焦点交给当前主按钮；结束确认默认聚焦“继续训练”。
秒数不进入持续播报区域。
水位变化只用短的线性过渡；`prefers-reduced-motion` 下全部关闭。

## 验收

检查 320、375、390 px 和桌面宽度不横向溢出。
检查首页、准备、准备阶段、保持、放松、组间休息、轮间休息、节间休息、就位、暂停、换项、手动两组、完成、记录。
1.5 米外分辨用力与放松、读出秒数；真机外放听清每句口令。

本文件与 `src/styles.css` 是视觉规则的权威来源；训练剂量与流程以 `PRODUCT.md` 为准。
`index.html` 和 `.impeccable/design.json` 是生成文件，不手工修改。
