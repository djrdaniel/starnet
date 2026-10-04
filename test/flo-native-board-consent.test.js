'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { makeFloNativeStation } = require('../sidecar/flo-native-station.js');
const { makeNativeConsent, NATIVE_TASK_DESCRIPTION } = require('../sidecar/flo-native-consent.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { composeOffice } = require('../sidecar/capability/office.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const profiles = require('../sidecar/flo-capability-profile.js');
const WorldModel = require('../frontend/app/worldmodel.js');

// Execute the actual host consent selector, then dispatch through the real
// registry/schema/capability gates and native canonical Workstreams writer.
const source = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const start = source.indexOf('  const consent = floNative ?');
const end = source.indexOf('  // B1 (Cortex seam)', start);
assert.ok(start > 0 && end > start);
function fixture(t, { worker = false, native = true, decision = 'deny', context = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-native-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1000, sequence = 0;
  const saveStore = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => ++clock } });
  const hero = { id: 'agent', name: 'CHIEF OF STAFF', provider: 'codex', model: 'gpt-5.6-sol', docs: {} };
  const world = WorldModel.create(); world.ensureWorkstation('agent');
  const initial = { _saveRevision: 0, agent: hero, agents: [hero], station: world.serialize(),
    workstreams: [{ id: 'general', kind: 'chat', agentId: 'agent', lane: 'active', history: [] },
      { id: 'review-task', kind: 'task', title: 'Resolve itch package verification and stage Space Mission UI proposal',
        agentId: 'agent', lane: 'active', history: [], custom: 'preserve' }],
    generalId: 'general', activeId: 'general', deletedIds: [], grants: { unchanged: true }, releaseRecords: [{ publication: 'pending' }] };
  assert.equal(saveStore.save('agent', initial, { compareRevision: true }).ok, true);
  const canonical = makeFloNativeStation({ fs, path, workspaces: root, writeDurable: writeFileDurable, saveStore,
    now: () => ++clock, newId: () => 'new-' + ++sequence, sync: () => true });
  const nativeToolCall = new AsyncLocalStorage(), controller = new AbortController(), prompts = [], calls = [];
  const prompt = async (call, tool) => { prompts.push({ call, tool }); return typeof decision === 'function' ? decision(controller) : decision; };
  const profile = profiles.resolve(worker ? 'flo-operator-worker' : 'flo-operator');
  const ordinaryConsent = async () => ({ allow: false, reason: 'Ordinary consent remains separate.' });
  const consent = vm.runInNewContext(source.slice(start, end) + '\nconsent;', {
    floNative: native, makeNativeConsent, floProfile: profile, signal: controller.signal, prompt,
    nativeToolCall: context ? nativeToolCall : { getStore: () => null }, ordinaryConsent
  });
  const registry = makeRegistry();
  const tools = makeStationTools({ station: { request: (verb, args) => {
    const meta = nativeToolCall.getStore(); calls.push({ verb, args, meta });
    return canonical.request(verb, args, meta);
  } } });
  if (native) tools.taskManageTool.description = NATIVE_TASK_DESCRIPTION;
  tools.register(registry);
  const station = { agents: { agent: { id: 'agent', room: 'office' } }, rooms: { office: {
    id: 'office', objects: composeOffice({ surface: 'autonomous', lead: !worker }) } } };
  const resolved = profiles.restrict(resolveTools('agent', station), profile);
  const capCtx = makeCapCtx(resolved, { consent, signal: controller.signal });
  const meta = () => ({ requestId: 'actual-board-' + ++sequence, expectedRevision: saveStore.load('agent')._saveRevision });
  const dispatch = (args, suppliedMeta = meta()) => nativeToolCall.run(suppliedMeta,
    () => registry.dispatch({ id: suppliedMeta.requestId, name: 'task.manage', args }, capCtx));
  return { dispatch, canonical, meta, prompts, calls, controller, tools, saved: () => saveStore.load('agent') };
}

