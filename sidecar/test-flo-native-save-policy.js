'use strict';

// Exercise the host-preservation policy through real durable save CAS, rather
// than claiming an older browser serializer can create native authority.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {makeSaveStore}=require('./savestore');
const {preserveNativeHostState,nativeMirrorCurrent,nativeRoutingPlan}=require('./flo-native-save-policy');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flo-native-save-policy-test-'));
  const deps={fs,pathMod:path,root,clock:{now:()=>Date.parse('2026-10-04T09:00:00Z')}};
  let store=makeSaveStore(deps);
  t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'flo-native-save-policy-test-')));fs.rmSync(root,{recursive:true,force:true});});
  return {root,get store(){return store;},reopen(){store=makeSaveStore(deps);return store;},
    saveBrowser(doc){return store.save('agent',preserveNativeHostState(doc,store.load('agent')),{compareRevision:true});}};
}
const baseline=()=>({agent:{id:'agent',name:'CHIEF OF STAFF',docs:{identity:'An existing station lead'}},
  agents:[{id:'agent',name:'CHIEF OF STAFF'}],updatedAt:1,workstreams:[{id:'owner-session',title:'Saved owner conversation'}],
  personalization:{theme:'dark',displayName:'Bench Owner',preferences:['Keep original work']},
  station:{ownerFloor:'Existing floor'},
  floNative:{version:1,receipts:[{request_id:'native-original',verb:'crew.summon',result:{agentId:'maker'}}],marker:'actual host proof'},
  floSetup:{version:1,goal:'Physical Etsy and digital itch',revision:7,source:'actual host setup'}});

test('An ordinary current browser save keeps real native receipts and setup while persisting owner changes',t=>{
  const f=fixture(t);assert.equal(f.store.save('agent',baseline(),{compareRevision:true}).revision,1);
  const incoming=f.store.load('agent');delete incoming.floNative;delete incoming.floSetup;
  incoming.personalization.theme='light';incoming.workstreams.push({id:'owner-new-session',title:'A new saved conversation'});
  const saved=f.saveBrowser(incoming);assert.equal(saved.ok,true);assert.equal(saved.revision,2);
  const read=f.reopen().load('agent');assert.deepEqual(read.floNative,baseline().floNative);assert.deepEqual(read.floSetup,baseline().floSetup);
  assert.equal(read.personalization.theme,'light');assert.equal(read.workstreams.length,2);
  assert.equal(read.agent.docs.identity,'An existing station lead');assert.deepEqual(read.station,baseline().station);
});

test('A stale browser save cannot erase host receipts or newer native state, and its owner draft remains recoverable',t=>{
  const f=fixture(t);f.store.save('agent',baseline(),{compareRevision:true});
  const stale=f.store.load('agent');delete stale.floNative;delete stale.floSetup;
  stale._saveClient='stale-owner-tab';stale.personalization.displayName='Updated owner preference';
  stale.workstreams.push({id:'owner-unsaved-session',title:'Owner draft to preserve'});
  const host=f.store.load('agent');host.floNative.receipts.push({request_id:'native-second',verb:'station.build',result:{room:'commerce'}});
  host.floSetup.revision=8;host.agents.push({id:'maker',name:'PROTOTYPE MAKER'});
  const hostSave=f.store.save('agent',host,{compareRevision:true});assert.equal(hostSave.revision,2);
  const rejected=f.saveBrowser(stale);assert.equal(rejected.ok,false);assert.equal(rejected.conflict,true);
  const canonical=f.store.load('agent');assert.equal(canonical._saveRevision,2);assert.equal(canonical.floNative.receipts.length,2);
  assert.equal(canonical.floSetup.revision,8);assert.equal(canonical.agents.length,2);
  assert.equal(canonical.personalization.displayName,'Bench Owner');
  const recovery=JSON.parse(fs.readFileSync(path.join(f.root,rejected.recovery),'utf8'));
  assert.equal(recovery.personalization.displayName,'Updated owner preference');
  assert.equal(recovery.workstreams.at(-1).title,'Owner draft to preserve');
  assert.deepEqual(recovery.floNative,canonical.floNative);assert.deepEqual(recovery.floSetup,canonical.floSetup);
  const refreshed=f.store.load('agent');refreshed.personalization.displayName=stale.personalization.displayName;
  assert.equal(f.saveBrowser(refreshed).revision,3);assert.equal(f.store.load('agent').floNative.receipts.length,2);
});

