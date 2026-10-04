'use strict';

// Isolated real durable-store tests. All model runs and clocks are injected;
// these tests never use the owner's station, OAuth connection or paid providers.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {writeFileDurable}=require('./durable-write');
const {makeFloNativeOperations,LIMITS}=require('./flo-native-operations');

const flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
function clock() {
  let time=Date.parse('2026-10-04T09:00:00Z'),sequence=0;
  const timers=new Map();
  return {
    now:()=>time,
    setTimeout(fn,delay){const token={id:++sequence,unref(){}};timers.set(token,{fn,at:time+Math.max(0,Number(delay)||0)});return token;},
    clearTimeout(token){timers.delete(token);},
    timers,
    async advance(ms){
      const target=time+ms;
      for(let limit=0;limit<1000;limit++) {
        const next=[...timers.entries()].filter(([,task])=>task.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        time=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
        if(limit===999)throw Error('Fixture timer runaway');
      }
      time=target;await flush();
    }
  };
}
function fixture(t) {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'flo-native-operations-test-'));
  const time=clock(),runs=[],enrollments=[],verified=[];
  let failure=false,runImpl=async()=>({reason:'done',text:'Verified injected station result',artifacts:[]});
  let artifactImpl=async()=>({sha256:'a'.repeat(64),size:5,bytes:Buffer.from('hello')});
  const instances=[];
  const deps={fs,path,workspaces:workspace,now:time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,
    newId:(()=>{let id=0;return()=>String(++id).padStart(8,'0');})(),
    writeDurable(io,file,data){
      if(failure===true)throw Error('Injected durable admission write failure');
      const result=writeFileDurable(io,file,data);
      if(failure==='after-main'&&file===path.join(workspace,'_flo.native-operations.json'))throw Error('Injected failure after durable admission write');
      return result;
    },
    workers:()=>[{agent_id:'agent',name:'CHIEF OF STAFF'},{agent_id:'maker',name:'PROTOTYPE MAKER'}],
    enroll(){enrollments.push({at:time.now()});},
    async run(args){runs.push(args);return runImpl(args);},
    async verifyArtifact(agent,filename,includeBytes){verified.push({agent,filename,includeBytes});return artifactImpl(agent,filename,includeBytes);},
    redact:value=>value};
  const create=()=>{const value=makeFloNativeOperations(deps);instances.push(value);return value;};
  t.after(()=>{for(const value of instances)value.close();assert.ok(workspace.startsWith(path.join(os.tmpdir(),'flo-native-operations-test-')));fs.rmSync(workspace,{recursive:true,force:true});});
  return {workspace,time,runs,enrollments,verified,create,deps,setRun(fn){runImpl=fn;},setArtifact(fn){artifactImpl=fn;},failWrites(value){failure=value;}};
}
const startBody=(request_id='owner-native-start',mode='ongoing')=>({request_id,confirm:true,objective:'Build the real station and save a useful prototype',mode});
const actionBody=(action,request_id='owner-native-action')=>({request_id,confirm:true,action});

test('An owner start survives a real ledger reopen and replay never enrolls or starts a second run',async t=>{
  const f=fixture(t),operations=f.create();
  assert.equal(f.runs.length,0);assert.equal(operations.snapshot().operation,null);
  const first=operations.start(startBody());assert.equal(first.ok,true);assert.equal(first.operation.id,1);
  const duplicate=operations.start(startBody());assert.equal(duplicate.replayed,true);assert.equal(duplicate.operation.id,1);
  assert.equal(f.enrollments.length,1);assert.equal(f.runs.length,0);
  const changed=operations.start({...startBody(),objective:'A different instruction'});assert.equal(changed.code,409);
  operations.close();
  const reopened=f.create();assert.equal(reopened.snapshot().operation.request_id,'owner-native-start');
  assert.equal(reopened.start(startBody()).replayed,true);assert.equal(f.enrollments.length,1);assert.equal(f.runs.length,0);
  assert.equal(reopened.start(startBody('new-owner-start')).code,409);
});

