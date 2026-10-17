"""Build background-safe stage tracks from the actual inline schedule and local WAVs.
Requires Node.js, Python 3 and ffmpeg; no network or TTS generation.
Run: node scripts/build.mjs
     python3 scripts/generate-stage-tracks.py [--track stage-5]
     python3 scripts/generate-stage-tracks.py --rest-variants
"""
import argparse
import json
import pathlib
import subprocess
import tempfile
import wave

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--track', action='append', help='Regenerate only this named track; repeat to select several.')
parser.add_argument('--rest-variants', action='store_true', help='Generate only the 24 non-default group-rest variants (90/120/150 seconds).')
args = parser.parse_args()
if args.track and args.rest_variants:
    parser.error('--track and --rest-variants select different sets; use only one.')
script = """
const fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync('index.html','utf8');
const source = fs.readFileSync('src/core.js','utf8');
const inline = html.match(/<script id="rehab-core">([\\s\\S]*?)<\\/script>/)?.[1];
if (!inline || inline.trim() !== source.trim()) throw new Error('The shipped schedule is stale. Run node scripts/build.mjs first.');
vm.runInThisContext(inline);
const defaults = [
  ...RehabCore.stages.map((_,i)=>({name:`stage-${i+1}`,track:RehabCore.stageTrack(i)})),
  ...RehabCore.jointStages.slice(0,4).map((_,i)=>({name:`stage-joint-${i+1}`,track:RehabCore.stageTrack(i,RehabCore.JOINT_PROGRAM)}))
];
const variants = [90,120,150].flatMap(rest => [RehabCore.PROGRAM, RehabCore.JOINT_PROGRAM].flatMap(program =>
  Array.from({length:4}, (_,i) => ({
    name:`stage-${program === RehabCore.JOINT_PROGRAM ? 'joint-' : ''}${i+1}-rest-${rest}`,
    rest,
    track:RehabCore.stageTrack(i,program,rest)
  }))
));
for (const item of variants) {
  const base = defaults.find(base => base.name === item.name.replace(/-rest-\\d+$/, ''));
  if (Math.abs(item.track.duration - base.track.duration - (item.rest - 60)) > .001)
    throw new Error(`The core does not support ${item.rest}-second group rest yet: ${item.name}`);
}
console.log(JSON.stringify([...defaults,...variants]));
"""
tracks = json.loads(subprocess.check_output(['node', '-e', script], cwd=root))
if args.rest_variants:
    tracks = [item for item in tracks if 'rest' in item]
elif args.track:
    available = {item['name'] for item in tracks}
    unknown = set(args.track) - available
    if unknown:
        parser.error(f"Unknown track: {', '.join(sorted(unknown))}")
    tracks = [item for item in tracks if item['name'] in set(args.track)]
rate = 44100
cue_pcm = {}
for item in tracks:
    name, track = item['name'], item['track']
    pcm = bytearray(round(track['duration'] * rate) * 2)
    occupied = []
    for sound in track['sounds']:
        if sound['key'] not in cue_pcm:
            cue_pcm[sound['key']] = subprocess.check_output(['ffmpeg', '-v', 'error', '-i',
                str(root / 'audio' / (sound['key'] + '.wav')), '-f', 's16le',
                '-ar', str(rate), '-ac', '1', 'pipe:1'])
        data = cue_pcm[sound['key']]
        start = round(sound['at'] * rate) * 2
        end = start + len(data)
        assert start >= 0 and end <= len(pcm)
        assert all(end <= a or start >= b for a, b in occupied), 'overlapping cues'
        occupied.append((start, end))
        pcm[start:end] = data
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        wav = pathlib.Path(tmp) / 'stage.wav'
        mp3 = pathlib.Path(tmp) / 'stage.mp3'
        with wave.open(str(wav), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            output.writeframes(pcm)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav),
                        '-codec:a', 'libmp3lame', '-b:a', '48k', '-map_metadata', '-1',
                        str(mp3)], check=True)
        encoded_duration = float(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(mp3)
        ]))
        assert 0 <= encoded_duration - track['duration'] < .08, 'unexpected MP3 encoder duration'
        mp3.replace(root / 'audio' / f'{name}.mp3')
    print(f"{name}.mp3: {track['duration']:.3f}s, {len(track['sounds'])} cues")
