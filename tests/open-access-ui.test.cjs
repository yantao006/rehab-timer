'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const appFixture=require('./app-fixture.cjs');

test('首次云端访问直接读取共享记录并开始训练，界面没有口令或锁定入口',async()=>{
  const calls=[];
  const f=appFixture({protocol:'https:',search:'',apiFetch:async(path,options)=>{
    calls.push({path,options});
    const input=options.body?JSON.parse(options.body):null;
    const data=path==='/api/state'?{ok:true,environment:'preview',records:[],sessions:[]}:
      {ok:true,operationId:input.operationId,session:{id:input.sessionId,program:input.program,status:'active',snapshot:input.snapshot,revision:1,writerEpoch:1}};
    return {ok:true,status:200,json:async()=>data};
  }});
  await f.advance(0);
  assert.equal(f.state().syncState,'synced');
  for(const id of ['unlockForm','unlockButton','sharedPassword','logoutButton'])assert.equal(f.elements.has(id),false);
  await f.click('openCloudButton');
  assert.doesNotMatch(f.elements.get('cloudStatus').textContent,/口令|解锁|登录/);
  await f.click('closeCloudButton');await f.click('startButton');await f.advance(500);
  assert.notEqual(f.state().runState,'idle');assert.equal(f.state().view,'training');
  assert.equal(f.elements.get('cloudPanel').hidden,true);
  assert.equal(calls.some(call=>call.path==='/api/operation'),true);
  assert.equal(calls.every(call=>!['/api/login','/api/logout'].includes(call.path)),true);
  assert.equal(calls.every(call=>call.options.credentials==='omit'),true);
});
