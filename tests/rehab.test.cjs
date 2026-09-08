#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
process.env.TZ = 'Asia/Shanghai';
const html = fs.readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const script of scripts) new vm.Script(script); // Parse the shipped UI as well as the domain script.
const context = vm.createContext({ Date });
vm.runInContext(scripts[0], context);
const { Engine, Store, MediaChannel, cues, cueFor, plan, stages, localDate, validDate, monthCells, weeklyCount } = context.RehabCore;
const plain = value => JSON.parse(JSON.stringify(value));
const ID = 'synthetic-session-0001';
const FINISH = new Date(2026, 8, 7, 0, 1);
const normalPrefix = 'rehab-timer:v1';
class MemoryStorage {
  constructor() { this.data = new Map(); this.failRead = false; this.failWrite = false; this.failRemove = false; }
  get length() { if (this.failRead) throw new Error('SecurityError'); return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { if (this.failRead) throw new Error('SecurityError'); return this.data.get(k) ?? null; }
  setItem(k, v) { if (this.failWrite) throw new Error('QuotaExceededError'); this.data.set(k, String(v)); }
  removeItem(k) { if (this.failRemove) throw new Error('SecurityError'); this.data.delete(k); }
}
function running(unit = 1000) {
  const e = new Engine(unit); assert.equal(e.start(ID), true); assert.equal(e.arm(0), true); return e;
}
function exhaust(e, date = FINISH) {
  // Frequent heartbeats advance actual elapsed time to one boundary, not callback counts.
  let result;
  while (e.state === 'running') {
    const now = Math.min(e.deadline, e.lastNow + Math.min(200, e.unitMs));
    result = e.tick(now, date);
    if (result) break;
  }
  return result;
}
function finishAll(e = running()) {
  let time = 0, waits = 0;
  const seen = [];
  for (let guard = 0; guard < 150 && e.state !== 'finished'; guard++) {
    seen.push(plain(e.interval));
    time = e.deadline;
    const result = exhaust(e);
    if (result === 'ready') { waits++; e.continue(); e.arm(time); }
    if (result === 'cue') e.arm(time);
  }
  assert.equal(e.state, 'finished');
  return { e, seen, waits };
}
function seekGroupRest(e = running()) {
  while (e.interval.kind !== 'group-rest') {
    const end = e.deadline;
    if (exhaust(e) === 'cue') e.arm(end);
  }
  return e;
}

test('五个完整身份、左侧与器材保留', () => {
  assert.deepEqual(plain(stages.map(s => [s.name, s.equipment])), [
    ['俯卧左大腿屈膝后伸抗阻静力训练', '1 kg'], ['左侧直抬腿', '1 kg'],
    ['左髋内收抗阻静力训练', '弹力带 15 磅'], ['左踝内翻训练', '弹力带 15 磅'],
    ['左小腿踮脚静力训练 → 左小腿拉伸', '']
  ]);
});
test('实际完整执行：101 段，1430 秒，四次手动项间等待', () => {
  const { seen, waits } = finishAll();
  assert.equal(seen.length, 101); assert.equal(waits, 4);
  assert.equal(seen.reduce((sum, p) => sum + p.seconds, 0), 1430);
  assert.deepEqual(seen[0], { stage: 0, kind: 'prep', seconds: 30, index: 0 });
  assert.equal(seen.filter(p => p.kind === 'prep').length, 1);
});
for (let stage = 0; stage < 4; stage++) test(`第 ${stage+1} 项：12 次训练、10 次短休、一次组休与正确末次语义`, () => {
  const { seen } = finishAll();
  const actual = seen.filter(p => p.stage === stage && p.kind !== 'prep');
  const expected = [];
  for (let group = 1; group <= 2; group++) {
    for (let rep = 1; rep <= 6; rep++) {
      expected.push([group,rep,'work',15]);
      if (rep < 6) expected.push([group,rep,'rest',5]);
    }
    if (group === 1) expected.push([1,6,'group-rest',60]);
  }
  assert.deepEqual(actual.map(p => [p.group,p.rep,p.kind,p.seconds]),expected);
});
test('第五项四轮踮脚/拉伸自动交替，无休息或手动等待插入', () => {
  const { seen } = finishAll();
  assert.deepEqual(seen.filter(p => p.stage === 4).map(p => [p.round,p.kind,p.action,p.seconds]), [
    [1,'work','左小腿踮脚静力训练',30], [1,'stretch','左小腿拉伸',30],
    [2,'work','左小腿踮脚静力训练',30], [2,'stretch','左小腿拉伸',30],
    [3,'work','左小腿踮脚静力训练',30], [3,'stretch','左小腿拉伸',30],
    [4,'work','左小腿踮脚静力训练',30], [4,'stretch','左小腿拉伸',30]
  ]);
});
test('四个项间边界无限等待；只有显式继续才能开始下一项', () => {
  const e = running(); let waits = 0;
  while (e.state !== 'finished') {
    const end = e.deadline;
    const result = exhaust(e);
    if (result === 'cue') e.arm(end);
    if (result === 'ready') {
      waits++;
      const s = plain(e.snapshot());
      e.tick(end + 86400000); e.tick(end + 864000000);
      assert.deepEqual(plain(e.snapshot()),s);
      assert.equal(e.arm(end),false);
      assert.equal(e.continue(),true); assert.equal(e.continue(),false);
      assert.equal(e.arm(end),true);
    }
  }
  assert.equal(waits,4);
});
test('组休跳过仅抵达同项第二组第一次，不完成当前项', () => {
  const e = seekGroupRest(); const stage = e.interval.stage;
  assert.equal(e.skip('group-rest',e.lastNow+100),true);
  assert.equal(e.state,'cue'); assert.equal(e.interval.stage,stage);
  assert.equal(e.interval.group,2); assert.equal(e.interval.rep,1);
  assert.equal(e.interval.kind,'work'); assert.equal(e.remaining,15000);
  assert.equal(e.completion,null); assert.equal(e.skip('group-rest',e.lastNow),false);
});
test('训练/短休不允许任意跳段；旧组休点击越过边界不会跳工作', () => {
  const e = seekGroupRest();
  while (e.deadline-e.lastNow > 200) e.tick(e.lastNow+200);
  assert.equal(e.skip('group-rest',e.deadline+10),false);
  assert.equal(e.interval.kind,'work'); assert.equal(e.interval.group,2); assert.equal(e.interval.rep,1);
  assert.equal(e.skip('work',e.lastNow),false); assert.equal(e.skip('prep',e.lastNow),false);
  exhaust(e); assert.equal(e.interval.kind,'rest'); assert.equal(e.skip('rest',e.lastNow),false);
});
test('初始准备可跳；第一次工作仍需语音零点 arm', () => {
  const e = running(); assert.equal(e.skip('prep',500),true);
  assert.equal(e.state,'cue'); assert.equal(e.index,1); assert.equal(e.remaining,15000);
  e.tick(999999); assert.equal(e.index,1); assert.equal(e.remaining,15000);
});
test('暂停保留部分秒；暂停或关闭期间不消耗时间，继续不新增15秒', () => {
  const e = running(); e.tick(1000); e.tick(2000); e.pause(2345);
  assert.equal(e.remaining,27655);
  e.tick(86400000); assert.equal(e.remaining,27655);
  e.continue(); e.arm(90000000); e.tick(90000100);
  assert.equal(e.remaining,27555);
});
test('语音准备期间暂停、重复开始及陈旧 tick 不推进', () => {
  const e = new Engine(); e.start(ID); e.pause(0);
  assert.equal(e.arm(5000),false); assert.equal(e.start(ID),false);
  assert.equal(e.tick(999999),null); assert.equal(e.index,0);
  e.continue(); assert.equal(e.arm(6000),true);
});
test('正常延迟回调按绝对边界而非回调次数，下一段不漂移', () => {
  const e = running(); exhaust(e); e.arm(30000);
  while (e.lastNow < 44800) e.tick(Math.min(44800,e.lastNow+200));
  assert.equal(e.tick(45123),'interval'); assert.equal(e.interval.kind,'rest');
  assert.equal(e.deadline,50000); assert.equal(e.remaining,4877);
  e.tick(45123); assert.equal(e.remaining,4877);
});
test('长回调延迟、后台冻结与倒退时钟安全暂停，不补做或自动打卡', () => {
  for (const time of [1000000,-100]) {
    const e = running(); e.tick(1000);
    const remaining = e.remaining;
    assert.equal(e.tick(time),'late'); assert.equal(e.state,'paused');
    assert.equal(e.index,0); assert.equal(e.remaining,remaining); assert.equal(e.completion,null);
  }
});
test('加速短段也不能因一次延迟跳过未做段', () => {
  const e = running(20); exhaust(e); e.arm(600);
  while (e.lastNow<880) e.tick(Math.min(880,e.lastNow+20));
  assert.equal(e.tick(1200),'late'); assert.equal(e.index,1); assert.equal(e.completion,null);
});
test('最后拉伸必须全部完成，最后一秒延迟也不能假完成', () => {
  const e = running();
  while (e.index < 100) {
    const end=e.deadline, result=exhaust(e);
    if (result==='ready') e.continue();
    if (e.state==='cue') e.arm(end);
  }
  assert.equal(e.completion,null);
  while (e.remaining > 1000) e.tick(e.lastNow+200);
  assert.equal(e.tick(e.lastNow+100000),'late'); assert.equal(e.completion,null);
  e.continue(); e.arm(2000000); assert.equal(exhaust(e),'finished');
  assert.equal(e.completion.id,ID);
});
test('结束/重置仅清当前进度，不生成完整记录或删除已有历史', () => {
  const memory = new MemoryStorage(); const store = new Store(memory,normalPrefix);
  const complete = finishAll().e.completion; store.complete(complete);
  const e = running(); e.tick(1000); store.saveProgress(e.snapshot());
  e.reset(); store.saveProgress(null); e.tick(9999999);
  assert.equal(e.state,'idle'); assert.equal(e.completion,null); assert.equal(store.loadProgress(),null);
  assert.equal(store.history().length,1);
});
test('按最后完成时的本地日期记录，跨午夜不按开始日；不是 UTC 切片', () => {
  const e = finishAll().e;
  assert.equal(e.completion.date,'2026-09-07');
  assert.equal(e.completion.finishedAt,'2026-09-06T16:01:00.000Z');
  assert.equal(localDate(new Date(2026,8,6,23,59)),'2026-09-06');
  assert.equal(localDate(new Date(2026,8,7,0,1)),'2026-09-07');
  const record = plain(e.completion); e.tick(999999999,new Date(2026,8,8));
  assert.deepEqual(plain(e.completion),record);
});
test('每个会话原子去重；重复回调/重试/恢复/同一会话翌日回写均不增加', () => {
  const memory = new MemoryStorage(); const a = new Store(memory,normalPrefix); const b = new Store(memory,normalPrefix);
  const record = finishAll().e.completion;
  assert.equal(a.complete(record),true); assert.equal(a.complete(record),true);
  assert.equal(b.complete({...record,date:'2026-09-08'}),true);
  assert.equal(a.history().length,1); assert.equal(a.history()[0].date,'2026-09-07');
  a.complete({...record,id:'synthetic-session-0002'});
  assert.equal(b.history().length,2);
  assert.equal(monthCells(2026,8,b.history(),FINISH).filter(c=>c?.complete).length,1);
  assert.equal(weeklyCount(b.history(),FINISH),2);
});
test('空存储、刷新后恢复暂停、跨天不消耗离线时间；ready仍须确认', () => {
  const memory = new MemoryStorage(); const store = new Store(memory,normalPrefix);
  assert.equal(store.loadProgress(),null); const e = running(); e.tick(999); store.saveProgress(e.snapshot());
  const restored = new Engine(); assert.equal(restored.restore(new Store(memory,normalPrefix).loadProgress()),true);
  assert.equal(restored.state,'paused'); restored.tick(10000000000);
  assert.equal(restored.remaining,29001); assert.equal(restored.completion,null);
  while (e.state!=='ready') { const end=e.deadline; if (exhaust(e)==='cue') e.arm(end); }
  const next = new Engine(); assert.equal(next.restore(e.snapshot()),true); assert.equal(next.state,'ready');
  next.tick(9999999999); assert.equal(next.state,'ready'); assert.equal(next.interval.stage,1);
});
test('完成写入中断：终态进度重放后仍一次记录并保留原完成日', () => {
  const memory = new MemoryStorage(); const store = new Store(memory,normalPrefix);
  const e = finishAll().e; store.saveProgress(e.snapshot());
  memory.failWrite=true; assert.equal(store.complete(e.completion),false); memory.failWrite=false;
  const restored = new Engine(); assert.equal(restored.restore(store.loadProgress()),true);
  assert.equal(restored.state,'finished'); store.complete(restored.completion);
  // Simulate a crash before progress cleanup and another reload.
  const again = new Engine(); again.restore(store.loadProgress()); store.complete(again.completion); store.saveProgress(null);
  assert.equal(store.history().length,1); assert.equal(store.history()[0].date,'2026-09-07');
});
test('格式损坏、版本不符、越界/伪终态等进度不恢复且不损坏历史', () => {
  const base = running().snapshot();
  for (const patch of [{version:2},{program:'old'},{unitMs:100},{index:101},{index:-1},{remaining:-1},{remaining:Infinity},{remaining:30001},{state:'unknown'},{state:'finished'},{state:'ready'},{id:'bad'},{completion:{}}]) {
    assert.equal(new Engine().restore({...base,...patch}),false,JSON.stringify(patch));
  }
  assert.equal(new Engine().restore(null),false);
  const memory = new MemoryStorage(), warnings=[]; const store = new Store(memory,normalPrefix,s=>warnings.push(s));
  memory.setItem(`${normalPrefix}:progress`,'{broken'); assert.equal(store.loadProgress(),null); assert.equal(warnings.length,1);
  memory.setItem(`${normalPrefix}:done:broken-key`,'{bad'); assert.equal(store.history().length,0);
  assert.equal(memory.getItem(`${normalPrefix}:done:broken-key`),'{bad');
});
test('禁用存储和配额失败诚实返回失败，不抛异常，不伪造保存成功', () => {
  const warnings=[]; const absent = new Store(null,normalPrefix,s=>warnings.push(s));
  assert.equal(absent.loadProgress(),null); assert.equal(absent.history().length,0);
  assert.equal(absent.saveProgress(running().snapshot()),false); assert.equal(absent.complete(finishAll().e.completion),false);
  const memory = new MemoryStorage(); memory.failWrite=true;
  const store = new Store(memory,normalPrefix,s=>warnings.push(s));
  assert.equal(store.saveProgress(running().snapshot()),false); assert.equal(store.complete(finishAll().e.completion),false);
  assert.equal(store.history().length,0); assert.ok(warnings.length>=6);
  memory.failRead=true; assert.equal(store.history().length,0); assert.equal(store.loadProgress(),null);
});
test('清除当前进度失败不声称成功；坏的同ID历史不会被覆盖', () => {
  const memory = new MemoryStorage(), warnings=[]; const store = new Store(memory,normalPrefix,s=>warnings.push(s));
  store.saveProgress(running().snapshot()); memory.failRemove=true; assert.equal(store.saveProgress(null),false);
  assert.ok(store.loadProgress()); const r=finishAll().e.completion;
  memory.setItem(`${normalPrefix}:done:${r.id}`,'not json'); assert.equal(store.complete(r),false);
  assert.equal(memory.getItem(`${normalPrefix}:done:${r.id}`),'not json');
});
test('加速进度和历史与正式存储隔离，测试清理不会清正式数据', () => {
  const memory = new MemoryStorage(); const normal = new Store(memory,normalPrefix);
  const testStore = new Store(memory,'rehab-timer:test:v1:100');
  normal.complete(finishAll().e.completion); normal.saveProgress(running().snapshot());
  const baseline = [...memory.data];
  const e = finishAll(running(100)).e; testStore.complete(e.completion); testStore.saveProgress(e.snapshot()); testStore.saveProgress(null);
  for (const [k,v] of baseline) assert.equal(memory.getItem(k),v);
  assert.equal(testStore.history().length,1); assert.equal(normal.history().length,1);
});
test('公历闰年/月首周一偏移/跨年/今天与完成并存/周一至周日统计', () => {
  assert.equal(validDate('2024-02-29'),true); assert.equal(validDate('2026-02-29'),false);
  assert.equal(validDate('2026-13-01'),false); assert.equal(validDate('2026-02-30'),false);
  const cells=monthCells(2024,1,[],new Date(2024,1,29));
  assert.equal(cells.filter(Boolean).length,29); assert.equal(cells.findIndex(Boolean),3);
  assert.equal(cells.find(c=>c?.today).day,29);
  const records = ['2025-12-28','2025-12-29','2025-12-31','2026-01-04','2026-01-05'].map((date,i)=>({date,id:`date-test-${i}`}));
  assert.equal(weeklyCount(records,new Date(2026,0,1)),3);
  assert.equal(weeklyCount(records,new Date(2026,0,5)),1);
  const today=monthCells(2026,0,records,new Date(2026,0,4)).find(c=>c?.today);
  assert.equal(today.complete,true);
  assert.equal(monthCells(2026,12,[],new Date()).find(Boolean).date,'2027-01-01');
});
function mediaFixture(supported=true) {
  let now=0, next=0, recovered=0; const timers=new Map(), warnings=[], events=[], requests=[];
  const media={currentTime:0, load() { this.currentTime=0; }, pause() {}, play() {
    requests.push({src:this.src, ended:this.onended, playing:this.onplaying, error:this.onerror}); return Promise.resolve();
  }};
  const channel = new MediaChannel({media:supported?media:null, now:()=>now,
    setTimer(fn,ms) { const id=++next; timers.set(id,{fn,at:now+ms}); return id; }, clearTimer:id=>timers.delete(id),
    warn:m=>warnings.push(m), recover:()=>recovered++, log:(type,detail)=>events.push({type,...detail})});
  return {channel,media,requests,warnings,events,timers,get recovered(){return recovered;},
    advance(ms) { now+=ms; for(const [id,t] of [...timers]) if(t.at<=now) {timers.delete(id);t.fn();} },
    end(key) { media.onplaying(); this.advance(cues[key][1]); media.currentTime=cues[key][1]/1000; media.onended(); }
  };
}
test('所有播报映射短且不复述组次/剩余秒；恢复休息仍仅休息', () => {
  for (const item of plan) for (const full of [true,false]) {
    const key=cueFor(item,full); assert.ok(cues[key]); assert.ok(cues[key][0].length<=4);
    assert.doesNotMatch(cues[key][0],/[0-9秒组次轮]/);
    if (['rest','group-rest'].includes(item.kind)) assert.equal(cues[key][0],'休息');
  }
  assert.equal(cues[cueFor(plan[1],true)][0],'大腿后伸');
  assert.equal(cues[cueFor(plan[5])][0],'训练继续');
  assert.equal(cues[cueFor(plan[93])][0],'踮脚');
  assert.equal(cues[cueFor(plan[94])][0],'拉伸');
});
test('随站 PCM 语音是真实非静音资源，时长与排程清单逐一匹配', () => {
  for(const [key,[,duration]] of Object.entries(cues)) {
    const wav=fs.readFileSync(new URL(`../audio/${key}.wav`, `file://${__filename}`));
    assert.equal(wav.toString('ascii',0,4),'RIFF'); assert.equal(wav.toString('ascii',8,12),'WAVE');
    assert.equal(wav.readUInt16LE(20),1); assert.equal(wav.readUInt16LE(22),1); assert.equal(wav.readUInt16LE(34),16);
    const data=wav.subarray(44), rate=wav.readUInt32LE(24);
    assert.equal(Math.round(data.length/2/rate*1000),duration);
    let power=0; for(let i=0;i<data.length;i+=2) power+=(data.readInt16LE(i)/32768)**2;
    assert.ok(Math.sqrt(power/(data.length/2))>.015,`${key} must contain a real signal`);
    assert.ok(duration<1200,`${key} fits well inside a 5 second rest`);
  }
});
test('媒体播放立即调用 play，不先 await；完成须 playing + 时长 + 播放位置', async () => {
  const f=mediaFixture(); let resolved=false;
  const promise=f.channel.play('prepare').then(()=>resolved=true);
  assert.equal(f.requests.length,1); assert.equal(f.requests[0].src,'audio/prepare.wav');
  assert.equal(resolved,false); f.end('prepare'); await promise;
  assert.equal(f.channel.job,null); assert.equal(f.recovered,1); assert.equal(f.warnings.length,0);
  assert.deepEqual(f.events.map(e=>e.type),['media-request','media-playing','media-ended']);
});
test('即时假结束/只有play promise成功不是播音成功；无进度如实报错', async () => {
  for(const sawPlaying of [true,false]) {
    const f=mediaFixture(); const promise=f.channel.play('prepare');
    if(sawPlaying) f.media.onplaying();
    f.media.onended(); assert.equal(await promise,'unavailable');
    assert.equal(f.channel.failed,true); assert.equal(f.recovered,0); assert.equal(f.warnings.length,1);
  }
});
test('取消/重复点击/抢音仅保留最新任务；陈旧事件和拒绝不会污染恢复', async () => {
  const f=mediaFixture(); const a=f.channel.play('prepare'); const old=f.requests[0];
  const b=f.channel.play('continue'); assert.equal(await a,'canceled');
  old.ended(); old.playing(); old.error();
  assert.equal(f.channel.job.key,'continue'); assert.equal(f.warnings.length,0);
  f.end('continue'); assert.equal(await b,'ended'); assert.equal(f.timers.size,0);
  const c=f.channel.play('rest'); f.channel.cancel(); assert.equal(await c,'canceled');
  assert.equal(f.channel.job,null); assert.equal(f.timers.size,0);
});
test('媒体不支持/资源错误/play拒绝/超时均有界降级；只在显式操作重试', async () => {
  const absent=mediaFixture(false); assert.equal(await absent.channel.play('prepare'),'unavailable');
  for(const reason of ['resource','reject','throw','timeout']) {
    const f=mediaFixture();
    if(reason==='reject') f.media.play=()=>Promise.reject({name:'NotAllowedError'});
    if(reason==='throw') f.media.play=()=>{throw new Error('unsupported');};
    const promise=f.channel.play('prepare');
    if(reason==='resource') f.media.onerror();
    if(reason==='timeout') f.advance(7000);
    assert.equal(await promise,'unavailable'); assert.equal(f.channel.job,null); assert.equal(f.timers.size,0);
    const count=f.requests.length; assert.equal(await f.channel.play('rest'),'unavailable'); assert.equal(f.requests.length,count);
    f.media.play=()=>Promise.resolve();
    const retry=f.channel.play('test',true); f.end('test'); assert.equal(await retry,'ended');
    assert.equal(f.channel.failed,false); assert.equal(f.recovered,1);
  }
});
test('红框内容连同容器删除，详情仍可查看，声音恢复操作可访问', () => {
  for(const removed of ['session-formula','idle-copy','idleTitle','calendarNote','readyNote','每项就位','不设连续打卡目标','部分语音未能在提示音前结束','声音功能受限']) assert.ok(!html.includes(removed),removed);
  assert.match(html,/<summary>动作详情<\/summary>/);
  assert.match(html,/id="soundButton"[^>]*aria-pressed="true"/);
  assert.match(html,/id="testSoundButton"/);
  assert.doesNotMatch(html,/speechSynthesis|AudioContext|getUserMedia|microphone|MediaRecorder/);
});

const appFixture = require('./app-fixture.cjs');
test('真实页面控制器：首次点击直接播准备，真实30秒后动作，再15秒工作/5秒短休', async () => {
  const f=appFixture(); await f.click('startButton');
  assert.deepEqual(f.requests[0],{key:'prepare',at:0,gesture:true});
  await f.advance(600); assert.equal(f.state().index,0); assert.equal(f.state().runState,'running');
  await f.advance(29400); assert.equal(f.state().index,0);
  await f.advance(1700); assert.equal(f.state().index,1);
  const work=f.events().find(e=>e.type==='interval-start'&&e.index===1);
  const prep=f.events().find(e=>e.type==='interval-start'&&e.index===0);
  assert.ok(work.zero-prep.zero>=30000 && work.zero-prep.zero<31500);
  await f.advance(15000); assert.equal(f.state().index,2);
  await f.advance(5000); assert.equal(f.state().index,3);
  const starts=f.events().filter(e=>e.type==='interval-start');
  assert.equal(starts[2].zero-starts[1].zero,15000); assert.equal(starts[3].zero-starts[2].zero,5000);
  assert.equal(f.requests.filter(r=>r.key==='rest').length,1);
  assert.equal(f.requests.filter(r=>r.key==='continue').length,1);
  assert.equal(f.elements.get('audioStatusText').textContent,'');
});
test('真实页面控制器：声音关不停视觉计时，重开/试听先暂停，显式继续不丢剩余时间', async () => {
  const f=appFixture(); await f.click('startButton');await f.advance(3000);
  await f.click('soundButton'); const count=f.requests.length;
  await f.advance(29000); assert.equal(f.requests.length,count);assert.equal(f.state().index,1);
  await f.click('soundButton');assert.equal(f.state().runState,'paused');
  const remaining=f.state().remaining;assert.equal(f.requests.at(-1).key,'test');assert.equal(f.requests.at(-1).gesture,true);
  await f.advance(5000);assert.equal(f.state().remaining,remaining);
  await f.click('continueButton');assert.equal(f.requests.at(-1).key,'continue');assert.equal(f.requests.at(-1).gesture,true);
  await f.advance(1000);assert.equal(f.state().runState,'running');assert.ok(f.state().remaining<=remaining);
  await f.visibility(true);const paused=f.state().remaining;await f.advance(50000);await f.visibility(false);
  assert.equal(f.state().runState,'paused');assert.equal(f.state().remaining,paused);
});
test('真实页面控制器：失败仅短状态，自动段不重试堆积；恢复点击真正再次播放', async () => {
  const f=appFixture({rejectPlay:true});await f.click('startButton');await f.advance(50000);
  assert.equal(f.state().runState,'running');assert.equal(f.requests.length,1);
  assert.equal(f.elements.get('testSoundButton').textContent,'重试声音');
  assert.match(f.elements.get('audioStatusText').textContent,/未播放/);
  f.fail(false);await f.click('testSoundButton');assert.equal(f.state().runState,'paused');
  await f.advance(1500);assert.equal(f.elements.get('audioStatusText').textContent,'');
  await f.click('continueButton');await f.advance(1000);assert.equal(f.state().runState,'running');
});
test('真实页面控制器：语音加载超界不会与提示音重叠，也不会被提示音成功清掉错误', async () => {
  const f=appFixture();await f.click('startButton');await f.advance(32000);
  f.stall(true);await f.advance(15000);
  assert.equal(f.state().mediaState,'unavailable');assert.equal(f.state().mediaJob,null);
  assert.match(f.elements.get('audioStatusText').textContent,/语音中断/);
  const count=f.requests.length;await f.advance(5000);assert.equal(f.requests.length,count);
  assert.match(f.elements.get('audioStatusText').textContent,/语音中断/);
});
test('真实页面控制器：提示音解码启动过晚则暂停，不冒充准时零点', async () => {
  const f=appFixture({beepDelay:300});await f.click('startButton');await f.advance(2000);
  assert.equal(f.state().runState,'paused');assert.equal(f.state().mediaState,'unavailable');
  assert.match(f.elements.get('audioStatusText').textContent,/延迟/);
});
test('实际页面完整标准秒长调度：五项短播报、四次手动边界、组休跳过和完整打卡', async () => {
  const f=appFixture();await f.click('startButton');let waits=0,skip=false;
  for(let i=0;i<1600 && f.state().runState!=='finished';i++) {
    if(f.state().runState==='ready') {const before=f.state().index;await f.advance(3000);assert.equal(f.state().index,before);waits++;await f.click('continueButton');}
    if(!skip && f.state().index===12 && f.state().runState==='running') {await f.click('skipRestButton');skip=true;assert.equal(f.state().index,13);}
    await f.advance(1000);
  }
  assert.equal(waits,4);assert.equal(skip,true);assert.equal(f.state().runState,'finished');assert.equal(f.state().historyCount,1);
  const final=f.events().filter(e=>e.type==='interval-start'&&e.stage===4);
  assert.equal(final.length,8);for(let i=1;i<8;i++)assert.equal(final[i].zero-final[i-1].zero,30000);
  assert.equal(f.requests.filter(r=>r.key==='next').length,4);
  for(const key of ['leg-raise','hip-adduction','ankle-inversion'])assert.equal(f.requests.filter(r=>r.key===key).length,1);
  const restored=appFixture({storage:f.storage});assert.equal(restored.state().historyCount,1);
});
test('真实页面控制器：暂停语音期后迟到完成不启动，刷新仍需手动继续且历史不变', async () => {
  const storage=new Map([['rehab-timer:v1:sentinel','synthetic-do-not-touch']]);
  const f=appFixture({storage});await f.click('startButton');const old=f.media.onended;
  await f.click('pauseButton');old();await f.advance(10000);assert.equal(f.state().runState,'paused');
  const restored=appFixture({storage});assert.equal(restored.state().runState,'paused');assert.equal(restored.requests.length,0);
  await restored.click('continueButton');await restored.advance(2000);
  await restored.click('resetButton');await restored.click('confirmResetButton');
  assert.equal(restored.state().runState,'idle');assert.equal(restored.state().historyCount,0);
  assert.equal(storage.get('rehab-timer:v1:sentinel'),'synthetic-do-not-touch');
});

test('时区改变与夏令时附近日期不由UTC切片计算', () => {
  const before=process.env.TZ;
  try {
    process.env.TZ='America/Los_Angeles';
    assert.equal(localDate(new Date('2026-01-01T01:00:00Z')),'2025-12-31');
    const records=[{date:'2026-03-08'},{date:'2026-03-09'}];
    assert.equal(weeklyCount(records,new Date(2026,2,8,23,59)),1);
    assert.equal(monthCells(2026,2,records,new Date(2026,2,8)).filter(c=>c?.complete).length,2);
  } finally { process.env.TZ=before; }
});
