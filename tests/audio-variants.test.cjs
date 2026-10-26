'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script id="rehab-core">([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ Date });
vm.runInContext(source, context);
const core = context.RehabCore;
const audioFile = name => fs.readFileSync(path.join(root, 'audio', name));
const plain = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .000001, `${message}: ${actual} != ${expected}`);

// These byte-for-byte baselines retain the existing 60-second and fifth-stage recordings.
const originalHashes = {
  'stage-1.mp3': '6c7e7cd34fc72bdce4c56782fa42f48f51a32ffd49fc4b180d4e6662eb69bd99',
  'stage-2.mp3': '2cca34bbeba3f9df50b16c56b6ffdd4fb0a0f6b9f43ecc4594d0f2465742d061',
  'stage-3.mp3': '1bb5e2a399be6d697cdf0cc22f8bed9701d780e00f2ba3aafbcc3ccd4291a42a',
  'stage-4.mp3': '1473c67279608556a5e9f31abd9ab8af48fa3293ac17cb9e05b705fb3ca6af88',
  'stage-5.mp3': 'eab781078309f598dbdc1fb4ad4282eb54982488fb6ebb9e694c9682e3ecffc8',
  'stage-joint-1.mp3': '22d3654c5462a4fcbca8f56a4900509046db9331cce68cac1e33e052207c62f4',
  'stage-joint-2.mp3': 'c012955b2b96ea503f870ab50bff30b448f16953ce649a7231f4131e9ff31e61',
  'stage-joint-3.mp3': 'c012955b2b96ea503f870ab50bff30b448f16953ce649a7231f4131e9ff31e61',
  'stage-joint-4.mp3': 'c012955b2b96ea503f870ab50bff30b448f16953ce649a7231f4131e9ff31e61'
};

function wavDuration(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let byteRate, dataLength;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= buffer.length, 'complete WAV chunk');
    if (id === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data') dataLength = size;
    offset += 8 + size + (size % 2);
  }
  assert.ok(byteRate > 0 && dataLength > 0);
  return dataLength / byteRate;
}

// Parse each MPEG-1 Layer III frame, including the Info frame, without external tools.
function mp3Duration(buffer) {
  let offset = 0;
  if (buffer.toString('ascii', 0, 3) === 'ID3') {
    const size = buffer.subarray(6, 10).reduce((n, byte) => n * 128 + byte, 0);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  let frameCount = 0, declaredFrames;
  while (offset < buffer.length) {
    assert.ok(offset + 4 <= buffer.length, 'complete MP3 header');
    const header = buffer.readUInt32BE(offset);
    assert.equal(header >>> 21, 0x7ff, 'MP3 sync');
    assert.equal((header >>> 19) & 3, 3, 'MPEG-1');
    assert.equal((header >>> 17) & 3, 1, 'Layer III');
    assert.equal((header >>> 10) & 3, 0, '44.1 kHz sample rate');
    assert.equal((header >>> 6) & 3, 3, 'mono');
    const bitRate = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320][(header >>> 12) & 15];
    assert.ok(bitRate > 0, 'valid bitrate');
    const frameLength = Math.floor(144000 * bitRate / 44100) + ((header >>> 9) & 1);
    assert.ok(offset + frameLength <= buffer.length, 'complete MP3 frame');
    if (frameCount === 0) {
      const info = offset + 4 + 17 + (((header >>> 16) & 1) ? 0 : 2);
      assert.equal(buffer.toString('ascii', info, info + 4), 'Info');
      assert.equal(buffer.readUInt32BE(info + 4) & 1, 1, 'Info includes frame count');
      declaredFrames = buffer.readUInt32BE(info + 8);
    } else assert.equal(bitRate, 48, '48 kbps audio frame');
    offset += frameLength;
    frameCount++;
  }
  assert.equal(frameCount, declaredFrames + 1, 'all encoded frames are present');
  return declaredFrames * 1152 / 44100;
}

test('原始 9 条连续音轨字节不变，组间休息选择不改变第五项音轨', () => {
  for (const [file, hash] of Object.entries(originalHashes)) {
    assert.equal(createHash('sha256').update(audioFile(file)).digest('hex'), hash, file);
  }
  for (const program of [core.PROGRAM, core.JOINT_PROGRAM]) {
    for (const rest of [90, 120, 150]) {
      assert.deepEqual(plain(core.stageTrack(4, program, rest)), plain(core.stageTrack(4, program)), program);
    }
  }
});

for (const program of [core.PROGRAM, core.JOINT_PROGRAM]) {
  for (const stage of [0, 1, 2, 3]) {
    const name = `stage-${program === core.JOINT_PROGRAM ? 'joint-' : ''}${stage + 1}`;
    test(`${name} 的 60/90/120/150 秒连续音轨与实际排程匹配`, () => {
      const base = core.stageTrack(stage, program), schedule = core.planFor(program, 60);
      const groupRestIndex = schedule.find(item => item.stage === stage && item.kind === 'group-rest').index;
      const groupRestEntry = base.entries.find(entry => entry.index === groupRestIndex);
      const wavLengths = new Map(base.sounds.map(sound => [sound.key, wavDuration(audioFile(`${sound.key}.wav`))]));
      for (const rest of [60, 90, 120, 150]) {
        const variant = core.stageTrack(stage, program, rest), extra = rest - 60;
        const file = `${name}${rest === 60 ? '' : `-rest-${rest}`}.mp3`;
        const actualDuration = mp3Duration(audioFile(file));
        assert.ok(actualDuration >= variant.duration && actualDuration - variant.duration < .08, `${file}: encoded duration ${actualDuration} / schedule ${variant.duration}`);
        close(variant.duration - base.duration, extra, 'only the selected rest adds time');
        assert.equal(variant.entries.length, base.entries.length);
        variant.entries.forEach((entry, i) => {
          const previous = base.entries[i];
          assert.equal(entry.index, previous.index);
          close(entry.start, previous.start + (entry.index > groupRestIndex ? extra : 0), 'entry start');
          close(entry.end, previous.end + (entry.index >= groupRestIndex ? extra : 0), 'entry end');
          close(entry.end - entry.start, entry.index === groupRestIndex ? rest : previous.end - previous.start, 'entry duration');
        });
        assert.equal(variant.sounds.length, base.sounds.length);
        variant.sounds.forEach((sound, i) => {
          const previous = base.sounds[i];
          assert.equal(sound.key, previous.key, 'cue identity and order');
          close(sound.at, previous.at + (previous.at > groupRestEntry.start ? extra : 0), 'cue offset');
          assert.ok(sound.at >= 0, 'cue begins within track');
          const end = sound.at + wavLengths.get(sound.key);
          assert.ok(end <= variant.duration, 'cue ends within track');
          if (i + 1 < variant.sounds.length) assert.ok(end <= variant.sounds[i + 1].at + 1 / 44100, `${file}: cues must not overlap`);
        });
      }
    });
  }
}