test('Pause, resume and stop each persist their exact operation/action/request receipt and refuse conflicting replay',t=>{
  const f=fixture(t),operations=f.create(),id=operations.start(startBody()).operation.id;
  for(const [action,token] of [['pause','owner-pause-1'],['resume','owner-resume-1'],['stop','owner-stop-1']]) {
    const result=operations.action(id,actionBody(action,token));assert.equal(result.ok,true);
    assert.deepEqual(result.action_receipt,{request_id:token,operation_id:id,action,status:'confirmed',ts:f.time.now()});
    assert.equal(operations.action(id,actionBody(action,token)).replayed,true);
    assert.equal(operations.action(id+1,actionBody(action,token)).code,409);
    assert.equal(operations.action(id,actionBody(action==='stop'?'pause':'stop',token)).code,409);
  }
  const saved=operations.snapshot();assert.equal(saved.operation.status,'stopped');assert.equal(saved.action_receipts.length,3);
  assert.equal(f.runs.length,0);
  assert.equal(operations.action(id,actionBody('resume','after-stop-resume')).code,409);
  operations.close();const reopened=f.create();assert.deepEqual(reopened.snapshot().action_receipts,saved.action_receipts);
});

test('A receipt older than the display retention window cannot replay an old pause against newly resumed work',t=>{
  const f=fixture(t),operations=f.create(),id=operations.start(startBody()).operation.id;
  const original=actionBody('pause','old-owner-pause-receipt');
  assert.equal(operations.action(id,original).ok,true);
  for(let n=0;n<51;n++) {
    assert.equal(operations.action(id,actionBody('resume','retention-resume-'+n)).ok,true);
    if(n<50)assert.equal(operations.action(id,actionBody('pause','retention-pause-'+n)).ok,true);
  }
  const before=operations.snapshot();assert.equal(before.operation.status,'running');
  assert.equal(before.action_receipts.some(row=>row.request_id===original.request_id),false);
  const result=operations.action(id,original);
  assert.ok(result.replayed || result.code===409 || result.code===410,'the old receipt must remain known or explicitly retired');
  assert.equal(operations.snapshot().operation.status,'running','receipt trimming must not readmit an old pause');
  assert.equal(operations.snapshot().operation.event_sequence,before.operation.event_sequence);
  assert.equal(f.runs.length,0);
});

test('Pausing active work aborts its signal and blocks resume until the cancelled pass has actually settled',async t=>{
  const f=fixture(t);let finish;
  f.setRun(args=>new Promise(resolve=>{finish=()=>resolve({reason:'cancelled',text:'Partial saved work',artifacts:[]});args.emit('agent.run.start',{agentId:'maker',runId:'child-active'});}));
  const operations=f.create(),id=operations.start(startBody()).operation.id;
  await f.time.advance(0);assert.equal(f.runs.length,1);assert.equal(operations.snapshot().workers.find(w=>w.agent_id==='maker').status,'working');
  const paused=operations.action(id,actionBody('pause','owner-active-pause'));assert.equal(paused.ok,true);
  assert.equal(f.runs[0].signal.aborted,true);assert.equal(operations.snapshot().operation.status,'paused');
  assert.equal(operations.action(id,actionBody('resume','too-early-resume')).code,409);
  finish();await flush();assert.equal(operations.snapshot().operation.status,'paused');assert.equal(operations.snapshot().operation.run_id,null);
  const resumed=operations.action(id,actionBody('resume','owner-settled-resume'));assert.equal(resumed.ok,true);
  assert.equal(f.runs.length,1);
});

test('A clean ongoing pass schedules a new assessment; restarting between passes preserves the saved due time',async t=>{
  const f=fixture(t),operations=f.create();operations.start(startBody());await f.time.advance(0);
  assert.equal(f.runs.length,1);const saved=operations.snapshot().operation;
  assert.equal(saved.status,'running');assert.equal(saved.run_id,null);assert.equal(saved.pass_count,1);
  assert.equal(saved.next_at,f.time.now()+LIMITS.next_pass_ms);
  operations.close();const reopened=f.create();assert.equal(f.time.timers.size,0);
  assert.equal(reopened.snapshot().operation.next_at,saved.next_at);reopened.recover();
  await f.time.advance(LIMITS.next_pass_ms-1);assert.equal(f.runs.length,1);
  await f.time.advance(1);assert.equal(f.runs.length,2);
  assert.equal(reopened.snapshot().operation.pass_count,2);
  assert.notEqual(f.runs[0].runId,f.runs[1].runId);
});

