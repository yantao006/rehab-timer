"""Development-only: generate bundled WAV cues using the documented local MeloTTS model.
Usage: uv run --with sherpa-onnx==1.13.7 --with soundfile python scripts/generate-cues.py MODEL_DIR
"""
import json
import math
import pathlib
import sys
import wave
import numpy as np
import sherpa_onnx

model = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parents[1] / "audio"
out.mkdir(exist_ok=True)
config = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(model / "model.onnx"), lexicon=str(model / "lexicon.txt"),
            tokens=str(model / "tokens.txt"), dict_dir=str(model / "dict")),
        num_threads=2, provider="cpu"))
tts = sherpa_onnx.OfflineTts(config)
cues = {"prepare": "准备", "rest": "休息", "continue": "训练继续",
        "hip-extension": "大腿后伸", "leg-raise": "直抬腿", "hip-adduction": "髋内收",
        "ankle-inversion": "踝内翻", "calf-raise": "踮脚", "stretch": "拉伸",
        "next": "下一项", "complete": "训练完成", "test": "声音测试"}
manifest = {}
for key, text in [*cues.items(), ("beep", "")]:
    if key == "beep":
        rate = 22050
        t = np.arange(round(rate * .17)) / rate
        envelope = np.minimum(t / .008, 1) * np.maximum(0, 1 - t / .17)
        samples = .5 * np.sin(2 * math.pi * 880 * t) * envelope
    else:
        audio = tts.generate(text + "。", sid=0, speed=.8)
        rate = audio.sample_rate
        samples = np.array(audio.samples)
        # Trim model padding, retaining 35 ms around audible content; normalize without clipping.
        active = np.where(np.abs(samples) > .008)[0]
        if not len(active):
            raise RuntimeError(f"Silent output: {key}")
        pad = round(rate * .035)
        samples = samples[max(0, active[0]-pad):min(len(samples), active[-1]+pad+1)]
        samples = samples * (.8 / max(abs(samples)))
    # Standard PCM WAV: universally decodable, no encoder delay or external decoder dependency.
    pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2')
    with wave.open(str(out / f"{key}.wav"), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    manifest[key] = {"text": text, "durationMs": round(len(pcm) / rate * 1000)}
print(json.dumps(manifest, ensure_ascii=False, indent=2))
