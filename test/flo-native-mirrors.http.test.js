'use strict';
// Real isolated sidecar HTTP proof: an older renderer cannot replace native
// recruitment/routing mirrors by supplying a fresh wall-clock timestamp.
// Fixture creation, enrollment and floor construction use genuine engines;
// no provider is configured or called and no real workspace is accessed.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeFloNativeStation, composeAgentSystem } = require('../sidecar/flo-native-station.js');
const { makeStationStore } = require('../sidecar/station-store.js');
const { nativeRoutingPlan } = require('../sidecar/flo-native-save-policy.js');
const WM = require('../frontend/app/worldmodel.js'), Pipeline = require('../frontend/app/pipeline.js');
const Dossier = require('../frontend/app/dossier.js');
const copy = value => JSON.parse(JSON.stringify(value));

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'flo-native-mirrors-', timeoutMs: 20000, env: {
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENAI_API_KEY: '',
    STARNET_OPENAI_KEY: '', SKYNET_OPENAI_KEY: '', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: ''
  } });
  const workspace = fixture.workspace, rosterFile = path.join(workspace, 'agent.roster.json'), routingFile = path.join(workspace, 'routing.plan.json');
  let clock = Date.now(), ids = 0;
  const store = makeSaveStore({ fs, pathMod: path, root: workspace, clock: { now: () => ++clock } });
  const hero = { id: 'agent', name: 'CHIEF OF STAFF', role: 'orchestrator', provider: 'codex', model: 'gpt-5.6-sol',
    reasoningEffort: 'medium', approvalMode: 'ask', executionProfile: 'trusted-project', createdAt: 1,
    docs: { identity: 'Fixture Chief of Staff', purpose: 'Prepare original reviewable commerce artifacts',
      manual: 'FLO COMPANY CONTRACT\nInternal worker-to-worker delegation is disabled.', context: 'An isolated test workspace' } };
  const floor = WM.create(); assert.equal(floor.ensureWorkstation('agent').ok, true);
  const initial = { schema: 'starnet.save', version: 6, updatedAt: ++clock, _saveRevision: 0, agent: hero, agents: [hero],
    station: floor.serialize(), dossier: Dossier.fresh(), workstreams: [{ id: 'general', agentId: 'agent', kind: 'chat',
      lane: 'active', history: [], createdAt: 1 }], activeId: 'general', generalId: 'general' };
  assert.equal(store.save('agent', initial, { compareRevision: true }).ok, true);
  const oldBrowserRevision = store.load('agent')._saveRevision;
  const native = makeFloNativeStation({ fs, path, workspaces: workspace, saveStore: store, writeDurable: writeFileDurable,
    now: () => ++clock, newId: () => 'native_fixture_' + ++ids, scanText: () => ({ ok: true }),
    sync: next => {
      writeFileDurable({ fs, path }, rosterFile, JSON.stringify({ version: 1, agents: next.agents.map(a => ({
        agentId: a.id, name: a.name, system: composeAgentSystem(a), provider: a.provider, model: a.model,
        approvalMode: a.approvalMode, executionProfile: a.executionProfile, reasoningEffort: a.reasoningEffort,
        nativeFixtureField: 'retain me'
      })) }));
      writeFileDurable({ fs, path }, routingFile, JSON.stringify(nativeRoutingPlan(makeStationStore().validateStationDoc(next.station))));
    }
  });
  const meta = requestId => ({ requestId, expectedRevision: store.load('agent')._saveRevision });
  try {
    assert.equal(native.enroll(meta('enroll:native-mirror-fixture')).ok, true);
    const recruited = native.summon({ name: 'NATIVE DESIGNER', specId: 'designer' }, meta('native-mirror-recruit'));
    assert.equal(recruited.ok, true, recruited.error);
    const workerId = recruited.result.agentId;
    const built = native.request('station.build', { actions: [
      { op: 'room', kind: 'factory', name: 'Native production room', rect: { x1: 23, y1: 0, x2: 42, y2: 12 } },
      { op: 'prop', ref: 'intake', type: 'intake', x: 25, y: 7 },
      { op: 'prop', ref: 'bay', type: 'bay', x: 31, y: 7, agentId: workerId, brief: 'Prepare an original artifact for owner review' },
      { op: 'prop', ref: 'outbox', type: 'outbox', x: 37, y: 7 },
      { op: 'belt', from: 'intake', to: 'bay' }, { op: 'belt', from: 'bay', to: 'outbox' }
    ] }, meta('native-mirror-build'));
    assert.equal(built.ok, true, built.error);
    await fixture.start();
    const read = await fixture.json('GET', '/api/save?agent=agent'); assert.equal(read.status, 200);
    const canonical = read.body.save, currentRevision = canonical._saveRevision;
    assert.ok(canonical.floNative); assert.ok(currentRevision > oldBrowserRevision);
    const originalRoster = fs.readFileSync(rosterFile, 'utf8'), originalRouting = fs.readFileSync(routingFile, 'utf8');
    const rosterRows = JSON.parse(originalRoster).agents;
    const actualPlan = JSON.parse(originalRouting);
    assert.equal(actualPlan.lines.length, 1, 'native production line is genuinely present before the HTTP attacks');
    for (const bay of actualPlan.bays.concat(actualPlan.dockBays)) assert.ok(Array.isArray(bay.objects), 'native bay capability projection was enriched');
    const obsoleteRoster = rosterRows.filter(a => a.agentId === 'agent');
    const obsoletePlan = Pipeline.compileRoutingPlan(WM.create().projectGeometry());
    let timestamp = Date.now() + 1000000;
    const verifyPreserved = async () => {
      assert.equal(fs.readFileSync(rosterFile, 'utf8'), originalRoster, 'rejected old renderer cannot delete the recruited worker on disk');
      assert.equal(fs.readFileSync(routingFile, 'utf8'), originalRouting, 'rejected old renderer cannot replace native routing on disk');
      const runtime = await fixture.json('GET', '/api/runtime/agent');
      assert.ok(runtime.body.agents.some(a => a.agentId === workerId), 'the real live roster also retains the worker');
      const state = await fixture.json('GET', '/api/save?agent=agent');
      assert.deepEqual(state.body.save, canonical, 'mirror rejections never mutate the canonical save');
    };
    for (const revision of [undefined, oldBrowserRevision, currentRevision + 1]) {
      const rosterBody = { agents: obsoleteRoster, updatedAt: ++timestamp };
      const planBody = copy(obsoletePlan);
      if (revision !== undefined) { rosterBody.floBaseSaveRevision = revision; planBody.floBaseSaveRevision = revision; }
      const roster = await fixture.json('POST', '/api/roster', rosterBody);
      assert.equal(roster.status, 200); assert.equal(roster.body.ok, false); assert.equal(roster.body.stale, true);
      const routing = await fixture.json('POST', '/api/routing', planBody);
      assert.equal(routing.status, 409); assert.equal(routing.body.ok, false); assert.equal(routing.body.stale, true);
      await verifyPreserved();
    }
    // Refreshed owner writes retain their existing source-of-truth behavior.
    const freshRoster = await fixture.json('POST', '/api/roster', { agents: rosterRows, updatedAt: ++timestamp, floBaseSaveRevision: currentRevision });
    assert.equal(freshRoster.status, 200); assert.equal(freshRoster.body.ok, true);
    assert.ok(JSON.parse(fs.readFileSync(rosterFile, 'utf8')).agents.some(a => a.agentId === workerId));
    const freshRouting = await fixture.json('POST', '/api/routing', { ...actualPlan, floBaseSaveRevision: currentRevision });
    assert.equal(freshRouting.status, 200); assert.equal(freshRouting.body.ok, true);
    const persistedPlan = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    assert.equal(persistedPlan.hash, actualPlan.hash); assert.equal(Object.hasOwn(persistedPlan, 'floBaseSaveRevision'), false);
    assert.deepEqual((await fixture.json('GET', '/api/save?agent=agent')).body.save, canonical);
    assert.equal((await fixture.json('GET', '/api/state/snapshot')).body.runs.length, 0, 'the entire mirror test started no model work');
    await fixture.restart();
    const reloaded = await fixture.json('GET', '/api/runtime/agent');
    assert.ok(reloaded.body.agents.some(a => a.agentId === workerId), 'the recruited native worker remains after a real host restart');
    assert.equal(JSON.parse(fs.readFileSync(routingFile, 'utf8')).hash, actualPlan.hash);
    console.log('flo-native-mirrors.http: real enrolled/recruited/built station rejects missing/stale/future renderer revisions, preserves disk/RAM/canonical state, accepts current read-back and survives restart');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