test('Restarting during an interrupted pass preserves its run receipt and enters attention without replaying provider work',async t=>{
  const f=fixture(t);f.setRun(()=>new Promise(()=>{}));
  const operations=f.create();operations.start(startBody());await f.time.advance(0);
  assert.equal(f.runs.length,1);const oldRun=operations.snapshot().operation.run_id;assert.ok(oldRun);
  operations.close();assert.equal(f.runs[0].signal.aborted,true);
  const restarted=f.create();restarted.recover();const recovered=restarted.snapshot().operation;
  assert.equal(recovered.status,'attention');assert.equal(recovered.run_id,null);assert.equal(recovered.next_at,null);
  assert.equal(recovered.interrupted_run_id,oldRun);assert.equal(recovered.pass_count,1);
  assert.match(recovered.message,/restarted during a pass/);
  await f.time.advance(LIMITS.next_pass_ms*2);assert.equal(f.runs.length,1);
});

test('Recovered backup never restarts work when the latest saved owner pause has been lost',async t=>{
  const f=fixture(t),operations=f.create(),id=operations.start(startBody()).operation.id;
  await f.time.advance(0);assert.equal(f.runs.length,1);
  assert.equal(operations.snapshot().operation.status,'running');
  assert.equal(operations.action(id,actionBody('pause','owner-pause-before-torn-ledger')).ok,true);
  assert.equal(operations.snapshot().operation.status,'paused');operations.close();
  // Crash-safe writes retain the preceding good document. It is older than
  // this owner pause, so blindly resuming it would silently undo their intent.
  const file=path.join(f.workspace,'_flo.native-operations.json');
  const backup=JSON.parse(fs.readFileSync(file+'.bak','utf8'));
  assert.equal(backup.value.operations.at(-1).status,'running');
  fs.writeFileSync(file,'{torn newest owner pause');
  const recovered=f.create();assert.equal(recovered.snapshot().ledger_status,'recovered');
  recovered.recover();const state=recovered.snapshot().operation;
  assert.equal(state.status,'attention');assert.equal(state.next_at,null);
  assert.match(state.message,/recover|backup|verify|inspect|review/i);
  await f.time.advance(LIMITS.next_pass_ms*2);assert.equal(f.runs.length,1,'recovered stale state cannot undo the owner pause');
});

