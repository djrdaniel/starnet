'use strict';

// Owner-controlled setup through the native dossier, readiness and world-model
// engines. No model, permission grant, timer or worker dispatch is involved.
const Dossier = require('../frontend/app/dossier.js');
const Understanding = require('../frontend/app/understanding.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const { makeStationStore } = require('./station-store.js');
const crypto = require('node:crypto');
const clone = x => JSON.parse(JSON.stringify(x));
const CREW = ['agent', 'researcher', 'strategist', 'reviewer'];
const BOUNDARY = 'Flo manages work admission. Work starts only when Flo explicitly admits a named worker job. No independent routine, nightshift, workshop or worker-to-worker admissions. Publishing, spending and production changes require owner approval in Flo.';
const MANUAL_MARKER = 'FLO COMPANY CONTRACT';
const ROLE_WORK = {
  agent: 'Coordinate the commerce mission through Flo. Propose the next Research, Product Manager or QA handoff to Flo with evidence and acceptance criteria.',
  researcher: 'Research original digital product opportunities for Etsy, itch and other low-maintenance income to fund DJR, using only the evidence and research tools Flo explicitly supplies. Cite evidence and uncertainty; propose the Product Manager handoff to Flo.',
  strategist: 'Act as Product Manager: turn researched opportunities into original, scoped product briefs and draft plans with demand evidence, effort, differentiation and a clear QA checklist. Propose the QA handoff to Flo.',
  reviewer: 'Review evidence, originality, product quality and market claims. Return a concrete verdict and corrections to Flo before owner review of external actions.'
};
function fail(code, error, extra) { return Object.assign({ ok: false, code, error }, extra || {}); }
function revision(doc) { return Number.isSafeInteger(doc && doc._saveRevision) ? doc._saveRevision : 0; }
function exact(body, keys) { return body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(body, k)); }
function ownerText(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 280
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }
function contract(id) { return MANUAL_MARKER + '\n' + BOUNDARY
  + '\nInternal worker-to-worker delegation is disabled. Do not use team.dispatch or team.summon.'
  + '\n' + ROLE_WORK[id] + '\nUse only this job\'s explicit Flo capability profile and supplied context. Return results and proposed next steps to Flo; Flo owns automatic handoffs, evidence, approvals and the owner-facing record.'; }
function updateCrew(doc) {
  const ids = new Set((doc.agents || []).map(a => a.id));
  if (!CREW.every(id => ids.has(id))) return false;
  for (const worker of doc.agents) if (CREW.includes(worker.id)) {
    const old = String(worker.docs && worker.docs.manual || '');
    const prefix = old.includes(MANUAL_MARKER) ? old.slice(0, old.indexOf(MANUAL_MARKER)).trimEnd() : old.trimEnd();
    const manual = (prefix ? prefix + '\n\n' : '') + contract(worker.id);
    worker.docs = Object.assign({}, worker.docs, { manual });
    if (old && typeof worker.systemPrompt === 'string' && worker.systemPrompt.includes(old)) worker.systemPrompt = worker.systemPrompt.replace(old, manual);
  }
  if (doc.agent && CREW.includes(doc.agent.id)) {
    const matching = doc.agents.find(a => a.id === doc.agent.id);
    doc.agent.docs = Object.assign({}, doc.agent.docs, { manual: matching.docs.manual });
  }
  return true;
}
function applyBrief(doc, body, now) {
  const next = clone(doc), dossier = Dossier.hydrate(next.dossier);
  for (const [dim, text] of [['goals', body.direction], ['identity', body.owner_context], ['standing_orders', body.standing_orders]]) {
    const existing = Dossier.beliefs(dossier, dim).find(b => b.source === 'flo-owner-brief');
    if (!existing || existing.text !== text.trim()) Dossier.upsert(dossier, dim, { id: existing && existing.id,
      text: text.trim(), source: 'flo-owner-brief', weight: 'stated', evidenceRef: { kind: 'flo-owner-brief' } }, now);
  }
  const priorBoundary = Dossier.beliefs(dossier, 'standing_orders').find(b => b.source === 'flo-operation-boundary');
  if (!priorBoundary || priorBoundary.text !== BOUNDARY) Dossier.upsert(dossier, 'standing_orders', {
    id: priorBoundary && priorBoundary.id, text: BOUNDARY, source: 'flo-operation-boundary', weight: 'stated',
    evidenceRef: { kind: 'flo-owner-setup' } }, now);
  next.dossier = dossier;
  if (!updateCrew(next)) return fail(409, 'The fixed four-worker crew must exist before Flo setup.');
  return { ok: true, doc: next, dossier, readiness: Understanding.readiness(dossier) };
}

