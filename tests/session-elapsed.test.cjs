'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const appFixture=require('./app-fixture.cjs');

const elapsed=f=>f.context.__rehabTimer.getElapsed();
const value=(f,place='training')=>f.elements.get(`${place}ElapsedValue`).textContent;
const snapshotFields=['version','planRevision','groupRestSeconds','program','unitMs','id','index','remaining','state','completion'].sort();

function assertNoStoredElapsed(f){
  function inspect(item,path){
    if(!item||typeof item!=='object')return;
    for(const [key,child]of Object.entries(item)){
      assert.doesNotMatch(key,/elapsed|wallStart|monoStart|milliseconds/i,`${path}.${key}`);
      inspect(child,`${path}.${key}`);
    }
  }
  for(const [key,raw]of f.storage){
    assert.doesNotMatch(key,/elapsed/i);
    const item=JSON.parse(raw);inspect(item,key);
    if(key.includes(':snapshot:'))assert.deepEqual(Object.keys(item).sort(),snapshotFields);
  }
  inspect(f.state(),'diagnostic state');
}

async function finishOriginal(f,{debug=false}={}){
  const {PROGRAM,stageTrack}=f.context.RehabCore;
  for(let stage=0;stage<5;stage++){
    const duration=debug?f.context.__rehabTimer.getPlan().filter(item=>item.stage===stage).reduce((sum,item)=>sum+item.seconds,0)*f.context.__rehabTimer.config.unitMs+3000:(stageTrack(stage,PROGRAM).duration+2)*1000;
    await f.advance(duration);
    if(stage<4){
      assert.equal(f.state().runState,'ready');
      const before=elapsed(f).milliseconds;
      await f.advance(1700);
      assert.equal(elapsed(f).milliseconds,before+1700);
      await f.click('continueButton');
    }
  }
  assert.equal(f.state().runState,'finished');
}

test('整体耗时只从成功的新训练开始，拒绝开始和重复点击不会创建或重置起点',async()=>{
  const locked=appFixture({wallClock:true,protocol:'https:',search:''});
  assert.equal(elapsed(locked),null);
  assert.equal(locked.elements.get('homeElapsedPanel').hidden,true);
  await locked.click('startButton');
  assert.equal(locked.state().runState,'idle');assert.equal(elapsed(locked),null);

  const f=appFixture({wallClock:true});
  assert.equal(f.elements.get('homeElapsedPanel').hidden,true);
  await f.advance(5000);await f.click('startButton');
  assert.equal(elapsed(f).milliseconds,0);assert.equal(value(f),'00:00');
  await f.advance(1400);await f.click('startButton');
  assert.equal(elapsed(f).milliseconds,1400);
  assert.equal(f.elements.get('trainingElapsedPanel').hidden,false);
});

test('加速训练仍按真实秒长展示整体耗时，暂停与结束确认取消都继续计时',async()=>{
  const f=appFixture({wallClock:true,search:'?debugMs=20'});
  await f.click('startButton');await f.advance(2000);
  assert.ok(f.state().index>0);
  assert.equal(elapsed(f).milliseconds,2000);assert.equal(value(f),'00:02');
  await f.click('pauseButton');await f.advance(3500);
  assert.equal(f.state().runState,'paused');assert.equal(elapsed(f).milliseconds,5500);
  await f.click('resetButton');await f.advance(1100);await f.click('cancelResetButton');
  assert.equal(elapsed(f).finished,false);
  await f.advance(900);await f.click('resetButton');await f.advance(800);
  await f.click('confirmResetButton');
  assert.equal(f.state().runState,'idle');assert.equal(elapsed(f).milliseconds,8300);
  assert.equal(elapsed(f).finished,true);assert.equal(value(f,'home'),'00:08');
  assert.match(f.elements.get('homeElapsedLabel').textContent,/已结束/);
  await f.advance(60000);
  assert.equal(elapsed(f).milliseconds,8300);assert.equal(value(f,'home'),'00:08');
  assert.equal(f.state().historyCount,0);
  assertNoStoredElapsed(f);
});

test('结束存储失败保留当前训练和进行中的整体耗时，成功重试才冻结',async()=>{
  class FailingStorage extends Map {
    set(key,value){if(this.fail)throw new Error('Synthetic storage failure');return super.set(key,value);}
  }
  const storage=new FailingStorage(),f=appFixture({storage,wallClock:true});
  await f.click('startButton');await f.advance(1200);await f.click('resetButton');
  storage.fail=true;await f.click('confirmResetButton');
  assert.equal(f.state().runState,'paused');assert.equal(elapsed(f).finished,false);
  await f.advance(2500);assert.equal(elapsed(f).milliseconds,3700);
  storage.fail=false;await f.click('confirmResetButton');
  assert.equal(elapsed(f).finished,true);assert.equal(elapsed(f).milliseconds,3700);
  await f.advance(2000);assert.equal(elapsed(f).milliseconds,3700);
});

