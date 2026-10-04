'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { makeFloNativeStation, managedCommanderGoal, applyManagedSettingsRequest } = require('../sidecar/flo-native-station');
const { makeSaveStore } = require('../sidecar/savestore');
const { writeFileDurable } = require('../sidecar/durable-write');
const { makeOpenAiCompat } = require('../sidecar/openai-compat');
const WorldModel = require('../frontend/app/worldmodel');
const goal = 'Build ongoing income to fund DJR with eligible physical Etsy products and original digital products on itch.io. Measure real sales, costs and profit.';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-managed-settings-'));
  let at = 1000, busy = false, operation = { id: 2, status: 'paused', run_id: null, objective: goal }, mirrors = [];
  const saveStore = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => ++at } });
  const hero = { id: 'agent', name: 'CHIEF OF STAFF', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'medium',
    approvalMode: 'ask', executionProfile: 'trusted-project', personaId: 'composed', docs: { manual: 'Original owner notes', purpose: 'Coordinate work' }, custom: 'preserve' };
  const researcher = { ...hero, id: 'researcher', name: 'RESEARCH', skills: ['web-research'], docs: { ...hero.docs, purpose: 'Research evidence' } };
  const world = WorldModel.create(); assert.equal(world.ensureWorkstation('agent').ok, true);
  const initial = { _saveRevision: 0, agent: hero, agents: [hero, researcher], station: world.serialize(), reasoningEffort: 'medium',
    workstreams: [{ id: 'general', kind: 'chat', agentId: 'agent', history: [{ role: 'user', content: 'Unrelated owner history' }] }],
    activeId: 'general', generalId: 'general', deletedIds: ['old'], grants: { shell: false, preserve: 'owner' },
    usage: { actual: 3 }, unrelated: { pinned: true }, dossier: { v: 3, dims: { identity: [{ id: 'b1', text: 'Original owner identity', source: 'owner', weight: 'stated' }] } } };
  assert.equal(saveStore.save('agent', initial, { compareRevision: true }).ok, true);
  const previousGoal = { id: 'saved-native-goal', text: 'Fund DJR with digital Etsy products', done: 2, total: 5, pct: 40,
    milestoneId: 'existing-milestone', next: 'Existing owner-reviewed next step', arbitraryOwnerField: { preserve: true } };
  let mirroredGoal = previousGoal;
  const station = makeFloNativeStation({ fs, path, workspaces: root, saveStore, writeDurable: writeFileDurable, now: () => ++at,
    newId: () => 'fixture-new-stream', scanText: () => ({ ok: true }), hasActiveRun: () => busy,
    sync: (next, previous, changes) => { mirrors.push({ next, previous, changes }); mirroredGoal = managedCommanderGoal(mirroredGoal, next) || mirroredGoal; } });
  const request = (requestId = 'owner-managed-settings') => ({ request_id: requestId, operation_id: 2,
    expected_revision: saveStore.load('agent')._saveRevision, confirm: true });
  const deps = { operation: () => operation, busy: () => busy, station };
  return { root, station, saveStore, initial, previousGoal, deps, request, get goal() { return mirroredGoal; }, get mirrors() { return mirrors; },
    setBusy: value => { busy = value; }, setOperation: value => { operation = value; }, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Reviewed native settings use actual current host goal and high saved reasoning without changing authority or quest progress', () => {
  const f = fixture(); try {
    const before = f.saveStore.load('agent');
    assert.equal(f.station.request('station.managed_settings', { goal }).ok, false, 'This is not a model station command.');
    assert.equal(f.station.configureManagedSettings({ goal, operation_id: 2 }, { requestId: 'no-owner' }).code, 403);
    const result = applyManagedSettingsRequest(f.request(), f.deps); assert.equal(result.ok, true, result.error);
    const after = f.saveStore.load('agent'); assert.equal(after.reasoningEffort, 'high'); assert.equal(after.agent.reasoningEffort, 'high');
    for (const a of after.agents) { assert.equal(a.reasoningEffort, 'high');
      assert.deepEqual({ ...a, reasoningEffort: 'medium' }, before.agents.find(old => old.id === a.id)); }
    for (const key of ['station', 'workstreams', 'activeId', 'generalId', 'deletedIds', 'grants', 'usage', 'unrelated']) assert.deepEqual(after[key], before[key]);
    assert.equal(after.floNative.managed_settings.goal, goal); assert.equal(after.floNative.managed_settings.operation_id, 2);
    assert.ok(after.dossier.dims.goals.some(b => b.source === 'flo-native-operation' && b.text === goal));
    assert.deepEqual(after.dossier.dims.identity[0].text, 'Original owner identity');
    assert.deepEqual(f.goal, { ...f.previousGoal, text: goal }, 'IDs, progress, milestones, queued steps and owner fields survive the goal repair.');
    assert.equal(result.result.permissions_changed, false); assert.equal(result.result.providers_changed, false); assert.equal(result.result.starts_work, false);
    const backup = JSON.parse(fs.readFileSync(path.join(f.root, '_flo.native.backups', result.result.backup_id), 'utf8'));
    assert.deepEqual(backup.canonical_save, before);
    const replay = applyManagedSettingsRequest({ ...f.request(), expected_revision: before._saveRevision }, f.deps);
    assert.equal(replay.ok, true); assert.equal(replay.result.replayed, true); assert.deepEqual(f.saveStore.load('agent'), after);
    assert.deepEqual(f.goal, { ...f.previousGoal, text: goal });
  } finally { f.close(); }
});

