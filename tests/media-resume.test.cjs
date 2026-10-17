'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const appFixture=require('./app-fixture.cjs');

test('开头口令零点前暂停，继续短提示后从零点前250ms接入，不重播原口令',async()=>{
  const f=appFixture({protocol:'https:'});
  const {cues,stageTrack}=f.context.RehabCore;
  await f.click('startButton');
  await f.advance(100);
  assert.equal(f.state().runState,'cue');
  await f.click('pauseButton');
  const paused=f.state();
  assert.equal(paused.remaining,30000);
  await f.click('continueButton');
  assert.equal(f.requests.at(-1).key,'prepare');
  assert.equal(f.requests.at(-1).gesture,true);
  await f.advance(cues.prepare[1]+1);
  const resumed=f.events().filter(event=>event.type==='track-start').at(-1);
  assert.equal(resumed.position,stageTrack(0).entries[0].start-.25);
  assert.equal(f.state().remaining,paused.remaining);
  await f.advance(250);
  assert.equal(f.state().runState,'running');
  assert.equal(f.state().index,0);
  assert.equal(f.requests.filter(request=>request.key==='prepare').length,1);
});

test('动作已经开始时暂停，继续保留原音轨位置和部分秒数',async()=>{
  const f=appFixture({protocol:'https:'});
  await f.click('startButton');
  await f.advance(40000);
  assert.equal(f.state().index,1);
  assert.equal(f.state().runState,'running');
  const position=f.media.currentTime;
  await f.click('pauseButton');
  const paused=f.state();
  assert.ok(paused.remaining>0&&paused.remaining<15000);
  await f.click('continueButton');
  assert.equal(f.requests.at(-1).key,'hip-extension');
  assert.equal(f.requests.at(-1).gesture,true);
  await f.advance(f.context.RehabCore.cues['hip-extension'][1]+1);
  const resumed=f.events().filter(event=>event.type==='track-start').at(-1);
  assert.equal(resumed.position,position);
  assert.equal(f.state().index,paused.index);
  assert.ok(Math.abs(f.state().remaining-paused.remaining)<.001);
});

test('恢复短提示期间关闭声音只静音，提示结束后继续训练交接',async()=>{
  const f=appFixture({protocol:'https:'});
  await f.click('startButton');
  await f.advance(40000);
  await f.click('pauseButton');
  const paused=f.state(),position=f.media.currentTime;
  await f.click('continueButton');
  assert.equal(f.state().mediaJob,'hip-extension');
  await f.click('soundButton');
  assert.equal(f.state().soundEnabled,false);
  assert.equal(f.media.muted,true);
  assert.equal(f.state().runState,'cue');
  await f.advance(f.context.RehabCore.cues['hip-extension'][1]+1);
  assert.equal(f.state().runState,'running');
  assert.equal(f.state().index,paused.index);
  assert.ok(Math.abs(f.state().remaining-paused.remaining)<.001);
  assert.equal(f.media.muted,true);
  assert.equal(f.events().filter(event=>event.type==='track-start').at(-1).position,position);
});

test('普通试听期间关闭声音仍取消试听，不启动训练',async()=>{
  const f=appFixture({protocol:'https:'});
  await f.click('homeTestSoundButton');
  assert.equal(f.state().mediaJob,'test');
  await f.click('homeSoundButton');
  assert.equal(f.state().soundEnabled,false);
  assert.equal(f.state().mediaJob,null);
  assert.equal(f.media.paused,true);
  await f.advance(2000);
  assert.equal(f.state().runState,'idle');
  assert.equal(f.events().filter(event=>event.type==='track-start').length,0);
});