for(const debug of [false,true])test(`${debug?'加速计时':'标准音轨'}完整原计划完成时冻结，保存重试和返回首页不改变结果`,async()=>{
  const f=appFixture({wallClock:true,search:debug?'?debugMs=20':'?test=1'});
  await f.click('startButton');await finishOriginal(f,{debug});
  const result=elapsed(f).milliseconds;
  assert.equal(elapsed(f).finished,true);assert.equal(f.state().historyCount,1);
  assert.ok(result>(debug?30000:1520000));
  assert.match(f.elements.get('trainingElapsedLabel').textContent,/已完成/);
  const rendered=value(f);
  await f.advance(60000);await f.click('retrySaveButton');
  assert.equal(elapsed(f).milliseconds,result);assert.equal(value(f),rendered);
  await f.click('finishedRecordsButton');await f.advance(1500);await f.click('homeNav');
  assert.equal(f.state().runState,'idle');assert.equal(elapsed(f).milliseconds,result);
  assert.equal(value(f,'home'),rendered);assert.equal(f.elements.get('homeElapsedPanel').hidden,false);
  assertNoStoredElapsed(f);
  await f.click('startButton');
  assert.equal(elapsed(f).milliseconds,0);assert.equal(elapsed(f).finished,false);
  assert.equal(value(f),'00:00');assert.match(f.elements.get('trainingElapsedLabel').textContent,/^本次整体耗时$/);
});

test('下肢计划完整执行，手动两组和中间等待都计入，第二组点完成才冻结',async()=>{
  const f=appFixture({wallClock:true});
  await f.click('jointTab');await f.click('startButton');
  const {JOINT_PROGRAM,stageTrack}=f.context.RehabCore;
  for(let stage=0;stage<4;stage++){
    await f.advance((stageTrack(stage,JOINT_PROGRAM).duration+2)*1000);
    assert.equal(f.state().runState,'ready');await f.advance(1200);await f.click('continueButton');
  }
  assert.equal(f.state().runState,'manual');
  const manualStart=elapsed(f).milliseconds;
  await f.advance(2300);await f.click('completeButton');
  assert.equal(f.state().runState,'ready');assert.equal(elapsed(f).finished,false);
  await f.advance(3400);await f.click('continueButton');await f.advance(4500);
  assert.equal(f.state().runState,'manual');await f.click('completeButton');
  assert.equal(f.state().runState,'finished');assert.equal(elapsed(f).finished,true);
  assert.equal(elapsed(f).milliseconds,manualStart+10200);
  const result=elapsed(f).milliseconds;
  await f.advance(7000);await f.click('completeButton');
  assert.equal(elapsed(f).milliseconds,result);assert.equal(f.state().historyCount,1);
  assertNoStoredElapsed(f);
});

test('同页切换两套计划，各自计时按原始开始时刻持续，结束其中一套不影响另一套',async()=>{
  const f=appFixture({wallClock:true});
  await f.click('startButton');await f.advance(5000);await f.click('backTrainingButton');
  const originalId=f.state().id;
  await f.click('jointTab');assert.equal(elapsed(f),null);
  await f.click('startButton');await f.advance(2000);await f.click('backTrainingButton');
  const jointId=f.state().id;
  await f.click('originalTab');assert.equal(f.state().id,originalId);assert.equal(elapsed(f).milliseconds,7000);
  await f.advance(3000);assert.equal(value(f,'home'),'00:10');
  await f.click('jointTab');assert.equal(f.state().id,jointId);assert.equal(elapsed(f).milliseconds,5000);
  await f.click('homeResetButton');await f.click('confirmResetButton');
  assert.equal(elapsed(f).finished,true);assert.equal(elapsed(f).milliseconds,5000);
  await f.advance(2000);await f.click('originalTab');
  assert.equal(f.state().id,originalId);assert.equal(elapsed(f).milliseconds,12000);assert.equal(elapsed(f).finished,false);
});

test('刷新只恢复训练进度，继续或结束旧会话都不伪造整体耗时',async()=>{
  const storage=new Map(),f=appFixture({storage,wallClock:true});
  await f.click('startButton');await f.advance(6000);await f.click('pauseButton');
  assert.equal(elapsed(f).milliseconds,6000);assertNoStoredElapsed(f);
  const restored=appFixture({storage,wallClock:true});
  assert.equal(restored.state().id,f.state().id);assert.equal(restored.state().runState,'paused');
  assert.equal(elapsed(restored),null);assert.equal(value(restored,'home'),'未记录');
  assert.match(restored.elements.get('homeElapsedHint').textContent,/刷新或换设备/);
  await restored.click('resumeButton');await restored.click('continueButton');await restored.advance(4000);
  assert.equal(elapsed(restored),null);assert.equal(value(restored),'未记录');
  await restored.click('resetButton');await restored.click('confirmResetButton');
  assert.equal(elapsed(restored),null);assert.equal(restored.elements.get('homeElapsedPanel').hidden,true);
  await restored.click('startButton');assert.equal(elapsed(restored).milliseconds,0);
  assertNoStoredElapsed(restored);
});

