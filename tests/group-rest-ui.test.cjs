'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const appFixture=require('./app-fixture.cjs');

const UI_KEY='rehab-timer:test:v1:1000:ui:v2';
const plain=value=>JSON.parse(JSON.stringify(value));
function seedProgress(storage,{seconds=60,legacy=false,finished=false,nearFinish=false}={}){
  const seed=appFixture({storage}),{Engine,PROGRAM}=seed.context.RehabCore;
  const engine=new Engine(1000,PROGRAM,seconds);
  engine.start('synthetic-rest-setting');
  engine.index=finished||nearFinish?engine.plan.length-1:12;
  engine.remaining=finished?0:nearFinish?1000:43500;
  engine.state=finished?'finished':'paused';
  if(finished){const now=new Date();engine.completion={version:1,id:engine.id,date:seed.context.RehabCore.localDate(now),finishedAt:now.toISOString()};}
  const repo=seed.context.RehabPersistence.create({mode:'local',storage:seed.context.localStorage,prefix:seed.context.__rehabTimer.config.prefix});
  assert.equal(repo.forProgram(PROGRAM).saveProgress(engine.snapshot(),true),true);
  if(legacy){
    const key=[...storage.keys()].find(key=>key.includes(':snapshot:'));
    const snapshot=JSON.parse(storage.get(key));delete snapshot.groupRestSeconds;storage.set(key,JSON.stringify(snapshot));
  }
  return engine.snapshot();
}

test('首页四档组休更新计时和详情，不开始训练也不播放音频',async()=>{
  const f=appFixture();
  assert.equal(f.elements.get('groupRestSelect').value,'60');
  assert.equal(f.elements.get('groupRestSelect').disabled,false);
  for(const seconds of [60,90,120,150]){
    await f.select('groupRestSelect',seconds);
    assert.equal(f.context.__rehabTimer.config.groupRestSeconds,seconds);
    assert.equal(f.context.__rehabTimer.config.totalSeconds,1520+4*(seconds-60));
    assert.equal(f.state().runState,'idle');
    assert.equal(f.requests.length,0);
    assert.equal(f.context.__rehabTimer.getPlan().filter(item=>item.kind==='group-rest').every(item=>item.seconds===seconds),true);
    assert.match(f.elements.get('routineList').children[0].children[1].textContent,new RegExp(`组间休息 ${seconds} 秒`));
  }
  assert.match(f.elements.get('homePlanMeta').textContent,/31 分 20 秒/);
  assert.match(f.elements.get('routineList').children[4].children[1].textContent,/休息 30 秒/);
});

test('两套计划共享本设备偏好，刷新同时保留计划和所选时长',async()=>{
  const storage=new Map(),f=appFixture({storage});
  await f.select('groupRestSelect',90);await f.click('jointTab');
  assert.equal(f.context.__rehabTimer.config.groupRestSeconds,90);
  assert.match(f.elements.get('routineList').children[0].children[1].textContent,/组间休息 90 秒.*节间休息 60 秒/);
  assert.match(f.elements.get('homePlanMeta').textContent,/手动动作/);
  const stored=JSON.parse(storage.get(UI_KEY));
  assert.deepEqual(stored,{program:f.context.RehabCore.JOINT_PROGRAM,groupRestSeconds:90});
  const restored=appFixture({storage});
  assert.equal(restored.context.__rehabTimer.config.program,stored.program);
  assert.equal(restored.elements.get('groupRestSelect').value,'90');
  assert.equal(restored.state().runState,'idle');
});

test('运行和暂停后组休设置锁定，伪造更改事件不会篡改本次快照',async()=>{
  const storage=new Map(),f=appFixture({storage});
  await f.select('groupRestSelect',150);await f.click('startButton');
  assert.equal(f.state().groupRestSeconds,150);
  assert.equal(f.elements.get('groupRestSelect').disabled,true);
  await f.advance(1000);await f.click('backTrainingButton');
  const before=plain(f.state());
  assert.equal(before.runState,'paused');
  assert.match(f.elements.get('groupRestHint').textContent,/已锁定.*结束后/);
  await f.select('groupRestSelect',60);
  assert.equal(f.elements.get('groupRestSelect').value,'150');
  assert.equal(f.state().groupRestSeconds,150);
  assert.equal(f.state().remaining,before.remaining);
  assert.equal(JSON.parse(storage.get(UI_KEY)).groupRestSeconds,150);
});

