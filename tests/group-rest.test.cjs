'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const appFixture=require('./app-fixture.cjs');
const context=vm.createContext({Date});
const html=fs.readFileSync(new URL('../index.html',`file://${__filename}`),'utf8');
vm.runInContext(html.match(/<script id="rehab-core">([\s\S]*?)<\/script>/)[1],context);
const {Engine,PROGRAM,JOINT_PROGRAM,GROUP_REST_OPTIONS,programs,planFor,stageTrack}=context.RehabCore;
const plain=value=>JSON.parse(JSON.stringify(value));

for(const program of [PROGRAM,JOINT_PROGRAM])for(const seconds of GROUP_REST_OPTIONS){
  test(`${program} 组休 ${seconds} 秒：只有四个组休变化，完整执行保留全部动作与手动边界`,()=>{
    const schedule=planFor(program,seconds),base=programs[program].plan;
    assert.equal(schedule.length,base.length);
    assert.equal(schedule.filter(p=>p.kind==='group-rest').length,4);
    for(const [index,item]of schedule.entries())assert.deepEqual(plain(item),plain(base[index].kind==='group-rest'?{...base[index],seconds}:base[index]));
    assert.equal(schedule.reduce((sum,p)=>sum+p.seconds,0),(program===PROGRAM?1520:1510)+4*(seconds-60));
    const engine=new Engine(1000,program,seconds);engine.start('synthetic-configured-full');engine.arm(0);
    let now=0,waits=0,manuals=0;
    const visited=new Set();
    while(engine.state!=='finished'){
      visited.add(engine.index);
      if(engine.interval.kind==='manual'){
        engine.state='manual';engine.completeManual(new Date('2026-10-17T06:00:00Z'));manuals++;
      }else{
        now=Math.min(engine.deadline,now+200);engine.tick(now,new Date('2026-10-17T06:00:00Z'));
      }
      if(engine.state==='ready'){waits++;engine.continue();}
      if(engine.state==='cue'&&engine.interval.kind!=='manual')engine.arm(now);
    }
    assert.equal(visited.size,schedule.length);assert.equal(waits,program===PROGRAM?4:5);
    assert.equal(manuals,program===PROGRAM?0:2);assert.equal(engine.snapshot().groupRestSeconds,seconds);
    assert.equal(engine.completion.id,'synthetic-configured-full');
  });
}

test('恢复先读取会话组休档位，旧快照缺省60秒；无效配置不改当前状态',()=>{
  const engine=new Engine(1000,PROGRAM,150);
  const old={version:1,planRevision:2,program:PROGRAM,unitMs:1000,id:'synthetic-old-rest',index:12,remaining:55000,state:'paused',completion:null};
  assert.equal(engine.restore(old),true);assert.equal(engine.groupRestSeconds,60);assert.equal(engine.interval.seconds,60);
  assert.equal(engine.restore({...old,groupRestSeconds:150,remaining:149500}),true);
  assert.equal(engine.groupRestSeconds,150);assert.equal(engine.interval.seconds,150);assert.equal(engine.remaining,149500);
  const before=plain(engine.snapshot());
  for(const value of [0,59,61,180,'90',null,NaN]){
    assert.equal(engine.restore({...old,groupRestSeconds:value}),false);
    assert.deepEqual(plain(engine.snapshot()),before);assert.throws(()=>new Engine(1000,PROGRAM,value));
  }
  assert.equal(engine.restore({...old,remaining:149500}),false);
  assert.deepEqual(plain(engine.snapshot()),before);
});

test('各档连续音轨仅延长组休，第二组和下一项的语音、提示音整体后移',()=>{
  for(const program of [PROGRAM,JOINT_PROGRAM])for(const seconds of GROUP_REST_OPTIONS)for(let stage=0;stage<4;stage++){
    const base=stageTrack(stage,program),track=stageTrack(stage,program,seconds),offset=seconds-60;
    const restIndex=planFor(program,seconds).find(p=>p.stage===stage&&p.kind==='group-rest').index;
    const rest=track.entries.find(e=>e.index===restIndex);
    assert.ok(Math.abs(rest.end-rest.start-seconds)<1e-8);
    assert.ok(Math.abs(track.duration-base.duration-offset)<1e-8);
    assert.equal(track.sounds.length,base.sounds.length);
    for(const entry of track.entries){
      const original=base.entries.find(e=>e.index===entry.index);
      assert.ok(Math.abs(entry.start-original.start-(entry.index>restIndex?offset:0))<1e-8);
      assert.ok(Math.abs(entry.end-original.end-(entry.index>=restIndex?offset:0))<1e-8);
    }
    const restPosition=base.entries.find(e=>e.index===restIndex);
    for(let i=0;i<track.sounds.length;i++){
      assert.equal(track.sounds[i].key,base.sounds[i].key);
      assert.ok(Math.abs(track.sounds[i].at-base.sounds[i].at-(base.sounds[i].at>restPosition.start?offset:0))<1e-8);
    }
  }
  assert.deepEqual(plain(stageTrack(4,PROGRAM,150)),plain(stageTrack(4,PROGRAM,60)));
});

for(const program of [PROGRAM,JOINT_PROGRAM])test(`${program} 150秒组休真实控制器：过60秒仍休息，恢复与跳过使用150秒音轨`,async()=>{
  const storage=new Map(),seed=appFixture({storage});
  const repo=seed.context.RehabPersistence.create({mode:'local',storage:seed.context.localStorage,prefix:seed.context.__rehabTimer.config.prefix});
  const engine=new Engine(1000,program,150);engine.start('synthetic-long-rest-media');
  const snapshot={...plain(engine.snapshot()),index:12,remaining:150000,state:'paused'};
  assert.equal(repo.forProgram(program).saveProgress(snapshot,true),true);
  const f=appFixture({storage,protocol:'https:'});
  if(program===JOINT_PROGRAM)await f.click('jointTab');
  await f.click('resumeButton');await f.click('continueButton');await f.advance(62000);
  assert.equal(f.state().index,12);assert.equal(f.state().runState,'running');
  assert.ok(f.state().remaining>87000&&f.state().remaining<90000);
  const source=`audio/stage-${program===JOINT_PROGRAM?'joint-':''}1-rest-150.mp3`;
  assert.ok(f.fetchRequests.includes(source));
  await f.click('pauseButton');const paused=f.state();
  const restored=appFixture({storage,protocol:'https:'});
  assert.equal(restored.state().groupRestSeconds,150);assert.equal(restored.state().remaining,paused.remaining);
  await restored.click('resumeButton');await restored.click('continueButton');await restored.advance(1000);
  await restored.click('skipRestButton');await restored.advance(1200);
  assert.equal(restored.state().index,13);assert.equal(restored.state().runState,'running');
  assert.equal(restored.state().groupRestSeconds,150);assert.equal(restored.state().historyCount,0);
  const last=restored.events().filter(event=>event.type==='track-start').at(-1);
  assert.equal(last.position,stageTrack(0,program,150).entries.find(e=>e.index===13).start-.25);
});
