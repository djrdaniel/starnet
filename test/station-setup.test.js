'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { makeStationSetup, CREW, BOUNDARY, fixedFloor } = require('../sidecar/station-setup.js');
const { makeFloOperation } = require('../sidecar/flo-operation.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const Dossier = require('../frontend/app/dossier.js'), WM = require('../frontend/app/worldmodel.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-setup-test-'));
let time = 1000, busy = false, mirrorFails = false, effects = [];
const operation = makeFloOperation({ fs, path, workspaces: root, writeDurable: writeFileDurable });
const saveStore = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => ++time } });
const setup = makeStationSetup({ fs, path, workspaces: root, saveStore, operation, now: () => ++time,
  writeDurable: writeFileDurable, busy: () => busy,
  syncBrief: () => { assert.equal(operation.snapshot().mode, 'flo-managed'); if (mirrorFails) throw new Error('mirror failed'); effects.push('brief'); },
  syncFloor: () => { assert.equal(operation.snapshot().mode, 'flo-managed'); effects.push('floor'); } });
try {
  operation.assertAdmission({}, null);
  const agents = CREW.map(id => ({ id, name: id, provider: 'codex', model: 'gpt-5.6-sol', approvalMode: 'ask',
    executionProfile: 'trusted-project', reasoningEffort: 'medium', skills: ['preserve'], custom: { untouched: true },
    systemPrompt: 'PERSONA\nOld role\n\nFLO COMPANY CONTRACT\nOld contract\nDOSSIER KEEP',
    docs: { identity: 'Keep my identity', manual: 'Old role\n\nFLO COMPANY CONTRACT\nOld contract' } }));
  const dossier = Dossier.fresh(); Dossier.upsert(dossier, 'people', { text: 'Existing audience fact', weight: 'observed' }, time);
  const station = WM.create();
  saveStore.save('agent', { _saveRevision: 0, agent: agents[0], agents, dossier, station: station.serialize(), extra: { untouched: true } }, { compareRevision: true });
  const before = saveStore.load('agent'), brief = { expected_revision: before._saveRevision,
    direction: 'Original Etsy and itch digital products to fund DJR.', owner_context: 'Flo is my personal assistant and workspace controlling my projects.',
    standing_orders: 'Research and draft automatically; ask me before publishing, production changes or spending.' };
  assert.equal(setup.brief({ ...brief, grant: true }).code, 400);
  assert.equal(setup.brief({ ...brief, direction: 'x'.repeat(281) }).code, 400);
  assert.equal(setup.brief({ ...brief, expected_revision: 0 }).code, 409);
  busy = true; assert.equal(setup.brief(brief).code, 409); busy = false;
  assert.equal(fs.existsSync(path.join(root, '_flo.setup.backups')), false, 'rejected changes create no backup or policy');
  const result = setup.brief(brief); assert.equal(result.ok, true); assert.equal(result.grounding.ready, true);
  const after = saveStore.load('agent');
  assert.deepEqual(after.extra, before.extra); assert.deepEqual(after.station, before.station);
  assert.equal(after.dossier.dims.people[0].text, 'Existing audience fact');
  assert.ok(after.dossier.dims.standing_orders.some(b => b.text === BOUNDARY));
  for (let i = 0; i < agents.length; i++) {
    const prior = before.agents[i], current = after.agents[i];
    for (const key of ['name', 'provider', 'model', 'approvalMode', 'executionProfile', 'reasoningEffort', 'skills', 'custom']) assert.deepEqual(current[key], prior[key]);
    assert.ok(current.docs.manual.startsWith('Old role\n\n'));
    assert.ok(current.docs.manual.includes('Internal worker-to-worker delegation is disabled'));
    assert.ok(current.systemPrompt.endsWith('DOSSIER KEEP'), 'unrelated persona tail survives exact manual replacement');
  }
  const backup = JSON.parse(fs.readFileSync(path.join(root, '_flo.setup.backups', result.backup_id)));
  assert.deepEqual(backup.canonical_save, before); assert.equal(fs.statSync(path.join(root, '_flo.setup.backups', result.backup_id)).mode & 0o777, 0o600);
  assert.throws(() => operation.assertAdmission({}, null), /Flo must explicitly admit/);
  operation.assertAdmission({ surface: 'interactive' }, null); operation.assertAdmission({}, { id: 'flo-research' });
  assert.throws(() => operation.assertAdmission({ surface: 'interactive', internal: true }, null), /Flo must explicitly admit/, 'browser idle autopilot cannot disguise autonomous work as a watched run');
  const rebooted = makeFloOperation({ fs, path, workspaces: root, writeDurable: writeFileDurable });
  assert.throws(() => rebooted.assertAdmission({}, null), /Flo must explicitly admit/);
  const replay = setup.brief({ ...brief, expected_revision: result.revision }); assert.equal(replay.ok, true); assert.equal(replay.changed, false);
  assert.equal(replay.revision, result.revision, 'identical brief does not add beliefs or revision');
  const preview = setup.proposal(); assert.equal(preview.ok, true); assert.equal(preview.starts_work, false);
  assert.equal(preview.additions.props, 10); assert.equal(preview.budget.provider_spend_authority, 'unchanged');
  assert.equal(setup.setup({ confirm: true, expected_revision: replay.revision, proposal_hash: 'f'.repeat(64) }).code, 409);
  const floor = setup.setup({ confirm: true, expected_revision: preview.expected_revision, proposal_hash: preview.proposal_hash }); assert.equal(floor.ok, true);
  const built = saveStore.load('agent');
  for (const [id, room] of Object.entries(before.station.rooms)) assert.deepEqual(built.station.rooms[id], room);
  for (const prop of before.station.props) assert.deepEqual(built.station.props.find(p => p.id === prop.id), prop);
  assert.equal(built.station.props.length, before.station.props.length + 10);
  const same = fixedFloor(built); assert.equal(same.already_applied, true); assert.deepEqual(same.doc, built);
  assert.equal(setup.setup({ confirm: true, expected_revision: preview.expected_revision, proposal_hash: preview.proposal_hash }).code, 409, 'old revision cannot replay after apply');
  const latest = setup.proposal(); assert.equal(latest.already_applied, true);
  assert.equal(setup.setup({ confirm: true, expected_revision: latest.expected_revision, proposal_hash: latest.proposal_hash }).changed, false);
  mirrorFails = true;
  const partial = setup.brief({ ...brief, expected_revision: built._saveRevision, direction: 'Revised owner direction.' });
  assert.equal(partial.code, 503); assert.equal(partial.partial, true); assert.ok(partial.backup_id);
  assert.throws(() => operation.assertAdmission({}, null), /Flo must explicitly admit/);
  const brokenRoot = path.join(root, 'broken'); fs.mkdirSync(brokenRoot); fs.writeFileSync(path.join(brokenRoot, '_flo.operation.json'), 'BROKEN');
  const broken = makeFloOperation({ fs, path, workspaces: brokenRoot, writeDurable: writeFileDurable });
  assert.throws(() => broken.assertAdmission({}, null), /Flo must explicitly admit/, 'corrupt host policy fails closed');
  console.log('station-setup: canonical brief/provenance, CAS, native fixed Build, replay, private backups, preserved settings and fail-closed admission passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