test('Client-fabricated native receipts and setup never replace canonical host proof, even on a fresh revision',t=>{
  const f=fixture(t);f.store.save('agent',baseline(),{compareRevision:true});
  const incoming=f.store.load('agent');incoming.floNative={version:1,receipts:[{request_id:'client-fake',approved:true}],full_access:true};
  incoming.floSetup={revision:999,source:'invented',grants:['publishing','spending']};
  incoming.personalization.preferences.push('A legitimate owner preference');
  assert.equal(f.saveBrowser(incoming).ok,true);
  const saved=f.store.load('agent');assert.deepEqual(saved.floNative,baseline().floNative);assert.deepEqual(saved.floSetup,baseline().floSetup);
  assert.deepEqual(saved.personalization.preferences,['Keep original work','A legitimate owner preference']);
  assert.equal(JSON.stringify(saved).includes('client-fake'),false);assert.equal(JSON.stringify(saved).includes('full_access'),false);
});

test('A station with no native host state cannot acquire it from browser input',t=>{
  const f=fixture(t),first=baseline();delete first.floNative;delete first.floSetup;
  first.floNative={receipts:[{request_id:'fabricated-first-save'}]};first.floSetup={approved:true};
  assert.equal(f.saveBrowser(first).ok,true);
  const saved=f.store.load('agent');assert.equal(Object.hasOwn(saved,'floNative'),false);assert.equal(Object.hasOwn(saved,'floSetup'),false);
  assert.equal(saved.personalization.displayName,'Bench Owner');assert.equal(saved.workstreams[0].id,'owner-session');
  const another=f.store.load('agent');another.floNative={full_access:true};another.floSetup={source:'fabricated-second-save'};
  assert.equal(f.saveBrowser(another).ok,true);assert.equal(Object.hasOwn(f.store.load('agent'),'floNative'),false);
});

test('Preserved host fields are independent copies and policy does not mutate the submitted browser document',()=>{
  const canonical=baseline(),incoming={_saveRevision:4,personalization:{theme:'light'},floNative:{receipts:['fake']},floSetup:{approved:true}};
  const before=structuredClone(incoming),next=preserveNativeHostState(incoming,canonical);
  assert.deepEqual(incoming,before);assert.deepEqual(next.floNative,canonical.floNative);assert.deepEqual(next.floSetup,canonical.floSetup);
  next.floNative.receipts[0].result.agentId='changed-copy';next.floSetup.goal='changed copy';
  assert.equal(canonical.floNative.receipts[0].result.agentId,'maker');assert.equal(canonical.floSetup.goal,'Physical Etsy and digital itch');
  assert.equal(next._saveRevision,4);assert.deepEqual(next.personalization,{theme:'light'});
});

test('A newly stamped old tab cannot overwrite a native recruit or routing plan without its actual revision',()=>{
  const canonical=Object.assign(baseline(),{_saveRevision:12});
  assert.equal(nativeMirrorCurrent({updatedAt:Date.now(),agents:[{agentId:'agent'}]},canonical),false);
  assert.equal(nativeMirrorCurrent({floBaseSaveRevision:11,updatedAt:Date.now()},canonical),false);
  assert.equal(nativeMirrorCurrent({floBaseSaveRevision:'12'},canonical),false);
  assert.equal(nativeMirrorCurrent({floBaseSaveRevision:12},canonical),true);
  assert.equal(nativeMirrorCurrent({},null),true);
  assert.equal(nativeMirrorCurrent({}, {_saveRevision:12}),true);
});

test('Native routing compiles actual per-bay gear for the same floor shown in the station',()=>{
  const WorldModel=require('../frontend/app/worldmodel');
  const {makeStationStore}=require('./station-store');
  const floor=WorldModel.create();
  assert.equal(floor.addRoom({kind:'factory',rect:{x1:23,y1:0,x2:43,y2:12}}).ok,true);
  const intake=floor.addProp({t:'intake',x:25,y:7,w:2,h:2});
  const bay=floor.addProp({t:'bay',x:31,y:7,w:2,h:2,agentId:'agent'});
  const outbox=floor.addProp({t:'outbox',x:37,y:7,w:2,h:2});
  assert.equal(floor.addProp({t:'war_intelcab',x:26,y:2}).ok,true);
  assert.equal(floor.connectBelt(intake.id,bay.id).ok,true);
  assert.equal(floor.connectBelt(bay.id,outbox.id).ok,true);
  const checked=makeStationStore().validateStationDoc(floor.serialize());
  const plan=nativeRoutingPlan(checked);
  assert.ok(plan.bays.length);assert.ok(plan.dockBays.length);
  for(const lane of ['bays','dockBays']) {
    assert.deepEqual(plan[lane][0].objects,checked.station.bayObjects('agent',bay.id));
    assert.ok(plan[lane][0].objects.some(o=>(o.objectType||o)==='cabinet'));
  }
  assert.equal(Object.hasOwn(checked.routingPlan.bays[0],'objects'),false);
  assert.throws(()=>nativeRoutingPlan({ok:false}),/invalid/);
});