test('Admitted lead moves the exact real card to shipped without approval or external authority', async t => {
  const f = fixture(t), before = f.saved();
  const result = await f.dispatch({ task: before.workstreams[1].title, action: 'move', lane: 'shipped' });
  assert.equal(result.isError, false); assert.match(result.summary, /moved task/);
  assert.equal(f.saved().workstreams.find(w => w.id === 'review-task').lane, 'shipped');
  assert.equal(f.prompts.length, 0);
  assert.equal(f.calls[0].meta.ownerConfirmed, undefined, 'Automatic organization never claims an owner consent.');
  assert.deepEqual(f.saved().grants, before.grants);
  assert.deepEqual(f.saved().releaseRecords, before.releaseRecords, 'Shipped is not store publication.');
  assert.equal(f.saved().activeId, 'general');
  assert.match(f.tools.taskManageTool.description, /never publishes/);
  assert.match(makeStationTools({}).taskManageTool.description, /Commander explicitly asks/, 'Ordinary station policy is unchanged.');
});

test('Native board admission is per-call, exact and cannot be supplied as a JSON permission', async t => {
  const f = fixture(t), args = { task: 'review-task', action: 'move', lane: 'shipped' }, fake = f.meta();
  fake.nativeBoardMove = true;
  assert.equal(f.canonical.request('station.manage_task', args, fake).code, 403);
  const refused = await f.dispatch({ ...args, ownerConfirmed: true });
  assert.equal(refused.isError, true); assert.equal(f.calls.length, 0);
  const approved = await f.dispatch(args); assert.equal(approved.isError, false);
  const actualMeta = f.calls[0].meta;
  assert.equal(f.canonical.request('station.manage_task', { ...args, task: 'general' }, actualMeta).code, 403);
  assert.equal(f.canonical.request('station.manage_task', args, { ...actualMeta }).code, 403, 'Copying metadata cannot mint admission.');
});

test('Invalid lanes, missing targets and missing host context cannot move a card', async t => {
  const f = fixture(t), before = f.saved();
  for (const args of [{ task: 'review-task', action: 'move', lane: 'published' },
    { task: '', action: 'move', lane: 'shipped' }, { task: 'review-task', action: 'move' },
    { task: 'review-task', action: 'move', lane: 'shipped', title: 'Change terms' }]) {
    const result = await f.dispatch(args); assert.equal(result.isError, true);
  }
  assert.deepEqual(f.saved(), before); assert.equal(f.calls.length, 0);
  const missing = fixture(t, { context: false });
  assert.equal((await missing.dispatch({ task: 'review-task', action: 'move', lane: 'shipped' })).isError, true);
  assert.equal(missing.calls.length, 0);
  const absent = await f.dispatch({ task: 'missing-task', action: 'move', lane: 'shipped' });
  assert.match(absent.content, /No such native session/); assert.deepEqual(f.saved(), before);
});

test('Workers and ordinary runs still cannot acquire the native lead board authority', async t => {
  for (const options of [{ worker: true }, { native: false }]) {
    const f = fixture(t, options), before = f.saved();
    assert.equal((await f.dispatch({ task: 'review-task', action: 'move', lane: 'shipped' })).isError, true);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.saved(), before);
  }
});

test('Destructive archive/remove still prompt for an exact owner decision and denial writes nothing', async t => {
  const f = fixture(t), before = f.saved();
  for (const action of ['archive', 'remove']) {
    assert.equal((await f.dispatch({ task: 'review-task', action })).isError, true);
  }
  assert.equal(f.prompts.length, 2); assert.equal(f.calls.length, 0); assert.deepEqual(f.saved(), before);
  const once = fixture(t, { decision: 'once' });
  assert.equal((await once.dispatch({ task: 'review-task', action: 'archive' })).isError, false);
  assert.equal(once.saved().workstreams.find(w => w.id === 'review-task').archived, true);
  assert.equal(once.calls[0].meta.ownerConfirmed, true);
});

test('Abort during owner review and stale canonical revision retain the existing task', async t => {
  const cancelled = fixture(t, { decision: controller => { controller.abort(); return 'once'; } }), before = cancelled.saved();
  assert.equal((await cancelled.dispatch({ task: 'review-task', action: 'remove' })).isError, true);
  assert.deepEqual(cancelled.saved(), before); assert.equal(cancelled.calls.length, 0);
  const stale = fixture(t), badMeta = stale.meta(); badMeta.expectedRevision -= 1;
  const result = await stale.dispatch({ task: 'review-task', action: 'move', lane: 'shipped' }, badMeta);
  assert.match(result.content, /revision/i); assert.equal(stale.saved().workstreams[1].lane, 'active');
});
