'use strict';
// Executes the shipped domain script from index.html, with the real measured voice durations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'Asia/Shanghai';

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const scripts = Object.fromEntries([...html.matchAll(/<script id="([^"]+)">([\s\S]*?)<\/script>/g)].map(m => [m[1], m[2]]));
const context = vm.createContext({ Date, Intl, Math, JSON });
vm.runInContext(scripts['rehab-voice'], context);
vm.runInContext(scripts['rehab-core'], context);
const C = context.RehabCore;
const voice = context.RehabVoice;
const plain = value => JSON.parse(JSON.stringify(value));
const A = C.PLAN_A, B = C.PLAN_B;
const ID = 'synthetic-session-0001';
const seconds = key => voice.clips[key][1] / 1000;
const kinds = (plan, rest) => C.PLANS[plan].items.flatMap((_, i) => plain(C.compile(plan, i, rest).segments)).filter(s => s.dose);

test('剂量与现行计划一致：原计划 104 段、默认 1520 秒；下肢 99 段；四档组休逐档加 2 分钟', () => {
  for (const [rest, total] of [[60, 1520], [90, 1640], [120, 1760], [150, 1880]]) {
    assert.equal(C.doseSeconds(A, rest), total);
    assert.equal(C.doseSegments(A, rest), 104);
    assert.equal(C.doseSegments(B, rest), 99);
    const a = kinds(A, rest), b = kinds(B, rest);
    assert.deepEqual(plain(a.filter(s => s.kind === 'group-rest').map(s => s.seconds)), [rest, rest, rest, rest]);
    assert.deepEqual(plain(b.filter(s => s.kind === 'group-rest').map(s => s.seconds)), [rest, rest, rest, rest]);
    assert.ok(a.filter(s => s.kind === 'rest').every(s => s.seconds === 5));
    assert.ok(b.filter(s => s.kind === 'rest').every(s => s.seconds === 7));
    assert.ok([...a, ...b].filter(s => s.kind === 'work').every(s => s.seconds === 15));
    assert.equal(a.filter(s => s.kind === 'work').length, 48);
    assert.equal(b.filter(s => s.kind === 'work').length, 48);
    assert.deepEqual(plain(a.filter(s => s.kind === 'round-rest').map(s => s.seconds)), [30, 30, 30]);
    assert.equal(a.filter(s => s.kind === 'tiptoe' || s.kind === 'stretch').length, 8);
    assert.deepEqual(plain(b.filter(s => s.kind === 'stage-rest').map(s => s.seconds)), [60, 60, 60, 60]);
    assert.equal(a.filter(s => s.kind === 'stage-rest').length, 0);
    assert.equal([...a, ...b].filter(s => s.kind === 'prep').length, 2);
  }
  assert.equal(C.PLANS[B].items[4].type, 'manual');
  assert.equal(C.PLANS[B].items[4].sets, 2);
});

test('每组第 6 次后没有短休；第 2 组结束直接进入下一阶段', () => {
  for (const plan of [A, B]) for (let i = 0; i < 4; i++) {
    const segs = plain(C.compile(plan, i, 60).segments);
    const lastWork = segs.filter(s => s.kind === 'work').at(-1);
    const after = segs[segs.indexOf(segs.find(s => s.start === lastWork.start)) + 1];
    assert.equal(after ? after.kind : undefined, plan === B ? 'stage-rest' : undefined);
    for (const set of [1, 2]) {
      const sixth = segs.find(s => s.kind === 'work' && s.set === set && s.rep === 6);
      const next = segs[segs.findIndex(s => s === sixth || (s.start === sixth.start && s.kind === 'work')) + 1];
      if (set === 1) assert.equal(next.kind, 'group-rest');
    }
  }
});

test('就位倒数只在第 2–5 项开头，不计入剂量，可以跳过', () => {
  for (const plan of [A, B]) C.PLANS[plan].items.forEach((item, i) => {
    if (item.type === 'manual') return;
    const first = C.compile(plan, i, 60).segments[0];
    assert.equal(first.kind, i === 0 ? 'prep' : 'settle');
    assert.equal(first.seconds, i === 0 ? 30 : 10);
    assert.equal(first.dose, i === 0);
    assert.equal(first.skippable, true);
  });
});

test('口令时序：放松在边界那一刻之后才开口；保持段除了三二一没有其他语音；口令互不重叠', () => {
  const dur = e => e.voice ? seconds(e.voice) : C.TONE_SECONDS[e.tone];
  for (const plan of [A, B]) for (const rest of C.GROUP_REST_OPTIONS) C.PLANS[plan].items.forEach((item, i) => {
    const c = C.compile(plan, i, rest);
    if (c.manual) return;
    const voices = c.events.filter(e => e.voice);
    for (let k = 1; k < voices.length; k++) assert.ok(voices[k].at >= voices[k - 1].at + dur(voices[k - 1]) - 1e-9, `${plan}/${i} ${voices[k - 1].voice} overlaps ${voices[k].voice}`);
    for (const seg of c.segments) {
      if (!C.WORK_KINDS.has(seg.kind)) continue;
      const inside = voices.filter(e => e.at > seg.start + 1.2 && e.at < seg.end);
      assert.deepEqual(plain(inside.map(e => e.voice)), ['n3', 'n2', 'n1'], `${plan}/${i} work at ${seg.start}`);
      assert.ok(inside.every(e => e.at + dur(e) <= seg.end + 1e-9), 'countdown finishes inside the hold');
      assert.ok(c.events.some(e => e.tone === 'rise' && Math.abs(e.at - seg.start) < 1e-9), 'rising tone marks the start');
    }
    for (const seg of c.segments.filter(s => ['rest', 'group-rest', 'round-rest', 'stage-rest'].includes(s.kind))) {
      assert.ok(c.events.some(e => e.tone === 'fall' && Math.abs(e.at - seg.start) < 1e-9), 'falling tone marks the end of work');
      const early = voices.filter(e => e.at < seg.start && e.at + dur(e) > seg.start);
      assert.deepEqual(plain(early), [], 'no cue straddles the start of a rest');
    }
    for (const seg of c.segments.filter(s => s.kind === 'rest')) {
      const next = voices.find(e => e.at >= seg.start + 0.4 && e.at < seg.end && e.voice.startsWith('rep-'));
      assert.ok(next && next.at + dur(next) <= seg.end - 1, `${plan}/${i} rep cue ends at least 1 s before work`);
    }
    const opener = c.segments[0];
    const intro = voices.find(e => e.voice.startsWith('intro-'));
    assert.ok(intro.at + dur(intro) <= opener.end - 3, `${plan}/${i} intro ends before the 3-2-1 ticks`);
  });
});

test('暂停后，保持段从这一次开头重来；休息从暂停处继续；只有准备、就位、组休、轮休能跳过', () => {
  const c = C.compile(A, 0, 60);
  const work = c.segments.find(s => s.kind === 'work' && s.set === 1 && s.rep === 3);
  assert.equal(C.resumePoint(c, work.start + 9.5), work.start);
  const rest = c.segments.find(s => s.kind === 'rest');
  assert.equal(C.resumePoint(c, rest.start + 2), rest.start + 2);
  const group = c.segments.find(s => s.kind === 'group-rest');
  assert.equal(C.skipTarget(c, group.start + 5), group.end);
  assert.equal(C.skipTarget(c, rest.start + 1), null);
  assert.equal(C.skipTarget(c, work.start + 1), null);
  assert.equal(C.skipTarget(c, 3), 30);
  const b = C.compile(B, 1, 60);
  const stage = b.segments.find(s => s.kind === 'stage-rest');
  assert.equal(C.skipTarget(b, stage.start + 1), null, '节间休息不可跳过');
  const calf = C.compile(A, 4, 60);
  const roundRest = calf.segments.find(s => s.kind === 'round-rest' && s.round === 2);
  assert.equal(C.skipTarget(calf, roundRest.start + 1), roundRest.end);
  assert.equal(calf.segments.find(s => s.start === roundRest.end).kind, 'tiptoe');
});

test('继续和跳过的音轨：先倒数 4 秒，再在边界响升调并说出动作', () => {
  const c = C.compile(A, 0, 60);
  const work = c.segments.find(s => s.kind === 'work' && s.set === 1 && s.rep === 4);
  const resume = plain(C.buildTrack(c, work.start, 'resume'));
  assert.equal(resume.lead, 4);
  assert.deepEqual(resume.events.slice(0, 4).map(e => e.voice || e.tone), ['resume', 'tick', 'tick', 'tick']);
  assert.ok(resume.events.some(e => e.tone === 'rise' && e.at === 4));
  assert.ok(resume.events.some(e => e.voice === 'start' && e.at > 4 && e.at < 4.7));
  const group = c.segments.find(s => s.kind === 'group-rest');
  const skip = plain(C.buildTrack(c, group.end, 'skip'));
  assert.equal(skip.events[0].voice, 'set-2');
  const calf = C.compile(A, 4, 60);
  const rr = calf.segments.find(s => s.kind === 'round-rest' && s.round === 1);
  assert.equal(plain(C.buildTrack(calf, rr.end, 'skip')).events[0].voice, 'round-2');
  const restResume = plain(C.buildTrack(c, group.start + 20, 'resume'));
  assert.equal(restResume.lead, C.RESUME_LEAD);
  assert.ok(Math.abs(restResume.duration - (c.duration - group.start - 20 + C.RESUME_LEAD)) < 1e-9);
  assert.throws(() => C.buildTrack(c, group.start + 1, 'skip'));
});

function runItem(session, step = 0.5) {
  const track = session.begin();
  assert.ok(track);
  let t = 0, result = null;
  while (!result && t < track.duration + 5) { t += step; result = session.advance(t, new Date(2026, 9, 31, 23, 59, 30)); }
  return result;
}

test('完整走完原计划：每项之后停在换项，必须明确开始；最后生成按本地日期的完成记录', () => {
  const s = new C.Session({ plan: A, id: ID });
  assert.equal(runItem(s), 'item-done');
  for (let i = 1; i < 4; i++) {
    assert.equal(s.state, 'between'); assert.equal(s.item, i);
    assert.equal(s.advance(9999), null, '换项时不会自己开始');
    assert.equal(runItem(s), 'item-done');
  }
  assert.equal(s.state, 'between');
  assert.equal(runItem(s), 'finished');
  const record = plain(s.completion);
  assert.equal(record.id, ID); assert.equal(record.program, A); assert.equal(record.source, 'training');
  assert.equal(record.date, '2026-10-31');
  assert.equal(s.snapshot(), null);
});

test('下肢计划第 5 项：两组都要明确开始，连点不会一次完成两组', () => {
  const s = new C.Session({ plan: B, id: ID, item: 4, state: 'between' });
  const first = s.begin();
  assert.equal(first.mode, 'manual');
  assert.equal(s.state, 'manual'); assert.equal(s.set, 1);
  assert.equal(s.completeManualSet(), 'manual-ready');
  assert.equal(s.completeManualSet(), null, '第二下点击不会完成第 2 组');
  assert.equal(s.state, 'manual-ready');
  const second = plain(s.begin());
  assert.ok(second.events.some(e => e.voice === 'manual-2'));
  assert.equal(s.set, 2);
  assert.equal(s.completeManualSet(new Date(2026, 9, 31, 8)), 'finished');
  assert.equal(s.completion.program, B);
});

test('快照和恢复：恢复永远不消耗离线时间，只回到暂停或换项', () => {
  const s = new C.Session({ plan: A, id: ID, groupRest: 120 });
  const track = s.begin();
  s.advance(track.lead + 30 + 15 + 5 + 7.5); // second hold, half way
  const snap = plain(s.snapshot());
  assert.equal(snap.state, 'paused');
  assert.equal(snap.at, 50, 'saved at the start of the interrupted hold');
  assert.equal(snap.groupRest, 120);
  const restored = C.Session.restore(snap);
  assert.equal(restored.state, 'paused'); assert.equal(restored.at, 50); assert.equal(restored.groupRest, 120);
  assert.equal(C.Session.restore({ ...snap, groupRest: 45 }), null);
  assert.equal(C.Session.restore({ ...snap, at: 99999 }), null);
  assert.equal(C.Session.restore({ ...snap, state: 'running' }), null);
  assert.equal(C.Session.restore({ ...snap, version: 2 }), null);
  const manual = C.Session.restore({ version: 3, plan: B, groupRest: 60, id: ID, item: 4, at: 0, state: 'manual', set: 2 });
  assert.equal(manual.state, 'manual-ready', '刷新后第 2 组要重新明确开始');
  const manualFirst = C.Session.restore({ version: 3, plan: B, groupRest: 60, id: ID, item: 4, at: 0, state: 'manual', set: 1 });
  assert.equal(manualFirst.state, 'between');
});

test('跳过休息只在允许的段落生效，并换成从下一组开始的音轨', () => {
  const s = new C.Session({ plan: A, id: ID });
  const track = s.begin();
  assert.equal(s.canSkip(1), true, '准备可以跳过');
  const skip = s.skip(1);
  assert.equal(skip.start, 30); assert.equal(skip.mode, 'skip');
  assert.equal(s.canSkip(skip.lead + 2), false, '保持中不能跳过');
  assert.ok(track.duration > skip.duration);
});

test('日历工具：周一开始，未来日期标记，跨月正确', () => {
  const cells = plain(C.monthCells(2026, 9, new Date(2026, 9, 31, 9)));
  assert.equal(cells.indexOf(null), 0);
  assert.equal(cells.filter(c => c === null).length, 3, '2026-10-01 是周四');
  assert.equal(cells.at(-1).date, '2026-10-31');
  assert.equal(cells.at(-1).today, true);
  assert.deepEqual(plain(C.weekDates(new Date(2026, 9, 31, 9))), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(C.validDate('2026-02-29'), false);
});

test('语音清单与素材一致：每个口令都有录音，且不过长', () => {
  assert.deepEqual(Object.keys(voice.clips).sort(), Object.keys(C.VOICE_TEXT).sort());
  for (const [key, [, ms]] of Object.entries(voice.clips)) {
    assert.ok(ms >= 150 && ms <= 6000, `${key} ${ms}ms`);
  }
  for (const key of ['n3', 'n2', 'n1']) assert.ok(seconds(key) <= 0.9, `${key} fits inside one second`);
  const wav = fs.readFileSync(path.join(__dirname, '../audio/voice.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), voice.rate);
  const lastClip = Math.max(...Object.values(voice.clips).map(([o, d]) => o + d));
  assert.ok((wav.length - 44) / 2 / voice.rate * 1000 >= lastClip, 'sprite covers every clip');
});