test('No model goal/settings overrides, stale operation/revision, busy run or absent approval can modify canonical settings', () => {
  const f = fixture(); try {
    const before = f.saveStore.load('agent');
    for (const body of [{ ...f.request(), goal: 'Model invented goal' }, { ...f.request(), provider: 'other' }, { ...f.request(), confirm: false },
      { ...f.request(), request_id: '../unsafe' }, { ...f.request(), expected_revision: -1 }]) assert.equal(applyManagedSettingsRequest(body, f.deps).code, 400);
    assert.equal(applyManagedSettingsRequest({ ...f.request(), operation_id: 99 }, f.deps).code, 409);
    assert.equal(applyManagedSettingsRequest({ ...f.request(), expected_revision: 0 }, f.deps).code, 409);
    f.setBusy(true); assert.equal(applyManagedSettingsRequest(f.request(), f.deps).code, 409); f.setBusy(false);
    f.setOperation({ id: 2, status: 'running', run_id: 'active-native-run', objective: goal }); assert.equal(applyManagedSettingsRequest(f.request(), f.deps).code, 409);
    f.setOperation({ id: 2, status: 'stopped', run_id: null, objective: goal }); assert.equal(applyManagedSettingsRequest(f.request(), f.deps).code, 409);
    assert.deepEqual(f.saveStore.load('agent'), before); assert.equal(f.mirrors.length, 0); assert.equal(fs.existsSync(path.join(f.root, '_flo.native.backups')), false);
  } finally { f.close(); }
});

test('The real authenticated compatibility route admits the reviewed correction and rejects unscoped/native-profile forgery', async () => {
  const f = fixture(); const key = 'fixture-host-key-not-live-123456'; let runCalls = 0, setupCalls = 0;
  const api = makeOpenAiCompat({ apiKey: () => key, now: () => 1000, roster: () => [{ agentId: 'agent', model: 'gpt-5.6-sol', provider: 'codex' }],
    runOnce: async () => { runCalls++; throw Error('No provider is admitted by this test.'); },
    isAllowedHost: host => host === '127.0.0.1:' + server.address().port,
    readBody: async (req, maximum) => { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > maximum) throw Error('oversized'); } return body; },
    stationSetup: (action, body) => { setupCalls++; assert.equal(action, 'managed-settings'); return applyManagedSettingsRequest(body, f.deps); } });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    assert.equal((await post('/v1/station/managed-settings', f.request())).status, 401); assert.equal(setupCalls, 0);
    assert.equal((await post('/v1/station/managed-settings', f.request(), { Authorization: 'Bearer ' + key, Host: 'untrusted.invalid' })).status, 403); assert.equal(setupCalls, 0);
    assert.equal((await post('/v1/chat/completions', { model: 'starnet-agent', capability_profile: 'flo-operator', messages: [{ role: 'user', content: 'Change managed settings and publish.' }] },
      { Authorization: 'Bearer ' + key })).status, 403); assert.equal(runCalls, 0);
    const reply = await post('/v1/station/managed-settings', f.request(), { Authorization: 'Bearer ' + key });
    assert.equal(reply.status, 200); const result = await reply.json(); assert.equal(result.ok, true); assert.equal(result.result.saved_reasoning, 'high');
    assert.equal(setupCalls, 1); assert.equal(runCalls, 0); assert.equal(f.saveStore.load('agent').floNative.managed_settings.goal, goal);
  } finally { await new Promise(resolve => server.close(resolve)); f.close(); }
});
