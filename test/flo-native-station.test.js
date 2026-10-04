'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { makeFloNativeStation, upgradeContracts, upgradeGeneratedContract, NATIVE_CONTRACT } = require('../sidecar/flo-native-station.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const Specialties = require('../frontend/app/specialties.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-native-station-'));
let clock = 1000, idSeq = 0, mirrorFailed = false, targetBusy = false;
const saveStore = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => ++clock } });
let mirrors = [];
function instance() { return makeFloNativeStation({ fs, path, workspaces: root, writeDurable: writeFileDurable, saveStore,
  now: () => ++clock, newId: () => 'ws_native_' + ++idSeq, scanText: text => ({ ok: !/leak credentials/i.test(text) }),
  hasActiveRun: () => targetBusy,
  sync: (next, previous, changes) => { if (mirrorFailed) throw new Error('native mirror unavailable'); mirrors.push({ next, previous, changes }); return true; } }); }
function meta(requestId) { return { requestId, expectedRevision: saveStore.load('agent')._saveRevision }; }
const hero = { id: 'agent', name: 'CHIEF OF STAFF', role: 'orchestrator', provider: 'codex', model: 'gpt-5.6-sol',
  reasoningEffort: 'medium', approvalMode: 'ask', executionProfile: 'trusted-project', skin: 'o',
  personaId: 'composed', skills: ['existing'], custom: { retained: true }, stats: { earned: 42 },
  docs: { identity: 'Owner-authored identity', purpose: 'Original goal', context: 'Owner workspace context', manual: 'Original manual\n\nFLO COMPANY CONTRACT\nInternal worker-to-worker delegation is disabled.\nOwner note after contract: preserve my product references.' } };
const researcher = { ...hero, id: 'researcher', name: 'RESEARCH', role: 'specialist', custom: { untouched: true } };
const wm = WorldModel.create(); assert.equal(wm.ensureWorkstation('agent').ok, true);
const initial = { _saveRevision: 0, agent: hero, agents: [hero, researcher], station: wm.serialize(),
  workstreams: [{ id: 'general', title: null, agentId: 'agent', kind: 'chat', lane: 'active',
    history: [{ role: 'user', content: 'Prior owner conversation' }], lastReadAt: 0, lastActiveAt: 500, custom: 'preserve' }],
  activeId: 'general', generalId: 'general', deletedIds: ['old-deleted'], usage: { usd: 6 },
  grants: { preserve: ['everything'] }, releaseRecords: [{ preserve: true }], otherSettings: { a: true } };
