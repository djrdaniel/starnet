/* Deterministic /v1 contract; no provider, secret or outside network. */
'use strict';
const assert=require('node:assert/strict'), http=require('node:http');
const {makeOpenAiCompat}=require('../sidecar/openai-compat');
(async()=>{
 let calls=[], serial=0;
 const key='flo-profile-test-key-123456';
 const api=makeOpenAiCompat({now:()=>1000,newId:()=>String(++serial),apiKey:()=>key,
  roster:()=>[{agentId:'researcher',name:'RESEARCH',provider:'codex',model:'gpt-5.6-sol'}],
  readBody:async req=>{let s='';for await(const c of req)s+=c;return s;},
  runOnce:o=>{calls.push(o);o.emit('agent.run.start',{runId:o.runId});
   if(o.capabilityProfile==='flo-research') {
    for(let i=0;i<5;i++) {const args={url:'https://example.com/'+i};const c=o.floCapabilityGuard.start('web_fetch',args);if(c.ok)o.floCapabilityGuard.finish(c.sequence,'web_fetch',args,{ok:true,summary:'22 chars via direct',content:'Evidence actually returned'});}
   }
   o.emit('agent.token',{delta:'Actual worker result'});o.emit('agent.run.end',{reason:'done'});
  }
 });
 const server=http.createServer((req,res)=>api.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const post=body=>fetch(base+'/v1/runs',{method:'POST',headers,body:JSON.stringify(body)});
 try {
  assert.equal((await fetch(base+'/v1/capabilities')).status,401,'capabilities requires bearer');
  const caps=await(await fetch(base+'/v1/capabilities',{headers})).json();
  assert.equal(caps.capability_profiles.length,2);assert.deepEqual(caps.capability_profiles[1].tools,['web_search','web_fetch']);
  for(const p of ['full',null,'']) {assert.equal((await post({input:'task',model:'RESEARCH',capability_profile:p})).status,400);}
  assert.equal(calls.length,0,'unknown profiles never dispatch');
  assert.equal((await post({input:'task',capability_profile:'flo-research'})).status,400,'unnamed non-OAuth worker is refused');
  for(const profile of ['flo-text','flo-research']) {
   const started=await(await post({input:'task',model:'RESEARCH',capability_profile:profile})).json();assert.equal(started.capability_profile,profile);
   await(await fetch(base+'/v1/runs/'+started.run_id+'/events',{headers})).text();
   const state=await(await fetch(base+'/v1/runs/'+started.run_id,{headers})).json();
   assert.equal(state.capability_profile,profile);assert.equal(state.starnet.capability_receipt.capability_profile,profile);
   const o=calls.at(-1);assert.equal(o.provider,'codex');assert.equal(o.surface,'autonomous');assert.equal(o.reflect,false);assert.deepEqual(o.fallbackModels,[]);assert.deepEqual(o.fallbackProviders,[]);
   assert.equal(o.isTask,profile==='flo-research');assert.equal(o.maxIters,profile==='flo-research'?8:1);
   if(profile==='flo-research'){assert.equal(state.status,'limited');assert.equal(state.starnet.completed,false);assert.equal(state.starnet.capability_receipt.tool_calls,4);assert.equal(state.starnet.capability_receipt.tool_trace[0].excerpt,'Evidence actually returned');assert.equal(state.starnet.capability_receipt.sources[0].excerpt,'Evidence actually returned');}
   else {assert.equal(state.status,'completed');assert.equal(state.starnet.capability_receipt.tool_calls,0);}
  }
  const legacy=await(await post({input:'legacy'})).json();await(await fetch(base+'/v1/runs/'+legacy.run_id+'/events',{headers})).text();assert.equal(calls.at(-1).capabilityProfile,undefined,'omitted profile remains compatible');
  console.log('flo-profiles.api: contract, auth, profile rejection, OAuth wiring, receipt and limited outcome passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
