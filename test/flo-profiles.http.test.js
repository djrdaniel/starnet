/* Real runOnce host: OAuth schema, private-context isolation, forbidden tool and budget. */
'use strict';
const A=require('./_assert'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture');
(async()=>{
 const key='fixed-flo-profile-fixture-123456', preload=path.resolve(__dirname,'fixtures/flo-profile-provider.cjs');
 const fixture=SidecarFixture.create({prefix:'flo-profiles-',env:{STARNET_API_KEY:key,NODE_OPTIONS:'--require '+preload}}),ws=fixture.workspace;
 fs.mkdirSync(path.join(ws,'codex'),{recursive:true});
 const access='e30.'+Buffer.from(JSON.stringify({exp:9999999999})).toString('base64url')+'.fake';
 fs.writeFileSync(path.join(ws,'codex','tokens.json'),JSON.stringify({access_token:access,refresh_token:'unused-fixture',last_refresh:new Date().toISOString()}));
 fs.writeFileSync(path.join(ws,'agent.roster.json'),JSON.stringify({version:1,agents:[{agentId:'researcher',name:'RESEARCH',provider:'codex',model:'gpt-5.6-sol',approvalMode:'full',executionProfile:'this-computer',system:'PRIVATE_STATION_SENTINEL'}]}));
 fs.writeFileSync(path.join(ws,'_commander.dossier.json'),JSON.stringify({block:'PRIVATE_STATION_SENTINEL'}));
 await fixture.start();
 const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const run=async(profile,input)=>{
  const created=await(await fetch(fixture.baseUrl+'/v1/runs',{method:'POST',headers,body:JSON.stringify({model:'RESEARCH',input,capability_profile:profile})})).json();
  A.eq(created.capability_profile,profile,'real create echoes host profile');
  await(await fetch(fixture.baseUrl+'/v1/runs/'+created.run_id+'/events',{headers})).text();
  return(await fetch(fixture.baseUrl+'/v1/runs/'+created.run_id,{headers})).json();
 };
 try{
  const text=await run('flo-text','PROFILE_TEXT supplied text');A.eq(text.status,'completed','real text task completes');
  const research=await run('flo-research','PROFILE_RESEARCH read public evidence');A.eq(research.status,'completed','real public web task completes');
  A.eq(research.starnet.capability_receipt.tool_calls,1,'real host records one web dispatch');
  A.eq(research.starnet.capability_receipt.public_web_evidence[0].status,'read','real host receipt records a fetched page');
  A.ok(research.starnet.capability_receipt.tool_trace[0].excerpt.includes('Fixture public evidence about a product market.'),'real host receipt carries the actual public page text');
  A.ok(research.starnet.capability_receipt.sources[0].excerpt.includes('Fixture public evidence about a product market.'),'real host source excerpt carries the actual page text');
  A.ok(!JSON.stringify(research.starnet.capability_receipt).includes('PRIVATE_STATION_SENTINEL'),'private station context is absent from evidence receipts');
  const search=await run('flo-research','PROFILE_SEARCH gather public market evidence');
  A.eq(search.status,'completed','real public search task completes');
  A.eq(search.starnet.capability_receipt.tool_trace[0].status,'returned','real host labels returned public search evidence');
  A.ok(search.starnet.capability_receipt.tool_trace[0].excerpt.includes('Fixture public search snippet about demand.'),'real host search receipt carries actual snippets');
  A.ok(search.starnet.capability_receipt.sources[0].excerpt.includes('Fixture product market title'),'real host source excerpt carries its actual search title');
  A.ok(search.starnet.capability_receipt.sources[0].excerpt.includes('Fixture public search snippet about demand.'),'real host source excerpt carries its actual search snippet');
  A.ok(!JSON.stringify(search.starnet.capability_receipt).includes('PRIVATE_STATION_SENTINEL'),'private station context is absent from search receipts');
  const deny=await run('flo-text','PROFILE_DENY adversarial tool call');A.ok(deny.status!=='completed','malicious text call cannot falsely complete');
  A.eq(deny.starnet.capability_receipt.denied_calls,1,'host catches a provider-invented forbidden tool');
  A.ok(!fs.existsSync(path.join(ws,'researcher','MUST_NOT_WRITE.txt')),'Full Power does not widen the Flo profile');
  const limited=await run('flo-research','PROFILE_LIMIT bounded web calls');A.eq(limited.status,'limited','fifth call yields limited outcome');
  A.eq(limited.starnet.capability_receipt.tool_calls,4,'real host admits four web calls only');
  const models=fs.readFileSync(path.join(ws,'test-model.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  A.ok(models.every(r=>!r.privateLeak),'no private station persona/dossier reaches model');
  A.ok(models.filter(r=>r.mode==='text'||r.mode==='deny').every(r=>r.tools.length===0),'text wire exposes zero tools');
  A.ok(models.filter(r=>r.mode==='research'||r.mode==='search'||r.mode==='limit').every(r=>JSON.stringify(r.tools.sort())===JSON.stringify(['web_fetch','web_search'])),'research wire exposes only public readers');
  const web=fs.readFileSync(path.join(ws,'test-web.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  A.eq(web.length,6,'one page call, one search call and four bounded calls actually fetched');
  A.ok(web.every(r=>r.method==='GET'&&!r.headers.some(h=>/authorization|cookie/i.test(h))),'public fetch uses GET without credentials/cookies');
 }finally{await fixture.dispose();}
 A.report('flo-profiles.http.test');
})().catch(e=>{console.error(e);process.exitCode=1;});