function fixedFloor(doc) {
  if (!doc || !doc.station) return fail(409, 'A saved native station is required.');
  const checked = makeStationStore().validateStationDoc(doc.station);
  if (!checked.ok || !checked.routingOk) return fail(409, 'The existing native floor must validate before adding the commerce room.');
  if (doc.floSetup && doc.floSetup.floor_version === 1) return { ok: true, already_applied: true, doc: clone(doc), plan: checked.routingPlan, additions: { rooms: [], workers: CREW, line: 'Flo commerce' } };
  if (!CREW.every(id => (doc.agents || []).some(a => a.id === id))) return fail(409, 'The fixed four-worker crew must exist before floor setup.');
  const station = WorldModel.deserialize(doc.station), rooms = station.rooms();
  const rects = rooms.flatMap(r => r.rects || []);
  const x = Math.max(...rects.map(r => r.x2)) + 5, y = Math.min(...rects.map(r => r.y1));
  function checkedResult(result) { if (!result || !result.ok) throw new Error(result && (result.error || result.message || result.code) || 'Native Build rejected a placement'); return result; }
  try {
    const room = checkedResult(station.addRoom({ kind: 'factory', name: 'Flo commerce', rect: { x1: x, y1: y, x2: x + 30, y2: y + 9 } }));
    // Additive PCs: existing HOME desks and their agent bindings remain intact.
    for (let i = 0; i < CREW.length; i++) checkedResult(station.addProp({ t: 'desk', x: x + 3 + i * 6, y: y + 1, w: 2, h: 1, agentId: CREW[i] }));
    const intake = checkedResult(station.addProp({ t: 'intake', x: x + 2, y: y + 5, w: 2, h: 2 }));
    checkedResult(station.setPropLabel(intake.id, 'Flo commerce'));
    let prior = intake.id;
    const bays = [];
    for (let i = 0; i < CREW.length; i++) {
      const bay = checkedResult(station.addProp({ t: 'bay', x: x + 7 + i * 5, y: y + 5, w: 2, h: 2, agentId: CREW[i] }));
      checkedResult(station.setPropBrief(bay.id, ROLE_WORK[CREW[i]]));
      checkedResult(station.connectBelt(prior, bay.id)); prior = bay.id; bays.push(bay.id);
    }
    const outbox = checkedResult(station.addProp({ t: 'outbox', x: x + 27, y: y + 5, w: 2, h: 2 }));
    checkedResult(station.connectBelt(prior, outbox.id));
    const updated = clone(doc); updated.station = station.serialize();
    const proven = makeStationStore().validateStationDoc(updated.station);
    if (!proven.ok || !proven.routingOk) return fail(409, 'The fixed commerce layout did not pass native routing validation.');
    updated.floSetup = Object.assign({}, updated.floSetup, { floor_version: 1, room_id: room.id, intake_id: intake.id, bays, outbox_id: outbox.id });
    return { ok: true, already_applied: false, doc: updated, plan: proven.routingPlan,
      additions: { rooms: [{ id: room.id, name: 'Flo commerce', kind: 'factory' }], workers: CREW,
        props: 10, line: 'Flo commerce', flow: ['CHIEF OF STAFF', 'RESEARCH', 'PRODUCT LEAD', 'QA REVIEWER'],
        rooms_preserved: rooms.length, props_preserved: station.props().length - 10 } };
  } catch (_) { return fail(409, 'Native Build rejected the fixed commerce layout.'); }
}

