'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {makeFloNativeCommerce,ENDPOINT,MAX_BYTES,PROPOSAL_ENDPOINT,MAX_PROPOSAL_BYTES,MAX_PROPOSAL_ARTIFACTS}=require('../sidecar/flo-native-commerce');
const {makeRegistry}=require('../sidecar/tools/registry');
const {makeCapCtx}=require('../sidecar/capability/capGate');
const profiles=require('../sidecar/flo-capability-profile');
const record={object:'flo.native.commerce_context',read_only:true,schema_version:1,source:{kind:'saved_local_flo_state',live_store_request:false},stores:{etsy:{verified:true,scope:'read only'}},products:[]};
test('Commerce reads only the fixed Flo endpoint with host authentication and no redirect',async()=>{
  const calls=[];
  const reader=makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(record));}});
  const read=await reader.read();assert.equal(read.ok,true);assert.deepEqual(JSON.parse(read.content),record);
  assert.equal(calls.length,1);assert.equal(calls[0].url,ENDPOINT);assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].options.headers.Authorization,/^Bearer /);
  assert.equal(read.content.includes('synthetic-test-bearer'),false);
});
test('Unverified, malformed, oversized and failed replies report unavailable without exposing their bytes or credentials',async()=>{
  for(const response of [new Response('private-response-bytes',{status:403}),new Response('private-response-bytes'),new Response(JSON.stringify({...record,read_only:false})),new Response('x'.repeat(MAX_BYTES+1))]){
    const read=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async()=>response}).read();
    assert.equal(read.ok,false);assert.equal(read.content.includes('private-response-bytes'),false);assert.equal(read.content.includes('synthetic-test-bearer'),false);
  }
});
test('No credential means no request; thrown local transport errors remain unavailable and never imply store authority',async()=>{
  let calls=0;
  assert.equal((await makeFloNativeCommerce({key:()=>'',fetch:async()=>{calls++;}}).read()).ok,false);assert.equal(calls,0);
  const read=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async()=>{throw Error('secret-transport-detail');}}).read();
  assert.equal(read.ok,false);assert.equal(read.content.includes('secret-transport-detail'),false);
});
const artifact='a'.repeat(32), evidence='b'.repeat(32);
const proposalArgs={channel:'itch',intent:'package',target:{username:'fixture-owner',project_slug:'fixture-product',channel:'assets'},
  fields:{title:'Original fixture icons',price:'3.99',currency:'GBP',licence:'Original buyer licence'},artifact_ids:[artifact,evidence],
  buyer_artifact_ids:[artifact],evidence:{rights:{statement:'These fixture files are original and reviewed.',artifact_id:evidence}}};
const host={operation_id:7,run_id:'actual-host-parent-run',call_id:'tool:actual-staging-call'};
function staged(payload,patch={}){return {object:'flo.native.commerce_proposal',schema_version:1,source:{kind:'saved_local_flo_state',live_store_request:false},
  proposal:{id:3,revision:'d'.repeat(64),target:payload.target,channel:payload.channel,intent:payload.intent,operation_id:payload.operation_id,run_id:payload.run_id,status:'staged',external_status:'not_requested'},duplicate:false,...patch};}