test('Corrupt ledger bytes fail closed and are preserved instead of admitting an empty new operation',t=>{
  const f=fixture(t),file=path.join(f.workspace,'_flo.native-operations.json');
  fs.writeFileSync(file,'{broken main');fs.writeFileSync(file+'.bak','{broken backup');
  const operations=f.create();assert.equal(operations.snapshot().ledger_status,'corrupt');
  assert.equal(operations.start(startBody()).code,503);operations.recover();
  assert.equal(f.enrollments.length,0);assert.equal(f.runs.length,0);assert.equal(f.time.timers.size,0);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken main');assert.equal(fs.readFileSync(file+'.bak','utf8'),'{broken backup');
});

test('Malformed durable action receipts make the ledger invalid rather than crashing a later owner control',t=>{
  const f=fixture(t),file=path.join(f.workspace,'_flo.native-operations.json');
  fs.writeFileSync(file,JSON.stringify({version:1,value:{next_id:1,operations:[],action_receipts:[null]}}));
  const operations=f.create();
  assert.equal(operations.snapshot().ledger_status,'invalid');
  assert.equal(operations.start(startBody()).code,503);assert.equal(f.enrollments.length,0);
  assert.equal(operations.action(1,actionBody('pause')).code,503);
});

test('A failed durable pass admission never calls the provider and holds the ledger until restart recovery',async t=>{
  const f=fixture(t),operations=f.create();const id=operations.start(startBody()).operation.id;
  f.failWrites('after-main');await operations._pass(id).catch(error=>assert.match(error.message,/Injected failure after durable admission write/));
  assert.equal(f.runs.length,0);f.failWrites(false);
  assert.equal(operations.snapshot().ledger_status,'unproven');
  const pause=operations.action(id,actionBody('pause','recover-after-write-pause'));assert.equal(pause.code,503);
  const resume=operations.action(id,actionBody('resume','recover-after-write-resume'));
  assert.equal(resume.code,503,'an unproven ledger cannot admit another owner mutation');
  operations.close();assert.equal(f.time.timers.size,0,'no abandoned timebox should survive close');
  const reopened=f.create();reopened.recover();assert.equal(reopened.snapshot().operation.status,'attention');
  assert.equal(reopened.snapshot().operation.run_id,null);await f.time.advance(LIMITS.next_pass_ms*2);
  assert.equal(f.runs.length,0,'restart reads the interrupted admission and never replays provider work');
});

test('Actual artifacts receive read-back hashes; changed bytes or metadata cannot be downloaded under the old receipt',async t=>{
  const f=fixture(t),operations=f.create(),id=operations.start(startBody(undefined,'once')).operation.id;
  const bytes=Buffer.from('Original native prototype\n');const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  f.setArtifact(async(agent,filename,includeBytes)=>({sha256:sha,size:bytes.length,...(includeBytes?{bytes}:{})}));
  await operations.recordResult(id,'maker','child-artifact-run',{artifacts:[{kind:'file',path:'products/prototype.md'}]});
  const artifact=operations.snapshot().artifacts[0];assert.equal(artifact.operation_id,id);assert.equal(artifact.agent_id,'maker');assert.equal(artifact.sha256,sha);assert.equal(artifact.size,bytes.length);
  assert.match(artifact.id,/^[a-f0-9]{32}$/);assert.equal(artifact.title,'prototype.md');
  const content=await operations.artifact(id,artifact.id);assert.equal(content.bytes.toString(),'Original native prototype\n');
  assert.equal(f.verified.at(-1).includeBytes,true);
  f.setArtifact(async()=>({sha256:'b'.repeat(64),size:bytes.length,bytes:Buffer.from('Replaced')}));
  await assert.rejects(operations.artifact(id,artifact.id),/changed after its verified delivery/);
  f.setArtifact(async()=>({sha256:sha,size:bytes.length+1,bytes}));
  await assert.rejects(operations.artifact(id,artifact.id),/changed after its verified delivery/);
  await assert.rejects(operations.artifact(id,'outside-unrecorded-path'),/Artifact not found/);
});

test('An unclean or uncertain-mutation pass waits in attention and never schedules an automatic retry',async t=>{
  for(const result of [{reason:'limited',text:'Budget ended',artifacts:[]},{reason:'done',text:'Uncertain worker action',artifacts:[],uncertainMutations:['summon-request']}]) {
    const f=fixture(t);f.setRun(async()=>result);const operations=f.create();operations.start(startBody());
    await f.time.advance(0);assert.equal(f.runs.length,1);assert.equal(operations.snapshot().operation.status,'attention');
    assert.equal(operations.snapshot().operation.next_at,null);
    await f.time.advance(LIMITS.next_pass_ms*2);assert.equal(f.runs.length,1);
  }
});

test('A done lead or child with an actually reported undeliverable file cannot complete or schedule',async t=>{
  for(const mode of ['once','ongoing']) for(const owner of ['agent','maker']) {
    const f=fixture(t),operations=f.create();
    f.setArtifact(async()=>{throw Error('Missing reported artifact');});
    const outcome={reason:'done',text:'The worker says it finished',artifacts:[{kind:'file',path:'missing-product.md'}]};
    f.setRun(async pass=>{
      if(owner==='agent')return outcome;
      await pass.recordResult(owner,'missing-child-run',outcome);
      return{reason:'done',text:'Lead completed normally',artifacts:[]};
    });
    operations.start(startBody(undefined,mode));await f.time.advance(0);
    const saved=operations.snapshot().operation;
    assert.equal(saved.status,'attention');assert.equal(saved.next_at,null);assert.equal(saved.artifacts.length,0);
    assert.equal(saved.current_pass_failures.length,1);assert.equal(saved.current_pass_failures[0].agent_id,owner);
    assert.equal(saved.current_pass_failures[0].reason,'artifact_unavailable');
    assert.deepEqual(saved.current_pass_failures[0].failed_artifacts,['missing-product.md']);
    await f.time.advance(LIMITS.next_pass_ms*2);assert.equal(f.runs.length,1,'Failed delivery never silently retries.');
    operations.close();const reopened=f.create();reopened.recover();
    assert.deepEqual(reopened.snapshot().operation.current_pass_failures,saved.current_pass_failures);
  }
});

test('Honest done passes reporting no files remain valid for once and ongoing work',async t=>{
  for(const mode of ['once','ongoing']) {
    const f=fixture(t),operations=f.create();
    f.setArtifact(async()=>{throw Error('No file verification should run');});
    f.setRun(async()=>({reason:'done',text:'A useful assessment with no promised deliverable',artifacts:[]}));
    operations.start(startBody(undefined,mode));await f.time.advance(0);
    const saved=operations.snapshot().operation;
    assert.equal(saved.status,mode==='once'?'completed':'running');
    assert.deepEqual(saved.current_pass_failures,[]);assert.equal(f.verified.length,0);
  }
});

test('Mixed deliveries retain valid siblings and duplicate failed paths merge into the same real run receipt',async t=>{
  const f=fixture(t),operations=f.create();
  f.setArtifact(async(_agent,filename)=>{
    if(filename.startsWith('missing'))throw Error('No file');
    return{sha256:'a'.repeat(64),size:5};
  });
  const reported={reason:'done',artifacts:[{kind:'file',path:'valid-product.md'},
    {kind:'file',path:'missing-one.md'},{kind:'file',path:'missing-two.md'},{kind:'file',path:'missing-one.md'}]};
  f.setRun(async pass=>{
    await pass.recordResult('maker','mixed-child-run',reported);
    await pass.recordResult('maker','mixed-child-run',reported);
    // A later dispatcher error may augment the same run but cannot erase its failed delivery paths.
    await pass.recordResult('maker','mixed-child-run',{reason:'invalid-result',artifacts:[]});
    return{reason:'done',text:'Lead ended',artifacts:[]};
  });
  operations.start(startBody(undefined,'once'));await f.time.advance(0);
  const saved=operations.snapshot().operation;assert.equal(saved.status,'attention');
  assert.equal(saved.artifacts.length,1);assert.equal(saved.artifacts[0].path,'valid-product.md');
  assert.equal(saved.current_pass_failures.length,1);assert.equal(saved.current_pass_failures[0].run_id,'mixed-child-run');
  assert.equal(saved.current_pass_failures[0].reason,'invalid-result');
  assert.deepEqual(saved.current_pass_failures[0].failed_artifacts,['missing-one.md','missing-two.md']);
});

test('A done lead cannot complete or schedule after a delegated worker fails or leaves an uncertain mutation',async t=>{
  for(const mode of ['once','ongoing']) for(const child of [
    {reason:'error',artifacts:[]},
    {reason:'limited',artifacts:[]},
    {reason:'done',artifacts:[],uncertainMutations:[{callId:'actual-uncertain-write'}]}
  ]) {
    const f=fixture(t),operations=f.create();
    f.setRun(async pass=>{
      await pass.recordResult('maker','subordinate-outcome-run',child);
      return{reason:'done',text:'The lead ended normally',artifacts:[]};
    });
    operations.start(startBody(undefined,mode));await f.time.advance(0);
    const saved=operations.snapshot().operation;
    assert.equal(saved.status,'attention','a normal lead return cannot erase an unclean actual child outcome');
    assert.equal(saved.next_at,null);assert.equal(saved.current_pass_failures.length,1);
    assert.equal(saved.current_pass_failures[0].agent_id,'maker');
    assert.equal(saved.current_pass_failures[0].reason,child.reason);
    assert.equal(saved.current_pass_failures[0].uncertain_mutations,(child.uncertainMutations||[]).length);
    assert.ok(saved.events.some(e=>e.type==='worker_attention'&&e.run_id==='subordinate-outcome-run'));
    await f.time.advance(LIMITS.next_pass_ms*2);assert.equal(f.runs.length,1,'no silent subordinate replay');
  }
});

test('Subordinate uncertainty survives ledger reopen with its verified files and resets only for an explicit new pass',async t=>{
  const f=fixture(t),operations=f.create();
  f.setRun(async pass=>{
    await pass.recordResult('maker','uncertain-child-with-file',{reason:'done',
      artifacts:[{kind:'file',path:'products/retained-prototype.md'}],uncertainMutations:['unresolved-mutation']});
    return{reason:'done',text:'Original file is saved; mutation still needs review',artifacts:[]};
  });
  const id=operations.start(startBody(undefined,'once')).operation.id;await f.time.advance(0);
  const saved=operations.snapshot();assert.equal(saved.operation.status,'attention');assert.equal(saved.artifacts.length,1);
  operations.close();const reopened=f.create();reopened.recover();
  assert.deepEqual(reopened.snapshot().operation.current_pass_failures,saved.operation.current_pass_failures);
  assert.deepEqual(reopened.snapshot().artifacts,saved.artifacts);
  await f.time.advance(LIMITS.next_pass_ms);assert.equal(f.runs.length,1);
  f.setRun(async()=>({reason:'done',text:'Owner reviewed; new pass succeeded',artifacts:[],uncertainMutations:[]}));
  assert.equal(reopened.action(id,actionBody('resume','owner-reviewed-subordinate-outcome')).ok,true);
  await f.time.advance(0);
  assert.equal(f.runs.length,2);assert.equal(reopened.snapshot().operation.status,'completed');
  assert.deepEqual(reopened.snapshot().operation.current_pass_failures,[]);
  assert.deepEqual(reopened.snapshot().artifacts,saved.artifacts,'resuming preserves earlier proven delivery');
});

test('An operation call cannot dispatch when its durable budget admission fails',async t=>{
  const f=fixture(t);let dispatched=0;
  f.setRun(async({budget})=>{
    f.failWrites(true);
    try {if(budget.take())dispatched++;}catch(error){assert.match(error.message,/write|durable|budget|admi|proof/i);}
    finally{f.failWrites(false);}
    return{reason:'cancelled',text:'Budget write refused',artifacts:[]};
  });
  const operations=f.create();operations.start(startBody());await f.time.advance(0);
  assert.equal(dispatched,0,'a failed budget receipt must refuse the corresponding model/tool dispatch');
  assert.equal(operations.snapshot().operation.status,'attention');
  assert.equal(operations.snapshot().operation.next_at,null);
});

test('Tool-call and daily pass admission caps use the injected clock and never widen the provider allowance',async t=>{
  const f=fixture(t);let accepted=0;
  f.setRun(async({budget})=>{if(f.runs.length===1)for(let i=0;i<LIMITS.calls_per_pass+5;i++)if(budget.take())accepted++;return{reason:'done',text:'Bounded pass',artifacts:[]};});
  const operations=f.create();operations.start(startBody());await f.time.advance(0);
  assert.equal(accepted,LIMITS.calls_per_pass);assert.equal(operations.snapshot().operation.last_tool_calls,LIMITS.calls_per_pass);
  // Fifty fake intervals stay within the same UTC test day, proving that the
  // ledger cap, rather than an uncontrolled timer, gates new provider calls.
  await f.time.advance(LIMITS.next_pass_ms*50);
  assert.equal(f.runs.length,LIMITS.max_passes_per_day);assert.equal(operations.snapshot().operation.day_passes,LIMITS.max_passes_per_day);
  assert.match(operations.snapshot().operation.message,/Daily ChatGPT operation allowance/);
  assert.equal(operations.snapshot().operation.next_at,Date.parse('2026-10-05T00:00:00Z'));
});