function makeStationSetup(deps) {
  const now = deps.now, fs = deps.fs, path = deps.path;
  function load(expected) {
    const state = deps.saveStore.loadState('agent');
    if (!state || !['ok', 'recovered'].includes(state.status)) return fail(503, 'The canonical native save is unavailable.');
    if (expected !== undefined && revision(state.doc) !== expected) return fail(409, 'The station changed. Review the current revision before applying setup.', { stale: true, revision: revision(state.doc) });
    if (deps.busy()) return fail(409, 'Wait for current native work to finish before station setup.');
    return { ok: true, doc: state.doc };
  }
  function backup(doc) {
    const files = {};
    for (const name of ['agent.roster.json', '_commander.dossier.json', '_commander.goals.json', '_commander.autonomy.json', '_flo.operation.json', 'routing.plan.json']) {
      try { files[name] = fs.readFileSync(path.join(deps.workspaces, name), 'utf8'); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; files[name] = null; }
    }
    const payload = JSON.stringify({ version: 1, at: now(), canonical_save: doc, files });
    if (Buffer.byteLength(payload) > 20 * 1024 * 1024) throw new Error('Setup backup exceeds limit');
    const id = String(now()) + '-' + crypto.randomUUID() + '.json';
    const dir = path.join(deps.workspaces, '_flo.setup.backups'); fs.mkdirSync(dir, { recursive: true });
    deps.writeDurable({ fs, path }, path.join(dir, id), payload);
    return id;
  }
  function write(next, previous, kind, effect) {
    const changed = JSON.stringify(next) !== JSON.stringify(previous);
    let backupId, saved;
    try {
      backupId = backup(previous);
      deps.operation.enable(); // BEFORE making native readiness or routing warmer.
      if (changed) {
        saved = deps.saveStore.save('agent', next, { compareRevision: true });
        if (!saved.ok) return fail(saved.conflict ? 409 : 503, 'The native save refused setup.', { backup_id: backupId, operation: deps.operation.snapshot() });
      }
      effect(next);
      return { ok: true, changed, revision: saved ? saved.revision : revision(previous), backup_id: backupId, kind,
        operation: deps.operation.snapshot() };
    } catch (_) {
      return fail(503, 'Station setup could not complete. The local prewrite backup is retained; Flo admission remains fail closed.',
        { partial: !!(saved && saved.ok), revision: saved && saved.revision, backup_id: backupId, operation: deps.operation.snapshot() });
    }
  }
  return {
    brief(body) {
      if (!exact(body, ['expected_revision', 'direction', 'owner_context', 'standing_orders'])
        || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
        || !['direction', 'owner_context', 'standing_orders'].every(k => ownerText(body[k]))) return fail(400, 'A revision and three nonempty owner brief fields of at most 280 characters are required.');
      const current = load(body.expected_revision); if (!current.ok) return current;
      const proposal = applyBrief(current.doc, body, now()); if (!proposal.ok) return proposal;
      const result = write(proposal.doc, current.doc, 'brief', next => deps.syncBrief(next, body, current.doc));
      if (result.ok) result.grounding = { ready: proposal.readiness.ready, reasons: proposal.readiness.reasons };
      return result;
    },
    proposal() {
      const current = load(); if (!current.ok) return current;
      const proposal = fixedFloor(current.doc); if (!proposal.ok) return proposal;
      const hash = crypto.createHash('sha256').update(JSON.stringify({ source: 1, revision: revision(current.doc), station: proposal.doc.station, setup: proposal.doc.floSetup })).digest('hex');
      return { ok: true, schema_version: 1, expected_revision: revision(current.doc), proposal_hash: hash,
        already_applied: proposal.already_applied, additions: proposal.additions,
        budget: { construction: 'Native Build allows placement without a construction currency ledger.',
          provider_spend_authority: 'unchanged', existing_line_limits: 'preserved', automatic_native_admission: false },
        source: ['frontend/app/worldmodel.js', 'frontend/app/pipeline.js'], starts_work: false };
    },
    setup(body) {
      if (!exact(body, ['confirm', 'expected_revision', 'proposal_hash']) || body.confirm !== true
        || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
        || typeof body.proposal_hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.proposal_hash)) return fail(400, 'Confirm the reviewed fixed proposal and its current revision and hash.');
      const current = load(body.expected_revision); if (!current.ok) return current;
      const preview = this.proposal(); if (!preview.ok) return preview;
      if (preview.proposal_hash !== body.proposal_hash) return fail(409, 'The floor proposal changed. Review it again.', { stale: true });
      const proposal = fixedFloor(current.doc); if (!proposal.ok) return proposal;
      return write(proposal.doc, current.doc, 'floor', next => deps.syncFloor(next, proposal.plan));
    }
  };
}

module.exports = { makeStationSetup, applyBrief, fixedFloor, BOUNDARY, CREW };