test('Actual registered proposal tool uses only fixed local POST and host call provenance; workers remain denied',async()=>{
  const calls=[],registry=makeRegistry();
  const commerce=makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,fetch:async(url,options)=>{
    const payload=JSON.parse(options.body);calls.push({url,options,payload});return new Response(JSON.stringify(staged(payload)));}});
  commerce.register(registry);
  const resolved={agentId:'agent',room:'office',hasCompute:true,tools:['commerce.read','commerce.propose'],deferred:[],grants:[],approvalRules:{}};
  const lead=makeCapCtx(profiles.restrict(resolved,profiles.resolve('flo-operator')),{consent:async()=>({allow:true,mode:'once'})});
  const result=await registry.dispatch({id:'call',name:'commerce.propose',args:proposalArgs},lead);
  assert.equal(result.ok,true);assert.equal(result.isError,false);assert.equal(calls.length,1);
  const wire=calls[0];assert.equal(wire.url,PROPOSAL_ENDPOINT);assert.equal(wire.options.method,'POST');assert.equal(wire.options.redirect,'error');
  assert.equal(wire.payload.operation_id,host.operation_id);assert.equal(wire.payload.run_id,host.run_id);assert.match(wire.payload.request_id,/^native-[a-f0-9]{64}$/);
  await commerce.propose({...proposalArgs,operation_id:999,run_id:'model-invented',request_id:'model-invented',
    approved:true,confirm:true,source:{kind:'invented'},publish_now:true});
  const stripped=calls[1].payload;assert.equal(stripped.operation_id,host.operation_id);assert.equal(stripped.run_id,host.run_id);
  for(const key of ['approved','confirm','source','publish_now'])assert.equal(Object.hasOwn(stripped,key),false);
  assert.deepEqual(wire.payload.buyer_artifact_ids,[artifact]);assert.ok(!result.content.includes('synthetic-test-bearer'));
  await commerce.propose(proposalArgs);assert.equal(calls[2].payload.request_id,wire.payload.request_id,'Exact tool identity replays the same local staging request.');
  const forged=await registry.dispatch({id:'forged',name:'commerce.propose',args:{...proposalArgs,approved:true,operation_id:999}},lead);
  assert.equal(forged.isError,true);assert.equal(calls.length,3,'The real schema rejects model approval/provenance before transport.');
  const worker=makeCapCtx(profiles.restrict(resolved,profiles.resolve('flo-operator-worker')),{consent:async()=>({allow:true})});
  const refused=await registry.dispatch({id:'child',name:'commerce.propose',args:proposalArgs},worker);assert.equal(refused.isError,true);assert.equal(calls.length,3);
});
test('Registered local package proposal accepts truthful draft licence/price before owner approval and requests no external release',async()=>{
  const registry=makeRegistry(),calls=[];
  makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,fetch:async(url,options)=>{
    const payload=JSON.parse(options.body);calls.push({url,options,payload});return new Response(JSON.stringify(staged(payload)));
  }}).register(registry);
  const lead=makeCapCtx(profiles.restrict({agentId:'agent',room:'office',hasCompute:true,tools:['commerce.propose'],grants:[],approvalRules:{}},
    profiles.resolve('flo-operator')),{consent:async()=>({allow:true,mode:'once'})});
  const args={...proposalArgs,fields:{...proposalArgs.fields,description:'Original verified vectors and rendered PNGs for local review.',
    licence:'DRAFT licence for owner review: commercial project use is proposed; redistribution is prohibited. These terms are not owner-approved.',price:'3.99'},
    evidence:{rights:{statement:'Original geometry is supported by the attached source document; owner rights attestation remains pending.',artifact_id:evidence}}};
  const before=JSON.stringify(args),result=await registry.dispatch({id:'draft-terms-local-stage',name:'commerce.propose',args},lead);
  assert.equal(result.isError,false,result.content);assert.equal(calls.length,1);assert.equal(calls[0].url,PROPOSAL_ENDPOINT);
  assert.equal(calls[0].options.method,'POST');assert.deepEqual(calls[0].payload.fields,args.fields);assert.deepEqual(calls[0].payload.evidence,args.evidence);
  assert.equal(JSON.stringify(args),before,'The source draft terms and selected files are preserved.');
  const saved=JSON.parse(result.content);assert.equal(saved.proposal.status,'staged');assert.equal(saved.proposal.external_status,'not_requested');
  assert.ok(!Object.hasOwn(calls[0].payload,'approved'));assert.ok(!Object.hasOwn(calls[0].payload,'confirm_upload'));
  const tool=registry.get('commerce.propose');assert.equal(tool.scope,'write');assert.equal(tool.requiresConsent,true);
  for(const phrase of ['BEFORE owner approval','PROPOSED licence and price','exact buyer ZIP','Flo notifications','task-only licence gate',
    'Reviewer Markdown cannot forbid','never edits a shop','separate verified connector and owner approval'])assert.ok(tool.description.includes(phrase));
});
test('Missing host context, malformed field/intent or no buyer selection fails before any transport',async()=>{
  let calls=0;const fetch=async()=>{calls++;throw Error('must not request');};
  for(const args of [{...proposalArgs,fields:{password:'private'}},{...proposalArgs,intent:'buy'},{...proposalArgs,buyer_artifact_ids:[]},
    {...proposalArgs,buyer_artifact_ids:['c'.repeat(32)]},{...proposalArgs,artifact_ids:['outside/path']},{...proposalArgs,fields:{description:'x'.repeat(MAX_PROPOSAL_BYTES)}}]){
    assert.equal((await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,fetch}).propose(args)).ok,false);
  }
  for(const context of [undefined,()=>({...host,operation_id:0}),()=>({...host,call_id:''}),()=>({...host,run_id:'../private'})]){
    assert.equal((await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context,fetch}).propose(proposalArgs)).ok,false);
  }
  assert.equal(calls,0);
});
test('Only proven inert local proposal replies succeed; malformed/oversized/failed replies never leak or retry',async()=>{
  const good=staged({...proposalArgs,...host});
  const variants=[new Response('private-reply-detail',{status:409}),new Response('private-reply-detail'),new Response('x'.repeat(MAX_PROPOSAL_BYTES+1)),
    new Response(JSON.stringify({...good,source:{kind:'live_remote_store',live_store_request:true}})),
    new Response(JSON.stringify({...good,proposal:{...good.proposal,revision:1}})),
    new Response(JSON.stringify({...good,proposal:{...good.proposal,operation_id:999}})),
    new Response(JSON.stringify({...good,proposal:{...good.proposal,target:{...good.proposal.target,username:'other-account'}}})),
    new Response(JSON.stringify({...good,proposal:{...good.proposal,status:'published',external_status:'published'}}))];
  for(const response of variants){let calls=0;const read=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,
    fetch:async()=>{calls++;return response;}}).propose(proposalArgs);assert.equal(read.ok,false);assert.equal(calls,1);
    assert.ok(!read.content.includes('private-reply-detail'));assert.ok(!read.content.includes('synthetic-test-bearer'));assert.match(read.content,/no automatic retry/i);}
});
test('The actual pack-size schema accepts 96 verified IDs and keeps buyer files separate; 97 fails before transport',async()=>{
  assert.equal(MAX_PROPOSAL_ARTIFACTS,96);const ids=Array.from({length:96},(_,i)=>(i+1).toString(16).padStart(32,'0'));
  const args={...proposalArgs,artifact_ids:ids,buyer_artifact_ids:ids.slice(0,80),evidence:{rights:{statement:'Synthetic original pack evidence for owner review.',artifact_id:ids[95]}}};
  const registry=makeRegistry();let calls=0;let received;
  makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,fetch:async(_url,options)=>{
    calls++;received=JSON.parse(options.body);const reply=staged(received);reply.metadata_omitted_for_size=true;
    reply.proposal.manifest_count=96;reply.proposal.buyer_file_count=80;return new Response(JSON.stringify(reply));}}).register(registry);
  const resolved={agentId:'agent',room:'office',hasCompute:true,tools:['commerce.propose'],deferred:[],grants:[],approvalRules:{}};
  const lead=makeCapCtx(profiles.restrict(resolved,profiles.resolve('flo-operator')),{consent:async()=>({allow:true,mode:'once'})});
  const actual=await registry.dispatch({id:'full-pack',name:'commerce.propose',args},lead);
  assert.equal(actual.isError,false);assert.equal(calls,1);assert.equal(received.artifact_ids.length,96);assert.equal(received.buyer_artifact_ids.length,80);
  assert.ok(!received.buyer_artifact_ids.includes(ids[95]),'Research/rights/contact-sheet files are not inferred buyer files.');
  const tooMany=await registry.dispatch({id:'over-limit',name:'commerce.propose',args:{...args,artifact_ids:[...ids,'f'.repeat(32)]}},lead);
  assert.equal(tooMany.isError,true,JSON.stringify(tooMany));assert.equal(calls,1);assert.ok(Buffer.byteLength(JSON.stringify(received))<MAX_PROPOSAL_BYTES);
});
test('The real registry records transport/provenance refusals as errors, including its read tool',async()=>{
  const registry=makeRegistry();let calls=0;
  makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,fetch:async()=>{calls++;return new Response('private-unverified',{status:409});}}).register(registry);
  const resolved={agentId:'agent',room:'office',hasCompute:true,tools:['commerce.read','commerce.propose'],deferred:[],grants:[],approvalRules:{}};
  const lead=makeCapCtx(profiles.restrict(resolved,profiles.resolve('flo-operator')),{consent:async()=>({allow:true,mode:'once'})});
  for(const name of ['commerce.read','commerce.propose']){
    const reply=await registry.dispatch({id:name,name,args:name==='commerce.read'?{}:proposalArgs},lead);
    assert.equal(reply.ok,false);assert.equal(reply.isError,true);assert.ok(!reply.content.includes('private-unverified'));
  }
  assert.equal(calls,2);
});
test('Exact duplicate returns saved reviewed/external outcomes honestly without re-staging or external action',async()=>{
  const old=staged({...proposalArgs,...host});old.duplicate=true;old.proposal.status='reviewed_local';old.proposal.external_status='confirmed';
  let calls=0;const result=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,
    fetch:async(url,options)=>{calls++;assert.equal(url,PROPOSAL_ENDPOINT);assert.equal(options.method,'POST');return new Response(JSON.stringify(old));}}).propose(proposalArgs);
  assert.equal(result.ok,true);assert.equal(calls,1);assert.match(result.summary,/Existing commerce proposal read: reviewed_local \/ confirmed/);
  assert.deepEqual(JSON.parse(result.content),old);
});
test('The proposal transport stops at its real five second deadline and does not retry',async()=>{
  let calls=0;const at=Date.now();const result=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',context:()=>host,
    fetch:async(_url,options)=>{calls++;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('private-timeout-detail')),{once:true}));}}).propose(proposalArgs);
  assert.equal(result.ok,false);assert.equal(calls,1);assert.ok(Date.now()-at>=4900);assert.ok(Date.now()-at<8000);assert.ok(!result.content.includes('private-timeout-detail'));
});
