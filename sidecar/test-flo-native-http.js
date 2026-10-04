'use strict';

// Real loopback HTTP routing and bearer/host checks, with injected host actions.
// No station save, user keys, model provider or external connection is used.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const {makeOpenAiCompat}=require('./openai-compat');

async function fixture(t,{bridge=true}={}) {
  const calls=[],providerCalls=[];let serial=0;
  const key='isolated-native-http-fixture-12345';
  let snapshot={object:'starnet.station.operations',schema_version:1,operation:null,
    events:[],artifacts:[],workers:[{agent_id:'agent',name:'CHIEF OF STAFF'}],action_receipts:[],capabilities:{native:true,reasoning:'high'}};
  let artifactError=false;
  const bytes=Buffer.from('Verified isolated native prototype\n');
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const deps={now:()=>Date.parse('2026-10-04T09:00:00Z'),newId:()=>String(++serial),apiKey:()=>key,
    isAllowedHost:host=>/^127\.0\.0\.1:\d+$/.test(host || ''),
    roster:()=>[{agentId:'agent',name:'CHIEF OF STAFF',provider:'codex',model:'gpt-5.6-sol'}],
    readBody:async(req,max)=>{let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>max)throw Error('Fixture request body limit');}return body;},
    runOnce(args){providerCalls.push(args);args.emit('agent.run.start',{runId:args.runId});args.emit('agent.run.end',{reason:'done'});},
    redact:value=>value};
  if(bridge) {
    deps.stationOperations=(action,body,id)=>{
      calls.push({action,body,id});
      if(action==='snapshot')return snapshot;
      if(!body||Array.isArray(body)||body.confirm!==true||typeof body.request_id!=='string')return{ok:false,code:400,error:'Confirm an owner receipt'};
      if(action==='start') {
        if(typeof body.objective!=='string'||!body.objective.trim()||Object.keys(body).some(name=>!['objective','request_id','mode','confirm'].includes(name)))return{ok:false,code:400,error:'Invalid native objective'};
        snapshot={...snapshot,operation:{id:17,request_id:body.request_id,status:'running',objective:body.objective}};
      }else{
        if(!['pause','resume','stop'].includes(body.action)||Object.keys(body).some(name=>!['action','request_id','confirm'].includes(name)))return{ok:false,code:400,error:'Invalid native action'};
        if(id!==snapshot.operation?.id)return{ok:false,code:404,error:'Exact operation required'};
        snapshot={...snapshot,operation:{...snapshot.operation,status:{pause:'paused',resume:'running',stop:'stopped'}[body.action]},
          action_receipts:[...snapshot.action_receipts,{request_id:body.request_id,operation_id:id,action:body.action,status:'confirmed'}]};
      }
      return{ok:true,...snapshot};
    };
    deps.stationArtifact=(operationId,artifactId)=>{
      calls.push({action:'artifact',operationId,artifactId});
      if(artifactError)throw Error('Changed native file');
      if(operationId!==17||artifactId!=='a'.repeat(32))throw Error('Unknown native receipt');
      return{title:'prototype"\r\nInjected-Header: yes.md',bytes,sha256:sha};
    };
  }
  const api=makeOpenAiCompat(deps);
  const server=http.createServer((req,res)=>{if(!api.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
  return{base,headers,calls,providerCalls,bytes,sha,failArtifact(){artifactError=true;},
    get:(path,options={})=>fetch(base+path,{headers,...options}),
    post:(path,body,options={})=>fetch(base+path,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body),...options}),
    // Node fetch rewrites Host to its URL authority. Native http.request is
    // required to exercise the real hostile Host header on the wire.
    hostStatus:(route,method='GET')=>new Promise((resolve,reject)=>{
      const request=http.request(base+route,{method,headers:{...headers,Host:'remote.invalid'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
      request.on('error',reject);request.end(method==='POST'?'{}':undefined);
    })};
}

test('Every native read, action and artifact route enforces the exact bearer key and loopback host before host dispatch',async t=>{
  const f=await fixture(t);
  for(const path of ['/v1/station/operations','/v1/station/operations/17/artifacts/'+'a'.repeat(32)]) {
    assert.equal((await f.get(path,{headers:{}})).status,401);
    assert.equal((await f.get(path,{headers:{...f.headers,Authorization:'Bearer wrong-fixture-key'}})).status,401);
    assert.equal(await f.hostStatus(path),403);
  }
  for(const path of ['/v1/station/operations','/v1/station/operations/17/action']) {
    assert.equal((await f.post(path,{}, {headers:{}})).status,401);
    assert.equal(await f.hostStatus(path,'POST'),403);
  }
  assert.equal(f.calls.length,0);assert.equal(f.providerCalls.length,0);
});

test('Native GET is a read; confirmed start and numeric-ID action route to the host with their exact owner payload',async t=>{
  const f=await fixture(t);
  const status=await f.get('/v1/station/operations');assert.equal(status.status,200);
  assert.equal((await status.json()).operation,null);assert.deepEqual(f.calls,[{action:'snapshot',body:undefined,id:undefined}]);
  const body={objective:'A native prototype objective',request_id:'native-http-owner-start',confirm:true,mode:'once'};
  const start=await f.post('/v1/station/operations',body);assert.equal(start.status,200);
  const started=await start.json();assert.equal(started.object,'starnet.station.operations');assert.equal(started.operation.id,17);assert.equal(started.code,undefined);
  assert.deepEqual(f.calls[1],{action:'start',body,id:undefined});
  const pause={action:'pause',request_id:'native-http-owner-pause',confirm:true};
  const response=await f.post('/v1/station/operations/17/action',pause);assert.equal(response.status,200);
  const paused=await response.json();assert.equal(paused.operation.status,'paused');
  assert.deepEqual(paused.action_receipts,[{request_id:pause.request_id,operation_id:17,action:'pause',status:'confirmed'}]);
  assert.deepEqual(f.calls[2],{action:'action',body:pause,id:17});assert.equal(f.providerCalls.length,0);
});

test('Malformed JSON, missing consent and extra permissions are refused without model dispatch',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/v1/station/operations','{broken')).status,400);
  assert.equal(f.calls.length,0);
  for(const body of [{objective:'Work',request_id:'missing-confirm'},
    {objective:'Work',request_id:'extra-permission',confirm:true,full_access:true},[]]) {
    assert.equal((await f.post('/v1/station/operations',body)).status,400);
  }
  for(const path of ['/v1/station/operations/0/action','/v1/station/operations/17.0/action','/v1/station/operations/abc/action']) {
    const before=f.calls.length;assert.equal((await f.post(path,{action:'stop',confirm:true,request_id:'owner-invalid-target'})).status,404);assert.equal(f.calls.length,before);
  }
  assert.equal(f.providerCalls.length,0);
});

test('Native operation and artifact absence return unavailable rather than falling back to legacy agent runs',async t=>{
  const f=await fixture(t,{bridge:false});
  assert.equal((await f.get('/v1/station/operations')).status,503);
  assert.equal((await f.post('/v1/station/operations',{objective:'Work',request_id:'unavailable-start',confirm:true})).status,503);
  assert.equal((await f.get('/v1/station/operations/17/artifacts/'+'a'.repeat(32))).status,503);
  assert.equal(f.providerCalls.length,0);
});

test('Host-only native operator and child profiles cannot be started through direct /v1/runs or chat completions',async t=>{
  const f=await fixture(t);
  for(const capability_profile of ['flo-operator','flo-operator-worker']) {
    const denied=await f.post('/v1/runs',{input:'Bypass owner operation',model:'CHIEF OF STAFF',capability_profile});
    assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'host_only_profile');
    const chat=await f.post('/v1/chat/completions',{messages:[{role:'user',content:'Bypass owner operation'}],model:'CHIEF OF STAFF',capability_profile});
    assert.equal(chat.status,403,'a host-only profile must not silently become a legacy unrestricted chat run');
    assert.equal((await chat.json()).error.code,'host_only_profile');
  }
  assert.equal(f.providerCalls.length,0);assert.equal(f.calls.length,0);
});

test('Native downloads preserve verified bytes and SHA, sanitize disposition and refuse changed or arbitrary file identifiers',async t=>{
  const f=await fixture(t),route='/v1/station/operations/17/artifacts/'+'a'.repeat(32);
  const response=await f.get(route);assert.equal(response.status,200);
  assert.equal(response.headers.get('x-content-sha256'),f.sha);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('injected-header'),null);
  assert.match(response.headers.get('content-disposition'),/^attachment; filename="[A-Za-z0-9_. -]+"$/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  assert.deepEqual(f.calls.at(-1),{action:'artifact',operationId:17,artifactId:'a'.repeat(32)});
  f.failArtifact();assert.equal((await f.get(route)).status,409);
  const before=f.calls.length;
  for(const suffix of ['../../secret','%2e%2e%2fsecret','a'.repeat(31),'g'.repeat(32),'a'.repeat(32)+'%2fsecret'])assert.equal((await f.get('/v1/station/operations/17/artifacts/'+suffix)).status,404);
  assert.equal(f.calls.length,before);assert.equal(f.providerCalls.length,0);
});