test('恢复按会话时长显示，切换和结束后回到本设备下一次偏好',async()=>{
  const storage=new Map([[UI_KEY,JSON.stringify({program:'five-stage-v1',groupRestSeconds:90})]]);
  const snapshot=seedProgress(storage,{seconds:150}),f=appFixture({storage});
  assert.equal(f.state().id,snapshot.id);assert.equal(f.state().remaining,43500);
  assert.equal(f.context.__rehabTimer.config.groupRestSeconds,150);
  assert.equal(f.elements.get('groupRestSelect').disabled,true);
  await f.click('jointTab');
  assert.equal(f.state().runState,'idle');assert.equal(f.context.__rehabTimer.config.groupRestSeconds,90);
  await f.click('originalTab');
  assert.equal(f.state().remaining,43500);assert.equal(f.context.__rehabTimer.config.groupRestSeconds,150);
  await f.click('homeResetButton');await f.click('confirmResetButton');
  assert.equal(f.state().runState,'idle');assert.equal(f.context.__rehabTimer.config.groupRestSeconds,90);
  assert.equal(f.elements.get('groupRestSelect').disabled,false);
  await f.click('startButton');assert.equal(f.state().groupRestSeconds,90);
});

test('旧会话缺少组休字段时按60秒恢复，不被较长新偏好覆盖',()=>{
  const storage=new Map([[UI_KEY,JSON.stringify({program:'five-stage-v1',groupRestSeconds:120})]]);
  seedProgress(storage,{legacy:true});
  const f=appFixture({storage});
  assert.equal(f.state().groupRestSeconds,60);assert.equal(f.state().remaining,43500);
  assert.equal(f.context.__rehabTimer.config.totalSeconds,1520);
  assert.equal(f.elements.get('groupRestSelect').value,'60');
  assert.equal(JSON.parse(storage.get(UI_KEY)).groupRestSeconds,120);
});

test('完成保存后可为下次选择新时长，已有完成历史保留',async()=>{
  const storage=new Map();seedProgress(storage,{seconds:150,finished:true});
  const f=appFixture({storage});
  assert.equal(f.state().runState,'idle');
  assert.equal(f.state().historyCount,1);assert.equal(f.elements.get('groupRestSelect').disabled,false);
  await f.select('groupRestSelect',120);
  assert.equal(f.state().runState,'idle');assert.equal(f.context.__rehabTimer.config.groupRestSeconds,120);
  assert.equal(f.state().historyCount,1);
});

test('完成150秒旧会话后回首页显示90秒本机偏好，与下一次实际启动一致',async()=>{
  const storage=new Map([[UI_KEY,JSON.stringify({program:'five-stage-v1',groupRestSeconds:90})]]);
  seedProgress(storage,{seconds:150,nearFinish:true});
  const f=appFixture({storage});await f.click('resumeButton');await f.click('continueButton');await f.advance(2500);
  assert.equal(f.state().runState,'finished');assert.equal(f.state().savedCompletion,true);
  assert.equal(f.state().groupRestSeconds,150);assert.equal(f.state().historyCount,1);
  await f.click('finishedHomeButton');
  assert.equal(f.state().runState,'idle');assert.equal(f.elements.get('groupRestSelect').value,'90');
  assert.equal(f.context.__rehabTimer.config.totalSeconds,1640);
  assert.match(f.elements.get('routineList').children[0].children[1].textContent,/组间休息 90 秒/);
  await f.click('startButton');assert.equal(f.state().groupRestSeconds,90);assert.equal(f.state().historyCount,1);
});

test('损坏的休息偏好回落60秒，合法计划选择不受影响',()=>{
  const storage=new Map([[UI_KEY,JSON.stringify({program:'lower-limb-joints-v1',groupRestSeconds:75})]]),f=appFixture({storage});
  assert.equal(f.context.__rehabTimer.config.program,'lower-limb-joints-v1');
  assert.equal(f.context.__rehabTimer.config.groupRestSeconds,60);
  assert.equal(f.elements.get('groupRestSelect').value,'60');
});