test('后台系统休眠计入耗时，超过一小时格式正确，系统时钟回拨不会倒退',async()=>{
  const f=appFixture({wallClock:true});
  await f.click('startButton');await f.advance(1000);await f.click('pauseButton');
  const mono=f.context.performance.now();
  await f.visibility(true);await f.shiftWall(3660000);
  assert.equal(f.context.performance.now(),mono);
  await f.visibility(false);
  assert.equal(elapsed(f).milliseconds,3661000);assert.equal(value(f),'1:01:01');
  await f.shiftWall(-7200000);await f.advance(2000);
  assert.equal(elapsed(f).milliseconds,3661000);assert.equal(value(f),'1:01:01');
  await f.click('resetButton');await f.click('confirmResetButton');
  assert.equal(elapsed(f).milliseconds,3661000);assert.equal(value(f,'home'),'1:01:01');
});

test('暂停期间显示更新不会写入本地存储，新日期补记也不创建整体计时',async()=>{
  const f=appFixture({wallClock:true});
  await f.click('startButton');await f.advance(1000);await f.click('pauseButton');
  const before=[...f.storage];
  await f.advance(6500);
  assert.equal(value(f),'00:07');assert.deepEqual([...f.storage],before);
  await f.click('resetButton');await f.click('confirmResetButton');assertNoStoredElapsed(f);
  const empty=appFixture({wallClock:true});await empty.click('recordsNav');
  empty.elements.get('historyDate').value='2026-10-17';
  await empty.click('markDate');await empty.click('markDate');
  assert.equal(empty.state().historyCount,1);assert.equal(elapsed(empty),null);
});

test('已有结束摘要后恢复同计划另一次旧训练，结束或完成旧训练不会让前次摘要重新出现',async()=>{
  for(const outcome of ['ended','completed']){
    const f=appFixture({wallClock:true}),prefix=f.context.__rehabTimer.config.prefix;
    await f.click('startButton');await f.advance(4200);await f.click('resetButton');await f.click('confirmResetButton');
    assert.equal(elapsed(f).finished,true);assert.equal(value(f,'home'),'00:04');
    await f.click('jointTab');
    const {Engine,PROGRAM}=f.context.RehabCore,old=new Engine(1000,PROGRAM);
    old.start(`synthetic-other-restored-${outcome}`);
    old.index=old.plan.length-1;old.remaining=1000;old.state='paused';
    const repository=f.context.RehabPersistence.create({mode:'local',storage:f.context.localStorage,prefix});
    assert.equal(repository.forProgram(PROGRAM).saveProgress(old.snapshot(),true),true);
    await f.click('originalTab');
    assert.equal(f.state().id,old.id);assert.equal(elapsed(f),null);
    assert.equal(value(f,'home'),'未记录');
    if(outcome==='ended'){
      await f.click('homeResetButton');await f.click('confirmResetButton');
    }else{
      await f.click('resumeButton');await f.click('continueButton');await f.advance(3000);
      assert.equal(f.state().runState,'finished');assert.equal(elapsed(f),null);
      await f.click('finishedHomeButton');
    }
    assert.equal(f.state().runState,'idle');assert.equal(elapsed(f),null,outcome);
    assert.equal(f.elements.get('homeElapsedPanel').hidden,true,outcome);
    await f.click('jointTab');await f.click('originalTab');
    assert.equal(elapsed(f),null);assert.equal(f.elements.get('homeElapsedPanel').hidden,true);
    assertNoStoredElapsed(f);
  }
});

test('确认结束时同步存储延迟触发重绘，最终耗时仍冻结在确认点击而非写入结束',async()=>{
  let f,delayPromise;
  class SlowStorage extends Map {
    delete(key){
      if(this.delay&&key.includes(':active:')){
        this.delay=false;
        delayPromise=f.shiftWall(2100);
      }
      return super.delete(key);
    }
  }
  const storage=new SlowStorage();f=appFixture({storage,wallClock:true});
  const start=f.context.Date.now();
  await f.click('startButton');await f.advance(5000);await f.click('resetButton');
  assert.equal(elapsed(f).milliseconds,5000);
  storage.delay=true;await f.click('confirmResetButton');await delayPromise;
  assert.equal(f.context.Date.now()-start,7100);
  assert.equal(f.state().runState,'idle');assert.equal(elapsed(f).finished,true);
  assert.equal(elapsed(f).milliseconds,5000);assert.equal(value(f,'home'),'00:05');
  await f.advance(4000);assert.equal(elapsed(f).milliseconds,5000);
  assertNoStoredElapsed(f);
});
