'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const coreSource = fs.readFileSync(new URL('../src/core.js',`file://${__filename}`),'utf8');
const source = fs.readFileSync(new URL('../src/repository.js',`file://${__filename}`),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-09-07T10:00:00Z');
class Storage {
  constructor() { this.data = new Map(); this.failWrite = false; this.failRead = false; }
  get length() { if (this.failRead) throw Error('blocked'); return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { if (this.failRead) throw Error('blocked'); return this.data.get(key) ?? null; }
  setItem(key,value) { if (this.failWrite) throw Error('full'); this.data.set(key,String(value)); }
  removeItem(key) { if (this.failWrite) throw Error('blocked'); this.data.delete(key); }
}

// A controllable transport double: the assertions exercise durable browser state and wire requests.
class API {
  constructor() { this.offline=false; this.locked=false; this.calls=[]; this.sessions=new Map(); this.records=new Map(); this.receipts=new Map(); this.dropType=null; this.failType=null; this.importCalls=0; this.hangType=null; this.hanging=[]; }
  response(status,data) { return {ok:status >= 200 && status < 300,status,json:async()=>plain(data)}; }
  fail(code,message='请求冲突。',session) { return this.response(409,{ok:false,error:{code,message},session}); }
  async fetch(path,options) {
    this.lastSignal=options.signal;
    const body=options.body ? JSON.parse(options.body) : null;
    this.calls.push({path,options:plain(options),body});
    if (this.offline) throw Error('network unreachable');
    if (path==='/api/login') { this.locked=body.passphrase!=='shared-test'; return this.response(this.locked?401:200,this.locked?{ok:false,error:{code:'locked',message:'口令错误。'}}:{ok:true}); }
    if (path==='/api/logout') { this.locked=true; return this.response(200,{ok:true}); }
    if (this.locked) return this.response(401,{ok:false,error:{code:'locked',message:'请输入共享口令。'}});
    if (path==='/api/state') return this.response(200,{ok:true,records:[...this.records.values()],sessions:[...this.sessions.values()].map(({token,...session})=>session)});
    assert.equal(path,'/api/operation');
    const op=body, previous=this.receipts.get(op.operationId);
    if (previous) {
      assert.deepEqual(op,previous.request,'a retried operation must have an identical body');
      return this.response(200,previous.result);
    }
    if (this.failType===op.type) return this.response(500,{ok:false,error:{code:'database_unavailable',message:'数据库暂不可用。'}});
    const id=`${op.program}:${op.sessionId}`, old=this.sessions.get(id);
    let result={ok:true,operationId:op.operationId};
    if (op.type==='create') {
      if (old) return this.fail('session_exists','会话已存在。',old);
      const session={id:op.sessionId,program:op.program,status:'active',snapshot:op.snapshot,revision:1,writerEpoch:1,token:op.writerToken};
      this.sessions.set(id,session); result.session=session;
    } else if (['progress','complete','abandon'].includes(op.type)) {
      if (!old || old.status!=='active' || old.revision!==op.expectedRevision || old.writerEpoch!==op.writerEpoch || old.token!==op.writerToken) return this.fail('writer_conflict','写入权或版本已变化。',old);
      const session={...old,revision:old.revision+1,...(op.snapshot?{snapshot:op.snapshot}:{})};
      if (op.type==='complete') { session.status='completed'; result.record={...op.record,revoked:false}; this.records.set(`${op.program}:${op.record.id}`,result.record); }
      if (op.type==='abandon') session.status='abandoned';
      this.sessions.set(id,session); result.session=session;
    } else if (op.type==='claim') {
      if (!old || old.status!=='active' || old.revision!==op.expectedRevision) return this.fail('revision_conflict','快照已变化。',old);
      const session={...old,revision:old.revision+1,writerEpoch:old.writerEpoch+1,token:'claimed-token-000000000000000000000000'};
      this.sessions.set(id,session); result.session=session; result.writerToken=session.token;
    } else if (op.type==='manual') {
      result.record={...op.record,revoked:false}; this.records.set(`${op.program}:${op.record.id}`,result.record);
    } else if (op.type==='revoke') {
      const name=`${op.program}:${op.recordId}`, record=this.records.get(name);
      if (!record) return this.fail('missing_record');
      result.record={...record,revoked:true}; this.records.set(name,result.record);
    } else if (op.type==='import') {
      this.importCalls++;
      const insertedRecords=[],conflicts=[];
      for (const item of op.records) {
        const name=`${item.program}:${item.record.id}`;
        if (!this.records.has(name)) { this.records.set(name,{...item.record,program:item.program,source:'legacy',timeZone:null,revoked:false}); insertedRecords.push({program:item.program,id:item.record.id}); }
      }
      for (const item of op.overrides) if (!item.completed) {
        for (const entry of op.records.filter(record=>record.program===item.program && record.record.date===item.date)) {
          const name=`${entry.program}:${entry.record.id}`, record=this.records.get(name);
          if (insertedRecords.some(id=>id.program===entry.program && id.id===entry.record.id)) this.records.set(name,{...record,revoked:true});
          else conflicts.push({program:entry.program,id:entry.record.id,date:item.date,reason:'existing_record_not_revoked'});
        }
      }
      result.import={sourceId:op.sourceId,insertedRecords,insertedSessions:[],revokedRecordIds:[],manualRecordIds:[],conflicts};
    } else throw Error(`Unhandled test operation: ${op.type}`);
    result=plain(result);
    if (result.session) delete result.session.token;
    this.receipts.set(op.operationId,{request:plain(op),result});
    if (this.dropType===op.type) { this.dropType=null; throw Error('response lost after server commit'); }
    if (this.hangType===op.type) return new Promise(resolve=>this.hanging.push(()=>resolve(this.response(200,result))));
    return this.response(200,result);
  }
}
let runtimeSerial=0;
function runtime({storage=new Storage(),api=new API(),mode='cloud',prefix='rehab-timer:v1',location={protocol:'https:',search:''},onChange,onStatus,timers={}}={}) {
  let clock=NOW,serial=0;
  const instance=++runtimeSerial;
  const context=vm.createContext({Date,Intl,Promise,console,location,AbortController});
  vm.runInContext(coreSource,context); vm.runInContext(source,context);
  const repo=context.RehabPersistence.create({storage,mode,prefix,fetch:api.fetch.bind(api),now:()=>clock,uuid:()=>`synthetic-${instance}-${String(++serial).padStart(12,'0')}`,onChange,onStatus,setTimeout,clearTimeout,...timers});
  const core=context.RehabCore;
  function snapshot(id='session-00000001',program=core.PROGRAM) { const e=new core.Engine(1000,program); e.start(id); e.arm(0); return plain(e.snapshot()); }
  function finish(id='session-00000001',program=core.PROGRAM) { const s=snapshot(id,program); s.index=core.programs[program].plan.length-1; s.remaining=0; s.state='finished'; s.completion={version:1,id,date:'2026-09-07',finishedAt:new Date(NOW).toISOString()}; return s; }
  return {repo,storage,api,core,snapshot,finish,advance(ms){clock+=ms;},store:repo.forProgram(core.PROGRAM),joint:repo.forProgram(core.JOINT_PROGRAM)};
}
async function started(options) { const f=runtime(options); await f.repo.init(); assert.equal(f.store.saveProgress(f.snapshot()),true); await f.repo.flush(); return f; }
function finishLocally(f,id='session-00000001',program=f.core.PROGRAM) {
  const store=f.repo.forProgram(program),snapshot=f.finish(id,program);
  assert.equal(store.saveProgress(snapshot,true),true); assert.equal(store.complete(snapshot.completion),true); assert.equal(store.saveProgress(null),true);
}

test('local、file 和测试参数强制隔离，不读取正式历史且不发送 API',async()=>{
  for (const args of [{mode:'local'},{location:{protocol:'file:',search:''}},{location:{protocol:'https:',search:'?test=1'}},{location:{protocol:'https:',search:'?debugMs=100'}},{prefix:'rehab-timer:test:v1:100'}]) {
    const f=runtime(args),record=f.finish().completion;
    f.storage.setItem(`rehab-timer:v1:done:${record.id}`,JSON.stringify(record));
    const before=f.storage.getItem(`rehab-timer:v1:done:${record.id}`);
    await f.repo.init(); assert.equal(f.repo.mode,'local'); assert.equal(f.repo.canStart(),true); assert.deepEqual(plain(f.store.history()),[]);
    assert.equal(f.store.saveProgress(f.snapshot()),true); finishLocally(f); await f.repo.flush();
    assert.equal(f.store.history().length,1); assert.equal(f.api.calls.length,0); assert.equal(f.storage.getItem(`rehab-timer:v1:done:${record.id}`),before);
    assert.equal(f.repo.scanLegacy().disabled,true); assert.equal((await f.repo.importLegacy()).ok,false);
  }
});

test('云完成只有收到服务端确认才标已同步，清当前进度保留待同步完成',async()=>{
  const f=await started(); f.api.offline=true; finishLocally(f);
  assert.equal(f.store.loadProgress(),null); assert.equal(f.store.history().length,1); assert.equal(f.repo.isSynced(f.core.PROGRAM,'session-00000001'),false);
  await f.repo.flush(); assert.equal(f.repo.status().state,'offline'); assert.ok(f.repo.status().pending>0);
  const reload=runtime({storage:f.storage,api:f.api}); await reload.repo.init(); assert.equal(reload.store.history().length,1);
  f.api.offline=false; await reload.repo.flush(); assert.equal(reload.repo.status().state,'synced'); assert.equal(reload.repo.isSynced(f.core.PROGRAM,'session-00000001'),true); assert.equal(f.api.records.size,1);
});

test('服务端已提交但响应丢失，刷新重试原operationId和原请求，不重复完成',async()=>{
  const f=await started(); f.api.dropType='complete'; finishLocally(f); await f.repo.flush();
  assert.equal(f.api.records.size,1); assert.equal(f.repo.status().state,'offline');
  const before=f.api.calls.filter(call=>call.body?.type==='complete').at(-1).body;
  const reload=runtime({storage:f.storage,api:f.api}); await reload.repo.init();
  assert.deepEqual(f.api.calls.filter(call=>call.body?.type==='complete').at(-1).body,before);
  assert.equal(reload.repo.status().pending,0); assert.equal(f.api.records.size,1);
});

test('12秒超时释放同步锁，忽略Abort的迟到响应不能ACK，重试保留相同操作',async()=>{
  let serial=0; const timers=new Map();
  const f=await started({timers:{setTimeout(fn,ms){assert.equal(ms,12000); timers.set(++serial,fn); return serial;},clearTimeout(id){timers.delete(id);}}});
  f.api.hangType='complete'; finishLocally(f); const pending=f.repo.flush();
  assert.equal(f.api.hanging.length,1); assert.equal(timers.size,1);
  [...timers.values()][0](); await pending;
  assert.equal(f.repo.status().state,'offline'); assert.match(f.repo.status().message,/超时/); assert.equal(timers.size,0);
  assert.ok(f.repo.status().pending>0); assert.equal(f.repo.isSynced(f.core.PROGRAM,'session-00000001'),false);
  assert.equal(f.api.lastSignal.aborted,true);
  f.api.hanging.shift()(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.ok(f.repo.status().pending>0,'a late response must not remove the outbox');
  f.api.hangType=null; await f.repo.flush();
  assert.equal(f.repo.status().state,'synced'); assert.equal(f.api.records.size,1); assert.equal(f.repo.status().pending,0);
});

test('每秒本地快照不触发云请求，10秒合并与状态边界才排队',async()=>{
  let changes=0;
  const f=await started({onChange:()=>changes++});
  const initial=f.api.calls.filter(call=>call.body?.type==='progress').length,changeCount=changes;
  for(let second=1;second<=9;second++) { f.advance(1000); assert.equal(f.store.saveProgress({...f.snapshot(),remaining:30000-second*1000}),true); }
  await Promise.resolve(); assert.equal(f.api.calls.filter(call=>call.body?.type==='progress').length,initial); assert.equal(changes,changeCount);
  f.advance(1000); f.store.saveProgress({...f.snapshot(),remaining:20000}); await f.repo.flush();
  assert.equal(f.api.calls.filter(call=>call.body?.type==='progress').length,initial+1);
  f.store.saveProgress({...f.snapshot(),remaining:19500,state:'paused'},true); await f.repo.flush();
  assert.equal(f.api.calls.filter(call=>call.body?.type==='progress').length,initial+2);
});

test('断网快照合并但完整完成操作独立保留，终态拒绝迟到进度',async()=>{
  const f=await started(); f.api.offline=true;
  for(let step=1;step<=3;step++) { f.advance(10000); f.store.saveProgress({...f.snapshot(),remaining:30000-step*1000}); }
  await f.repo.flush();
  const queued=[...f.storage.data].filter(([key])=>key.includes(':op:')).map(([,raw])=>JSON.parse(raw));
  assert.equal(queued.filter(op=>op.type==='progress').length,1);
  finishLocally(f); assert.equal(f.store.saveProgress(f.snapshot(),true),false);
  f.api.offline=false; await f.repo.flush(); assert.equal(f.api.records.size,1); assert.equal(f.api.sessions.get(`${f.core.PROGRAM}:session-00000001`).status,'completed');
});

test('取消仅针对已存在记录，同日新增仍点亮，两计划互不干扰',async()=>{
  const f=runtime({mode:'local'}); await f.repo.init();
  f.store.saveProgress(f.snapshot()); finishLocally(f);
  assert.equal(f.store.setDate('2026-09-07',false),true); assert.equal(f.store.history().length,0);
  f.store.saveProgress(f.snapshot('session-00000002')); finishLocally(f,'session-00000002'); assert.equal(f.store.history().length,1);
  assert.equal(f.joint.setDate('2026-09-07',true),true); assert.equal(f.joint.history()[0].source,'manual'); assert.equal(f.joint.history()[0].finishedAt,null);
  assert.equal(f.store.history()[0].id,'session-00000002'); assert.equal(f.store.setDate('2026-09-08',true),false);
});

test('云补记与按ID撤销有独立幂等操作，同日期新会话不会被覆盖',async()=>{
  const f=await started(); assert.equal(f.store.setDate('2026-09-07',true),true); await f.repo.flush();
  assert.equal(f.store.history()[0].source,'manual'); assert.equal(f.store.setDate('2026-09-07',false),true); await f.repo.flush(); assert.equal(f.store.history().length,0);
  finishLocally(f); await f.repo.flush(); assert.equal(f.store.history().length,1); assert.equal(f.api.records.size,2);
});

test('单一写入权变化后旧端停止同步，完成保留且可明确另存新会话',async()=>{
  const f=await started(); const other=runtime({api:f.api}); await other.repo.init();
  const claimed=await other.repo.claimSession('session-00000001',f.core.PROGRAM); assert.equal(claimed.state,'paused');
  finishLocally(f); await f.repo.flush(); assert.equal(f.repo.status().state,'conflict'); assert.equal(f.api.records.size,0);
  const conflict=f.repo.conflicts()[0]; assert.equal(conflict.canCopy,true);
  await f.repo.resolveConflict(conflict.id,'copy'); assert.equal(f.api.records.size,1); assert.equal(f.api.sessions.get(`${f.core.PROGRAM}:session-00000001`).status,'active');
  assert.notEqual([...f.api.records.values()][0].id,'session-00000001'); assert.equal(f.repo.status().pending,0);
});

test('选择保留云端结果先归档冲突，不能重新取得令牌覆盖服务器',async()=>{
  const f=await started(),other=runtime({api:f.api}); await other.repo.init(); await other.repo.claimSession('session-00000001');
  f.store.saveProgress({...f.snapshot(),state:'paused'},true); await f.repo.flush();
  const conflict=f.repo.conflicts()[0]; await f.repo.resolveConflict(conflict.id,'cloud');
  assert.equal(f.store.loadProgress(),null); assert.ok([...f.storage.data.keys()].some(key=>key.includes(':resolved:')));
  assert.equal(f.api.calls.filter(call=>call.body?.type==='claim').length,1);
});

test('另存意图持久化失败时不能排新完成，恢复存储后重试只另存一次',async()=>{
  const f=await started(),other=runtime({api:f.api}); await other.repo.init(); await other.repo.claimSession('session-00000001');
  finishLocally(f); await f.repo.flush(); const conflict=f.repo.conflicts()[0];
  const originalSet=f.storage.setItem.bind(f.storage); let failOnce=true;
  f.storage.setItem=(key,value)=>{
    if(failOnce && key.includes(':copy-intent:')) { failOnce=false; throw Error('copy intent not durable'); }
    originalSet(key,value);
  };
  await assert.rejects(f.repo.resolveConflict(conflict.id,'copy'),/not durable/); await f.repo.flush();
  assert.equal(f.api.records.size,0); assert.equal(f.repo.conflicts().length,1);
  await f.repo.resolveConflict(conflict.id,'copy'); assert.equal(f.api.records.size,1);
  assert.ok([...f.storage.data.keys()].some(key=>key.includes(':copy-intent:')));
});

test('两实例使用独立outbox键，另一计划的完成不会因刷新写缓存而丢失',async()=>{
  const f=await started(); const g=runtime({storage:f.storage,api:f.api}); await g.repo.init();
  g.joint.saveProgress(g.snapshot('joint-session-0001',g.core.JOINT_PROGRAM)); await g.repo.flush();
  f.api.offline=true; finishLocally(f); finishLocally(g,'joint-session-0001',g.core.JOINT_PROGRAM);
  await f.repo.flush(); await g.repo.flush();
  assert.ok(f.repo.status().pending>=2);
  const reload=runtime({storage:f.storage,api:f.api}); f.api.offline=false; await reload.repo.init();
  assert.equal(f.api.records.size,2); assert.equal(reload.store.history().length,1); assert.equal(reload.joint.history().length,1);
});

test('同一浏览器两个已恢复标签不能借共享缓存的新版本覆盖旧引擎进度',async()=>{
  const f=await started(),other=runtime({storage:f.storage,api:f.api}); await other.repo.init();
  assert.equal(other.store.loadProgress().id,'session-00000001');
  f.store.saveProgress({...f.snapshot(),remaining:20000,state:'paused'},true); await f.repo.flush();
  other.store.saveProgress({...other.snapshot(),remaining:29000,state:'paused'},true); await other.repo.flush();
  assert.equal(other.repo.status().state,'conflict');
  assert.equal(f.api.sessions.get(`${f.core.PROGRAM}:session-00000001`).snapshot.remaining,20000);
});

test('显式补记每次生成独立记录，兼容日期标记仍幂等',async()=>{
  const f=runtime({mode:'local'}); await f.repo.init();
  assert.equal(f.store.addManual('2026-09-07'),true); assert.equal(f.store.addManual('2026-09-07'),true);
  assert.equal(f.store.history().length,2); assert.equal(f.store.setDate('2026-09-07',true),true); assert.equal(f.store.history().length,2);
});

test('迁移扫描原始完成和false覆盖，损坏内容保留在备份且不上传',async()=>{
  const f=runtime(); await f.repo.init(); const record=f.finish().completion;
  f.storage.setItem(`rehab-timer:v1:done:${record.id}`,JSON.stringify(record));
  f.storage.setItem('rehab-timer:v1:date:2026-09-07','false');
  f.storage.setItem('rehab-timer:v1:done:broken-id','{broken');
  f.storage.setItem('rehab-timer:test:v1:100:done:do-not-import','{"secret":"test"}');
  const preview=f.repo.scanLegacy(); assert.deepEqual(plain(preview.counts),{records:1,overrides:1,progress:0,issues:1});
  const backup=JSON.parse(f.repo.backupLegacy()); assert.ok(backup.entries.some(entry=>entry.value==='{broken')); assert.equal(backup.entries.length,3);
  const result=await f.repo.importLegacy(preview); assert.equal(result.ok,true); assert.equal(f.store.history().length,0);
  assert.equal(f.api.records.size,1); assert.equal([...f.api.records.values()][0].revoked,true); assert.equal(f.storage.getItem('rehab-timer:v1:done:broken-id'),'{broken');
  await f.repo.importLegacy(preview); assert.equal(f.api.importCalls,1);
});

test('已存在同ID的云记录遇到旧false覆盖只报冲突，不撤销云记录',async()=>{
  const f=await started(); finishLocally(f); await f.repo.flush();
  const record=f.finish().completion;
  f.storage.setItem(`rehab-timer:v1:done:${record.id}`,JSON.stringify(record)); f.storage.setItem('rehab-timer:v1:date:2026-09-07','false');
  const result=await f.repo.importLegacy(); assert.equal(result.ok,true); assert.equal(result.conflicts.length,1); assert.equal(f.store.history().length,1);
  assert.equal(f.repo.status().state,'conflict'); assert.equal(f.repo.conflicts()[0].type,'import');
});

test('迁移预览后原数据改变必须重新预览，旧进度token和导入ID跨刷新稳定',async()=>{
  const f=runtime(); await f.repo.init(); f.storage.setItem('rehab-timer:v1:progress',JSON.stringify(f.snapshot()));
  const first=f.repo.scanLegacy(),reload=runtime({storage:f.storage,api:f.api}),second=reload.repo.scanLegacy();
  assert.equal(second.importId,first.importId); assert.equal(second.progress[0].writerToken,first.progress[0].writerToken);
  f.storage.setItem('rehab-timer:v1:date:2026-09-06','true');
  const result=await f.repo.importLegacy(first); assert.equal(result.ok,false); assert.match(result.message,/变化/); assert.equal(f.api.importCalls,0);
});

test('旧记录时间格式、未来时间、日期偏离和未知字段单独报告，不污染有效迁移',async()=>{
  const f=runtime(); await f.repo.init();
  const patches=[{finishedAt:'2026/09/07 12:00:00'},{finishedAt:'2026-09-08T10:00:00Z',date:'2026-09-08'},{date:'2026-08-01'},{unsupported:true}];
  patches.forEach((patch,index)=>{
    const record={...f.finish().completion,id:`legacy-bad-${index}`, ...patch};
    f.storage.setItem(`rehab-timer:v1:done:${record.id}`,JSON.stringify(record));
  });
  const record=f.finish().completion; f.storage.setItem(`rehab-timer:v1:done:${record.id}`,JSON.stringify(record));
  const scan=f.repo.scanLegacy(); assert.equal(scan.records.length,1); assert.equal(scan.issues.length,4);
  assert.equal(JSON.parse(f.repo.backupLegacy()).entries.length,5);
});

test('本地配额失败返回失败，不显示已同步、不删除完成outbox',async()=>{
  const f=await started(); f.storage.failWrite=true;
  assert.equal(f.store.saveProgress(f.finish(),true),false); assert.equal(f.store.complete(f.finish().completion),false); assert.equal(f.repo.status().state,'error');
  assert.equal(f.repo.isSynced(f.core.PROGRAM,'session-00000001'),false); assert.equal(f.api.records.size,0);
});

test('后端失败与口令错误不伪装成功，解锁后可以重试',async()=>{
  const api=new API(); api.locked=true; const f=runtime({api}); await f.repo.init();
  assert.equal(f.repo.status().state,'locked'); assert.equal(f.repo.canStart(),false);
  await f.repo.login('wrong'); assert.equal(f.repo.status().state,'locked');
  await f.repo.login('shared-test'); assert.equal(f.repo.canStart(),true);
  f.store.saveProgress(f.snapshot()); await f.repo.flush(); api.failType='complete'; finishLocally(f); await f.repo.flush();
  assert.equal(f.repo.status().state,'error'); assert.ok(f.repo.status().pending>0); assert.equal(f.api.records.size,0);
  api.failType=null; await f.repo.flush(); assert.equal(f.repo.status().state,'synced');
});

test('刷新加载的本地进度由真实引擎恢复为暂停，不消耗离线时间',async()=>{
  const f=await started(); f.store.saveProgress({...f.snapshot(),remaining:12345},true); await f.repo.flush();
  const reload=runtime({storage:f.storage,api:f.api}); const e=new reload.core.Engine();
  assert.equal(e.restore(reload.store.loadProgress()),true); assert.equal(e.state,'paused'); e.tick(999999999); assert.equal(e.remaining,12345);
});

test('旧版第5项快照经真实引擎映射，读取不改原值且再次保存不重复偏移',async()=>{
  const f=runtime({mode:'local'}); await f.repo.init();
  const legacy={...f.snapshot(),index:95,remaining:12345,state:'running'}; delete legacy.planRevision;
  const snapshotKey=`${f.repo.prefix}:snapshot:${f.core.PROGRAM}:${legacy.id}`;
  f.storage.setItem(snapshotKey,JSON.stringify(legacy)); f.storage.setItem(`${f.repo.prefix}:active:${f.core.PROGRAM}`,JSON.stringify(legacy.id));
  const restored=f.store.loadProgress(); assert.equal(restored.planRevision,2); assert.equal(restored.index,96); assert.equal(restored.remaining,12345);
  assert.deepEqual(JSON.parse(f.storage.getItem(snapshotKey)),legacy,'Reading preserves the original stored snapshot.');
  const engine=new f.core.Engine(); assert.equal(engine.restore(restored),true); assert.equal(engine.state,'paused'); assert.equal(engine.interval.round,2); assert.equal(engine.interval.kind,'work');
  assert.equal(f.store.saveProgress(restored,true),true); assert.equal(f.store.loadProgress().index,96);
  assert.equal(f.store.saveProgress({...restored,planRevision:999}),false);
});

test('迁移规范化两套旧进度，原始备份和稳定导入ID保持可核对',async()=>{
  const f=runtime(); await f.repo.init();
  const old={...f.snapshot('old-round-four-001'),index:99,remaining:23456,state:'paused'}; delete old.planRevision;
  const joint={...f.snapshot('old-joint-manual-001',f.core.JOINT_PROGRAM),index:f.core.jointPlan.length-1,remaining:0,state:'ready',planRevision:1};
  f.storage.setItem('rehab-timer:v1:progress',JSON.stringify(old)); f.storage.setItem('rehab-timer:v1:joint:progress',JSON.stringify(joint));
  const preview=f.repo.scanLegacy(); assert.equal(preview.progress.length,2); assert.equal(preview.issues.length,0);
  const original=preview.progress.find(item=>item.program===f.core.PROGRAM),lower=preview.progress.find(item=>item.program===f.core.JOINT_PROGRAM);
  assert.equal(original.snapshot.index,102); assert.equal(original.snapshot.planRevision,2); assert.equal(original.snapshot.remaining,23456);
  assert.equal(lower.snapshot.index,joint.index); assert.equal(lower.snapshot.planRevision,2); assert.equal(lower.snapshot.state,'ready');
  const backup=JSON.parse(f.repo.backupLegacy()); assert.deepEqual(JSON.parse(backup.entries.find(item=>item.key==='rehab-timer:v1:progress').value),old);
  const reload=runtime({storage:f.storage,api:f.api}); assert.equal(reload.repo.scanLegacy().importId,preview.importId);
  assert.equal(f.storage.getItem('rehab-timer:v1:progress'),JSON.stringify(old));
});
