"""Build background-safe stage tracks from the actual inline schedule and local WAVs.
Requires Node.js, Python 3 and ffmpeg; no network or TTS generation.
Run: python3 scripts/generate-stage-tracks.py
"""
import json
import pathlib
import subprocess
import tempfile
import wave

root = pathlib.Path(__file__).resolve().parents[1]
script = """
const fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync('index.html','utf8');
vm.runInThisContext(html.match(/<script id="rehab-core">([\\s\\S]*?)<\\/script>/)[1]);
console.log(JSON.stringify(RehabCore.stages.map((_,i)=>RehabCore.stageTrack(i))));
"""
tracks = json.loads(subprocess.check_output(['node', '-e', script], cwd=root))
rate = 44100
for i, track in enumerate(tracks, 1):
    pcm = bytearray(round(track['duration'] * rate) * 2)
    occupied = []
    for sound in track['sounds']:
        data = subprocess.check_output(['ffmpeg', '-v', 'error', '-i',
            str(root / 'audio' / (sound['key'] + '.wav')), '-f', 's16le',
            '-ar', str(rate), '-ac', '1', 'pipe:1'])
        start = round(sound['at'] * rate) * 2
        end = start + len(data)
        assert start >= 0 and end <= len(pcm)
        assert all(end <= a or start >= b for a, b in occupied), 'overlapping cues'
        occupied.append((start, end))
        pcm[start:end] = data
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        wav = pathlib.Path(tmp) / 'stage.wav'
        with wave.open(str(wav), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            output.writeframes(pcm)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav),
                        '-codec:a', 'libmp3lame', '-b:a', '48k', '-map_metadata', '-1',
                        str(root / 'audio' / f'stage-{i}.mp3')], check=True)
    print(f"stage-{i}.mp3: {track['duration']:.3f}s, {len(track['sounds'])} cues")
