# 口令素材

`voice.wav` 是全部口令拼成的一个文件（22.05 kHz、单声道、16-bit PCM），`voice.json` 记录每句的起点和时长。
页面只下载这一个文件，开始每一项前在浏览器里用 OfflineAudioContext 按排程把口令和提示音拼成一条连续音轨，交给唯一的 `<audio>` 元素播放。
提示音（升调、降调、嗒、和弦）在合成时即时生成，不需要素材文件。
构建把 `voice.json` 内联进页面，排程使用实测时长；`voice.json` 的 `version` 也用于让浏览器缓存失效。

## 当前素材

当前使用 macOS 自带的 Tingting（婷婷）语音，用 `say` 生成。
macOS 系统语音的输出只允许个人、非商业使用；这个计时器只供个人康复使用，使用者已确认继续用婷婷。
如果将来要用于其他场合，需要换成有商用许可的语音合成，或者真人录音（每句一个文件，文件名就是口令键名）。

## 重新生成

口令文本的唯一来源是 `src/core.js` 的 `VOICE_TEXT`。改了文本、换了音色或拿到录音后：

```sh
node scripts/generate-voice.mjs                          # macOS say，默认 Tingting
node scripts/generate-voice.mjs --voice Tingting --rate 180
node scripts/generate-voice.mjs --dir path/to/recordings # 每句 <键名>.wav|.m4a|.mp3|.aiff
npm run build
npm test
```

需要 `ffmpeg`。每句会去掉首尾静音、加 90 Hz 高通和 3 kHz 轻微提升（适配手机外放），响度统一到 −16 LUFS、峰值 −1.5 dBTP。
测试会检查每个口令都有素材、长度合理、“三二一”能放进一秒，以及所有口令在排程中不重叠、不跨过动作边界。

## 验收

自动测试只证明排程和文件正确，不证明人耳能听清。
真机验收：iPhone 外放放在 1.5 米外，开着电视，不熟悉项目的人能准确复述每句口令；锁屏后音轨继续播放。