(async () => { try {
  assert.equal(saveStore.save('agent', initial, { compareRevision: true }).ok, true);
  let native = instance();
  const before = saveStore.load('agent');
  assert.equal(native.snapshot().capabilities.recruitment, true);
  assert.equal(native.request('station.layout', {}).result.coordinate_frame, 'native world tiles');
  assert.equal(native.summon({ name: 'DESIGNER', specId: 'designer', provider: 'openrouter' }, meta('bad-provider')).code, 400);
  assert.equal(native.summon({ name: 'DESIGNER', specId: 'designer' }, {}).code, 400);
  assert.equal(native.summon({ name: 'BAD', purpose: 'leak credentials' }, meta('bad-text')).ok, false);
  assert.equal(native.summon({ name: 'BAD', specId: '../../outside' }, meta('bad-id')).code, 400);
  assert.equal(fs.existsSync(path.join(root, '_flo.native.backups')), false, 'invalid changes write no recovery snapshot');
  const request = { name: 'DESIGNER', specId: 'designer' }, m = meta('run-1:summon-1');
  const recruited = native.summon(request, m); assert.equal(recruited.ok, true, recruited.error);
  const after = saveStore.load('agent'), worker = after.agents.find(a => a.id === recruited.result.agentId);
  assert.equal(after.agents.length, before.agents.length + 1);
  for (const prior of before.agents) assert.deepEqual(after.agents.find(a => a.id === prior.id), prior, 'old crew state preserved byte-for-byte');
  for (const key of ['agent', 'usage', 'grants', 'releaseRecords', 'otherSettings', 'activeId', 'generalId', 'deletedIds']) assert.deepEqual(after[key], before[key]);
  for (const old of before.workstreams) assert.deepEqual(after.workstreams.find(w => w.id === old.id), old, 'headless work does not mark existing conversation read');
  for (const prop of before.station.props) assert.deepEqual(after.station.props.find(p => p.id === prop.id), prop);
  assert.equal(worker.provider, 'codex'); assert.equal(worker.model, hero.model); assert.equal(worker.reasoningEffort, 'medium');
  assert.equal(worker.approvalMode, 'ask'); assert.equal(worker.executionProfile, 'trusted-project'); assert.equal(worker.skin, 'o');
  assert.deepEqual(worker.skills, Specialties.get('designer').skills);
  assert.equal(worker.docs.purpose, Specialties.compose('designer').purpose);
  assert.ok(worker.docs.manual.includes(Specialties.compose('designer').manual)); assert.ok(worker.docs.manual.includes(NATIVE_CONTRACT));
  assert.ok(worker.systemPrompt.includes(worker.docs.purpose));
  assert.equal(after.station.props.find(p => p.id === recruited.result.workstation_id).agentId, worker.id);
  assert.ok(after.workstreams.some(w => w.id === recruited.result.session_id && w.agentId === worker.id));
  assert.equal(fs.statSync(path.join(root, '_flo.native.backups', recruited.result.backup_id)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '_flo.native.backups', recruited.result.backup_id))).canonical_save, before);
  native = instance(); // receipts and actual roster/desk survive restart
  const replay = native.summon(request, m); assert.equal(replay.ok, true); assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.agentId, worker.id); assert.equal(saveStore.load('agent').agents.length, after.agents.length);
  assert.equal(native.summon({ ...request, name: 'SECOND DESIGNER' }, m).code, 409);
  assert.equal(native.summon({ name: 'ANALYST', specId: 'analyst' }, { requestId: 'stale-request', expectedRevision: m.expectedRevision }).code, 409);
  targetBusy = true; assert.equal(native.summon({ name: 'ANALYST', specId: 'analyst' }, meta('busy')).code, 409); targetBusy = false;

  const task = native.request('station.new_task', { title: 'Review real artifact', agentId: worker.id }, meta('make-task'));
  assert.equal(task.ok, true, task.error); assert.equal(task.result.created, true);
  assert.equal(native.request('station.manage_task', { task: task.result.id, action: 'move', lane: 'shipped' }, meta('auto-ship')).code, 403);
  assert.equal(native.request('station.manage_task', { task: task.result.id, action: 'remove' }, meta('auto-delete')).code, 403);
  assert.equal(native.request('station.manage_task', { task: task.result.id, action: 'move', lane: 'active' }, meta('task-work')).ok, true);
  assert.equal(native.request('station.new_session', { title: 'Private research', agentId: worker.id }, meta('session')).ok, true);
  assert.equal(native.request('station.new_session', { title: 'Steal focus', focus: true }, meta('focus')).ok, false);
  assert.equal(saveStore.load('agent').activeId, 'general');
  assert.equal(native.request('station.read_session', { session: 'General' }).result.turns[0].text, 'Prior owner conversation');
  const oldManual = worker.docs.manual;
  const config = native.request('station.update_agent', { agentId: worker.id, field: 'purpose', previousText: worker.docs.purpose, text: 'Produce original reviewable product artwork.' }, meta('config'));
  assert.equal(config.ok, true, config.error);
  const edited = saveStore.load('agent').agents.find(a => a.id === worker.id);
  assert.equal(edited.docs.manual, oldManual); assert.equal(edited.approvalMode, worker.approvalMode); assert.deepEqual(edited.skills, worker.skills);
  assert.equal(native.request('station.update_agent', { agentId: worker.id, field: 'purpose', previousText: 'stale', text: 'Another goal' }, meta('config-stale')).ok, false);
  assert.equal(native.request('station.update_agent', { agentId: worker.id, field: 'approvalMode', previousText: 'ask', text: 'full' }, meta('grant')).ok, false);

  const floorBefore = saveStore.load('agent');
  const buildArgs = { actions: [
    { op: 'room', ref: 'new-room', kind: 'factory', name: 'Artifact production', rect: { x1: 23, y1: 0, x2: 42, y2: 12 } },
    { op: 'prop', ref: 'pc', type: 'desk', x: 25, y: 1, agentId: worker.id },
    { op: 'prop', ref: 'files', type: 'war_intelcab', x: 29, y: 1 },
    { op: 'prop', ref: 'web', type: 'comms_dish', x: 32, y: 1 },
    { op: 'prop', ref: 'in', type: 'intake', x: 25, y: 7, label: 'Original assets' },
    { op: 'prop', ref: 'bay', type: 'bay', x: 31, y: 7, agentId: worker.id, brief: 'Produce and save original artifact files; cite evidence.' },
    { op: 'prop', ref: 'out', type: 'outbox', x: 37, y: 7 },
    { op: 'belt', from: 'in', to: 'bay' }, { op: 'belt', from: 'bay', to: 'out' }
  ] };
  const built = native.request('station.build', buildArgs, meta('build-real-line'));
  assert.equal(built.ok, true, built.error); assert.equal(built.result.routing_valid, true); assert.equal(built.result.starts_work, false);
  const floorAfter = saveStore.load('agent');
  for (const [id, room] of Object.entries(floorBefore.station.rooms)) assert.deepEqual(floorAfter.station.rooms[id], room);
  for (const prop of floorBefore.station.props) assert.deepEqual(floorAfter.station.props.find(p => p.id === prop.id), prop);
  assert.ok(Object.keys(floorAfter.station.belts).length > Object.keys(floorBefore.station.belts).length);
  for (const key of ['grants', 'usage', 'otherSettings']) assert.deepEqual(floorAfter[key], floorBefore[key]);
  const layout = instance().request('station.layout', {}).result;
  assert.ok(layout.rooms.some(r => r.name === 'Artifact production')); assert.ok(layout.props.some(p => p.capability === 'cabinet'));
  assert.equal(native.request('station.build', { actions: [{ op: 'prop', type: 'workbench', x: 25, y: 4 }] }, meta('shell-gear')).ok, false);
  assert.equal(native.request('station.build', { actions: [{ op: 'prop', type: 'unknown_fake_dish', x: 25, y: 4 }] }, meta('fake-gear')).ok, false);
  assert.equal(native.request('station.build', { actions: [{ op: 'delete', id: 'r1' }] }, meta('remove-room')).ok, false);
  assert.equal(native.request('station.build', { actions: [{ op: 'prop', type: 'bay', x: 25, y: 4, agentId: '../../DJR' }] }, meta('bad-binding')).ok, false);
  assert.equal(native.request('station.build', { actions: [{ op: 'room', kind: 'factory', name: 'Too large', rect: { x1: -240, y1: 0, x2: 240, y2: 10 } }] }, meta('oversize-floor')).ok, false);
  const rejectedBefore = saveStore.load('agent');
  assert.equal(native.request('station.build', { actions: [
    { op: 'room', kind: 'factory', name: 'Should roll back', rect: { x1: 47, y1: 0, x2: 56, y2: 8 } },
    { op: 'prop', type: 'desk', x: 100, y: 100 }
  ] }, meta('failed-batch')).ok, false);
  assert.deepEqual(saveStore.load('agent'), rejectedBefore, 'a partially staged batch has no canonical effect');

  // A late competing canonical save wins; the CAS rejects this mutation even
  // after its recovery snapshot was prepared. There is no split roster commit.
  let raced = false;
  const racingStore = { loadState: id => saveStore.loadState(id), save: (id, next, opts) => {
    if (!raced) { raced = true; const competing = saveStore.load(id); competing.otherSettings.competing = true;
      assert.equal(saveStore.save(id, competing, { compareRevision: true }).ok, true); }
    return saveStore.save(id, next, opts);
  } };
  const racing = makeFloNativeStation({ fs, path, workspaces: root, writeDurable: writeFileDurable, saveStore: racingStore,
    now: () => ++clock, newId: () => 'ws_native_' + ++idSeq, scanText: () => ({ ok: true }), sync: () => true });
  const raceBefore = saveStore.load('agent'), race = racing.summon({ name: 'ANALYST', specId: 'analyst' }, meta('cas-race'));
  assert.equal(race.code, 409); assert.equal(race.stale, true);
  assert.equal(saveStore.load('agent').agents.length, raceBefore.agents.length);
  assert.equal(saveStore.load('agent').otherSettings.competing, true);

  mirrorFailed = true;
  const partialMeta = meta('mirror-retry'), partial = native.summon({ name: 'ANALYST', specId: 'analyst' }, partialMeta);
  assert.equal(partial.ok, false); assert.equal(partial.partial, true); assert.equal(partial.code, 503);
  const count = saveStore.load('agent').agents.length;
  mirrorFailed = false;
  const repaired = instance().summon({ name: 'ANALYST', specId: 'analyst' }, partialMeta);
  assert.equal(repaired.ok, true); assert.equal(repaired.result.replayed, true); assert.equal(saveStore.load('agent').agents.length, count);
  assert.equal(mirrors.at(-1).changes.recovery_basis, true);
  assert.equal(mirrors.at(-1).previous.agents.length, count - 1, 'partial replay repairs from the real pre-mutation save');
  const upgraded = upgradeContracts(initial);
  assert.equal(initial.agents[0].docs.manual.includes('delegation is disabled'), true, 'contract helper never mutates caller data');
  assert.ok(upgraded.agents[0].docs.manual.startsWith('Original manual\n\n'));
  assert.ok(upgraded.agents[0].docs.manual.includes(NATIVE_CONTRACT));
  assert.ok(upgraded.agents[0].docs.manual.includes('Owner note after contract: preserve my product references.'));
  assert.equal(upgraded.agents[0].docs.manual.includes('delegation is disabled'), false);
  assert.deepEqual(upgraded.station, initial.station); assert.deepEqual(upgraded.grants, initial.grants);
  assert.deepEqual(upgradeContracts(upgraded), upgraded, 'contract upgrade is idempotent');
  const systemPrefix = 'OWNER PERSONA HEADER\nKeep my original style and role.\n\nYOUR PURPOSE: original product research\n\nSTANDING ORDERS: Original manual';
  const systemSuffix = 'Owner note after contract: retain my product references.\n\nABOUT YOUR COMMANDER: Preserve this unrelated owner context and notes.';
  const upgradedSystem = upgradeGeneratedContract(systemPrefix + '\n\nFLO COMPANY CONTRACT\n'
    + 'Internal worker-to-worker delegation is disabled. Do not use team.dispatch or team.summon.\n'
    + systemSuffix);
  assert.ok(upgradedSystem.startsWith(systemPrefix + '\n\n' + NATIVE_CONTRACT));
  assert.ok(upgradedSystem.endsWith(systemSuffix));
  assert.equal(upgradedSystem.includes('delegation is disabled'), false);
  assert.equal(upgradeGeneratedContract(upgradedSystem), upgradedSystem, 'the pruned-backup prompt repair is idempotent and retains owner prefix/suffix');
  const beforeEnrollment = saveStore.load('agent'), enrollmentMeta = meta('native-enrollment');
  const enrolled = native.enroll(enrollmentMeta); assert.equal(enrolled.ok, true, enrolled.error);
  assert.equal(enrolled.result.permissions_changed, false); assert.equal(enrolled.result.starts_work, false);
  const nativeSave = saveStore.load('agent');
  assert.equal(nativeSave.agent.docs.manual.includes('delegation is disabled'), false);
  for (const key of ['station', 'grants', 'usage', 'releaseRecords', 'workstreams', 'activeId', 'generalId']) assert.deepEqual(nativeSave[key], beforeEnrollment[key]);
  for (const a of beforeEnrollment.agents) for (const key of ['provider', 'model', 'reasoningEffort', 'approvalMode', 'executionProfile', 'stats', 'custom']) assert.deepEqual(nativeSave.agents.find(n => n.id === a.id)[key], a[key]);
  assert.equal(instance().enroll(enrollmentMeta).result.replayed, true);
  const readback = makeFloNativeStation({ fs, path, workspaces: root, writeDurable: writeFileDurable, saveStore,
    now: () => ++clock, newId: () => 'ws_native_' + ++idSeq, scanText: () => ({ ok: true }), sync: () => true,
    readSession: () => [{ role: 'assistant', content: 'Actual persisted native worker result.' }] });
  assert.equal(readback.request('station.read_session', { session: 'General' }).result.turns[0].text, 'Actual persisted native worker result.');
  const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
  const actualSummon = makeOrchestrationTools({ runOnce: () => { throw new Error('No model run is allowed in this test'); },
    roster: () => new Map(), newId: () => 'unused', classes: Specialties.list() }).summonTool;
  const toolResult = await actualSummon.run({ name: 'CATALOG SPECIALIST', specId: 'analyst' }, {
    summon: spec => { assert.equal(spec.persona, ''); assert.equal(spec.skin, '');
      const result = instance().summon(spec, meta('real-tool-summon'));
      assert.equal(result.ok, true, result.error); return result.result; }
  });
  assert.match(toolResult.summary, /^summoned analyst/);
  assert.ok(saveStore.load('agent').agents.some(a => a.name === 'CATALOG SPECIALIST'));
  const catalog = native.snapshot().build_catalog;
  assert.deepEqual(catalog.room_kinds.map(r => r.kind).sort(), Object.keys(WorldModel.ROOM_KINDS).sort());
  const nativeCatalog = require('../frontend/app/prop-catalog-data.js');
  for (const item of catalog.props) {
    const art = nativeCatalog.views.find(v => v.id === item.type && v.r === 0);
    assert.deepEqual(item.footprint, art.footprint); assert.equal(item.required_mount, null);
    assert.ok(['computer', 'cabinet', 'dish', 'notebook'].includes(item.capability) || ['intake', 'bay', 'outbox'].includes(item.type));
  }
  assert.ok(catalog.props.some(p => p.type === 'desk'));
  assert.equal(catalog.props.some(p => /workbench|browser|terminal/.test(p.type)), false);
  const backupDir = path.join(root, '_flo.native.backups');
  fs.writeFileSync(path.join(backupDir, 'owner-notes.txt'), 'Preserve this unrelated file');
  for (let n = 0; n < 35; n++) fs.writeFileSync(path.join(backupDir, n.toString(16).padStart(64, '0') + '.json'), '{}', { mode: 0o600 });
  assert.equal(native.request('station.new_task', { title: 'Bounded recovery points' }, meta('prune-recoveries')).ok, true);
  assert.ok(fs.existsSync(path.join(backupDir, 'owner-notes.txt')));
  assert.ok(fs.readdirSync(backupDir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).length <= 32);
  // Browser execution remains unchanged: Personas is still a global there,
  // while the guarded export lets this host reuse the exact preset engine.
  const vm = require('node:vm'), browserPersona = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/personas.js'), 'utf8') + '\nthis.nativePersona = Personas;', browserPersona);
  assert.equal(browserPersona.nativePersona.compose('composed'), require('../frontend/app/personas.js').compose('composed'));
  for (let n = 0; n < 130; n++) assert.equal(native.request('station.new_task', { title: 'Ledger rollover ' + n }, meta('rollover-' + n)).ok, true);
  const rolled = saveStore.load('agent');
  assert.equal(rolled.floNative.receipts.length, 128);
  assert.ok(rolled.floNative.retired_receipts.length > 0);
  assert.equal(instance().summon(request, m).retired_receipt, true, 'retired request ID cannot create another specialist after restart');
  assert.equal(instance().enroll(enrollmentMeta).retired_receipt, true, 'an expired enrollment request remains a refused mutation');
  const repairedEnrollment = instance().repairMirrors(enrollmentMeta);
  assert.equal(repairedEnrollment.ok, true, repairedEnrollment.error);
  assert.equal(repairedEnrollment.result.enrollment_receipt, 'retired');
  assert.equal(repairedEnrollment.result.canonical_changed, false);
  assert.equal(mirrors.at(-1).changes.read_only, true);
  assert.equal(mirrors.at(-1).changes.enrollment_verified, true);
  assert.equal(instance().repairMirrors({ requestId: 'never-enrolled' }).code, 409);
  assert.equal(instance().repairMirrors(m).code, 409, 'a proven recruitment request cannot substitute for an enrollment proof');
  assert.deepEqual(saveStore.load('agent'), rolled);
  const capped = JSON.parse(JSON.stringify(rolled));
  const crypto = require('node:crypto');
  while (capped.floNative.retired_receipts.length < 4096) capped.floNative.retired_receipts.push({
    request_hash: crypto.createHash('sha256').update('review-limit-' + capped.floNative.retired_receipts.length).digest('hex'), fingerprint: '0'.repeat(64)
  });
  assert.equal(saveStore.save('agent', capped, { compareRevision: true }).ok, true);
  assert.equal(instance().request('station.new_task', { title: 'No silent eviction' }, meta('after-ledger-limit')).ledger_review_required, true);
  assert.equal(instance().request('station.new_task', { title: 'Ledger rollover 129' }, { requestId: 'rollover-129' }).result.replayed, true, 'recorded recent calls remain replayable at the review limit');
  const cappedBeforeRepair = saveStore.load('agent');
  assert.equal(instance().repairMirrors(enrollmentMeta).ok, true, 'read-only enrollment repair does not add or evict ledger entries at the review limit');
  assert.deepEqual(saveStore.load('agent'), cappedBeforeRepair);
  console.log('flo-native-station: real class/desk recruitment, canonical tasks/config/Build, private snapshots, CAS/replay/restart, preservation and refusal passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); } })().catch(e => { console.error(e); process.exitCode = 1; });
