# 本地短语音

这些 PCM WAV 是离线生成并随站发布的固定素材，不调用设备语音合成、外部 TTS、麦克风或录音权限。
页面复用一个 HTMLAudioElement 播放全部语音和提示音。
部署必须包含整个 `audio/` 目录，不能再只上传 `index.html`。

## 来源

- 模型：[MyShell MeloTTS](https://github.com/myshell-ai/MeloTTS)，中文单女声，MIT 许可，原文见 [LICENSE](LICENSE)。
- ONNX 转换与下载：[sherpa-onnx 的 vits-melo-tts-zh_en](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html#vits-melo-tts-zh-en-chinese-english-1-speaker)。
- 发布资源：<https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2>。
- 归档 SHA-256：`e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514`。
- `model.onnx` SHA-256：`bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d`。
- 推理工具：sherpa-onnx 1.13.7，CPU，speaker 0，speed 0.8，句末加句号。
- 处理：首尾保留 35ms，峰值归一化至 0.8，单声道 16-bit PCM。
- `beep.wav` 为本项目脚本生成的 880Hz、170ms 正弦提示音，不含第三方采样。

## 文本与再生成

12 条语音文本及对应文件名位于 `scripts/generate-cues.py`。
动作名、训练继续、休息、下一项等映射及素材时长位于 `index.html` 的 `RehabCore.cues` / `cueFor`。
所有训练事实和剂量仍以 [PRODUCT.md](../PRODUCT.md) 为准，短播报不替代动作详情。

仅维护素材时需要本地 Python 生成工具，浏览器与发布均不需要模型或这些开发依赖。
下载并校验上述模型后运行：

```sh
uv run --with sherpa-onnx==1.13.7 --with soundfile python scripts/generate-cues.py /path/to/vits-melo-tts-zh_en
node --test tests/rehab.test.cjs
```

重新生成可能改变模型采样与 WAV 秒长，必须用脚本输出更新 `RehabCore.cues` 的时长，并重新进行资源、播放与可懂度验收。
测试从真实 WAV 头和 PCM 内容核对秒长及非静音信号，而非只检查文件存在。
系统 playing/ended 和转写结果都不能代替目标手机的人耳听音。
