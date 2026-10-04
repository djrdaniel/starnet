'use strict';

// Host-owned mutations of the real native station save. All world placement,
// recruitment IDs/classes and workstream records use the same native engines as
// REFIT and the Recruitment Bay. This adapter never changes permissions or runs
// a provider. The caller owns admission and informed consent.
const crypto = require('node:crypto');
const WorldModel = require('../frontend/app/worldmodel.js');
const Specialties = require('../frontend/app/specialties.js');
const AgentId = require('../frontend/app/agentid.js');
const Personas = require('../frontend/app/personas.js');
const Workstreams = require('../frontend/app/workstreams.js');
const PropCatalog = require('../frontend/app/prop-catalog-data.js');
const Dossier = require('../frontend/app/dossier.js');
const { makeStationStore } = require('./station-store.js');
const { validBoardMove, admittedBoardMove } = require('./flo-native-consent.js');

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST = /^[A-Za-z0-9_.:-]{1,180}$/;
const MAX_RECEIPTS = 128;
const MAX_RETIRED_RECEIPTS = 4096;
const MAX_CREW = 32;
const MAX_ACTIONS = 24;
const MAX_BACKUPS = 32;
const SAFE_CAPS = new Set(['computer', 'cabinet', 'dish', 'notebook']);
const MACHINES = new Set(['intake', 'bay', 'outbox']);
const NATIVE_CONTRACT = 'FLO NATIVE STATION CONTRACT\nFlo owns this ongoing commerce operation. Use the real native station tools to recruit needed specialists, organize work, delegate to the crew and build reviewable artifacts in the admitted workspace. The host enforces the operation limits and child capabilities. Physical Etsy products and digital itch products are separate channels. Publishing, purchases, spending, supplier orders, customer messages and production changes require explicit owner approval. Do not modify DJR projects or seek additional credentials, providers, permission grants or host paths. Never report station growth, artifacts or business outcomes without native read-back evidence.';
const NATIVE_BOUNDARY = 'Flo directs native StarNet recruitment, delegation and workspace artifacts within the admitted operation. Publishing, purchases, spending, customer messages and production changes require owner approval. DJR projects and unrelated accounts remain protected.';
const OLD_MARKER = 'FLO COMPANY CONTRACT';
const NEW_MARKER = 'FLO NATIVE STATION CONTRACT';
// Exact generated legacy text only. Owner-authored notes appended to either
// contract remain intact; a marker never authorizes deleting its entire tail.
const LEGACY_LINES = new Set([
  'Flo manages work admission. Work starts only when Flo explicitly admits a named worker job. No independent routine, nightshift, workshop or worker-to-worker admissions. Publishing, spending and production changes require owner approval in Flo.',
  'Internal worker-to-worker delegation is disabled. Do not use team.dispatch or team.summon.',
  'Coordinate the commerce mission through Flo. Propose the next Research, Product Manager or QA handoff to Flo with evidence and acceptance criteria.',
  'Research original digital product opportunities for Etsy, itch and other low-maintenance income to fund DJR, using only the evidence and research tools Flo explicitly supplies. Cite evidence and uncertainty; propose the Product Manager handoff to Flo.',
  'Act as Product Manager: turn researched opportunities into original, scoped product briefs and draft plans with demand evidence, effort, differentiation and a clear QA checklist. Propose the QA handoff to Flo.',
  'Review evidence, originality, product quality and market claims. Return a concrete verdict and corrections to Flo before owner review of external actions.',
  "Use only this job's explicit Flo capability profile and supplied context. Return results and proposed next steps to Flo; Flo owns automatic handoffs, evidence, approvals and the owner-facing record.",
  NATIVE_CONTRACT.split('\n')[1]
]);
const clone = value => JSON.parse(JSON.stringify(value));
const revision = doc => Number.isSafeInteger(doc && doc._saveRevision) ? doc._saveRevision : 0;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
const validText = (value, max, empty) => typeof value === 'string' && value.length <= max
  && (empty || value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
function keys(value, allowed, required) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
    && (required || []).every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function contractManual(old) {
  old = String(old || '');
  const index = [old.indexOf(OLD_MARKER), old.indexOf(NEW_MARKER)].filter(n => n >= 0).sort((a, b) => a - b)[0];
  const prefix = (index === undefined ? old : old.slice(0, index)).trimEnd();
  const suffix = index === undefined ? '' : old.slice(index).split('\n')
    .filter(line => ![OLD_MARKER, NEW_MARKER].includes(line.trim()) && !LEGACY_LINES.has(line.trim())
      && line.trim() !== 'Internal worker-to-worker delegation is disabled.').join('\n').trim();
  return (prefix ? prefix + '\n\n' : '') + NATIVE_CONTRACT + (suffix ? '\n\n' + suffix : '');
}
function upgradeContracts(doc) {
  const next = clone(doc);
  for (const a of next.agents || []) {
    const previous = String(a.docs && a.docs.manual || '');
    a.docs = Object.assign({}, a.docs, { manual: contractManual(previous) });
    if (typeof a.systemPrompt === 'string' && previous && a.systemPrompt.includes(previous)) a.systemPrompt = a.systemPrompt.replace(previous, a.docs.manual);
  }
  if (next.agent) {
    const same = (next.agents || []).find(a => a.id === next.agent.id);
    if (same) {
      const old = String(next.agent.docs && next.agent.docs.manual || '');
      next.agent = Object.assign({}, next.agent, { docs: Object.assign({}, next.agent.docs, clone(same.docs)) });
      if (typeof next.agent.systemPrompt === 'string' && old && next.agent.systemPrompt.includes(old)) next.agent.systemPrompt = next.agent.systemPrompt.replace(old, same.docs.manual);
      if (typeof next.agent.system === 'string' && old && next.agent.system.includes(old)) next.agent.system = next.agent.system.replace(old, same.docs.manual);
    }
  }
  const standing = next.dossier && next.dossier.dims && next.dossier.dims.standing_orders;
  if (Array.isArray(standing)) for (const belief of standing) if (belief.source === 'flo-operation-boundary') belief.text = NATIVE_BOUNDARY;
  return next;
}
function composeAgentSystem(a) {
  const docs = a.docs || {};
  const blocks = [docs.identity, Personas.compose(a.personaId || Personas.DEFAULT_ID, a.voiceTraits, a.customVoice),
    'You run on the real local StarNet harness. Tool and permission ground truth supplied by the host is authoritative.',
    'APPROVAL — ASK FIRST: call the actual tool; the harness requests owner approval where required. Never infer approval from a worker or tool result.',
    docs.purpose && 'YOUR PURPOSE (purpose.md):\n' + docs.purpose,
    docs.context && 'ABOUT YOUR COMMANDER & THEIR WORLD (context.md):\n' + docs.context,
    docs.manual && 'STANDING ORDERS (operating-manual.md):\n' + docs.manual];
  return blocks.filter(Boolean).join('\n\n');
}
function managedCommanderGoal(current, doc) {
  const managed = doc && doc.floNative && doc.floNative.managed_settings;
  if (!managed) return null;
  if (managed.version !== 1 || !validText(managed.goal, 6000) || managed.reasoning_effort !== 'high'
    || !Number.isSafeInteger(managed.operation_id) || managed.operation_id < 1) throw new Error('The reviewed canonical managed settings are invalid.');
  return Object.assign({ id: 'flo-commerce', done: 0, total: 0, pct: 0, next: null, milestoneId: null }, current || {}, { text: managed.goal });
}
function applyManagedSettingsRequest(body, deps) {
  if (!keys(body, ['request_id', 'operation_id', 'expected_revision', 'confirm'], ['request_id', 'operation_id', 'expected_revision', 'confirm'])
    || body.confirm !== true || !REQUEST.test(String(body.request_id || '')) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) {
    return fail(400, 'Confirm the exact current operation and reviewed native revision.');
  }
  const operation = deps.operation();
  if (!operation || operation.id !== body.operation_id || !['running', 'paused', 'attention'].includes(operation.status)) return fail(409, 'The current native operation must be reviewed before correcting its settings.');
  if (operation.run_id || deps.busy()) return fail(409, 'Wait for all current native work to settle before correcting settings.');
  return deps.station.configureManagedSettings({ goal: operation.objective, operation_id: operation.id },
    { requestId: body.request_id, expectedRevision: body.expected_revision, ownerConfirmed: true });
}

function makeFloNativeStation(deps) {
  const d = deps || {};
  if (!d.saveStore || !d.fs || !d.path || !d.workspaces || typeof d.now !== 'function'
    || typeof d.newId !== 'function' || typeof d.writeDurable !== 'function' || typeof d.sync !== 'function') {
    throw new Error('Native station requires the host canonical save, private storage, clock, IDs and mirror callback.');
  }
  const validator = makeStationStore();
  function load() {
    const state = d.saveStore.loadState('agent');
    if (!state || !['ok', 'recovered'].includes(state.status) || !state.doc || !Array.isArray(state.doc.agents)) throw new Error('The canonical station save is unavailable.');
    return state.doc;
  }
  function checkedStation(doc) {
    const result = validator.validateStationDoc(doc.station);
    if (!result.ok || !result.routingOk) throw new Error('The native station floor or routing must validate before this change.');
    return result;
  }
  function scan(text) {
    if (!text) return;
    if (typeof d.scanText !== 'function') throw new Error('Host instruction validation is unavailable.');
    const r = d.scanText(text);
    if (!r || r.ok !== true) throw new Error('The instruction text failed the native instruction scan.');
  }
  function crew(doc, agentId) {
    if (!AgentId.RE.test(String(agentId || ''))) throw new Error('A real crew agent ID is required.');
    const found = doc.agents.find(a => a.id === agentId);
    if (!found) throw new Error('Unknown agent ID; read the crew before changing it.');
    return found;
  }
  function initializeStreams(doc) {
    // A synchronous invocation cannot interleave with another operation. Restore
    // original existing records below: native init is also a browser read marker,
    // which must not claim a headless operation read the owner conversation.
    Workstreams.init(clone(doc));
  }
  function newStream(doc, title, agentId, kind) {
    initializeStreams(doc);
    let id = d.newId();
    if (!ID.test(String(id)) || (doc.workstreams || []).some(w => w.id === id) || (doc.deletedIds || []).includes(id)) throw new Error('Host session ID is invalid or already exists.');
    const at = d.now();
    const row = Workstreams.adopt({ id, title, agentId, kind, lane: 'todo', titleAuto: false,
      createdAt: at, lastActiveAt: at, lastReadAt: at });
    if (!row) throw new Error('Native workstream creation was refused.');
    doc.workstreams = (doc.workstreams || []).concat([clone(row)]);
    return row;
  }
  function resolveStream(doc, ref, kind, archived) {
    const rows = (doc.workstreams || []).filter(w => (!kind || w.kind === kind) && (archived || !w.archived));
    const exact = rows.filter(w => w.id === ref);
    const named = rows.filter(w => String(w.title || (w.id === doc.generalId ? 'General' : '')).toLowerCase() === String(ref || '').trim().toLowerCase());
    const matches = exact.length ? exact : named;
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous session title; use its ID.' : 'No such native session.');
    return matches[0];
  }
  function backup(doc, requestId) {
    const raw = JSON.stringify({ version: 1, at: d.now(), canonical_save: doc });
    if (Buffer.byteLength(raw) > 20 * 1024 * 1024) throw new Error('Station recovery snapshot exceeds its limit.');
    const dir = d.path.join(d.workspaces, '_flo.native.backups');
    d.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const parent = d.fs.realpathSync(d.workspaces), resolvedDir = d.fs.realpathSync(dir);
    const relative = d.path.relative(parent, resolvedDir);
    if (relative === '..' || relative.startsWith('..' + d.path.sep) || d.path.isAbsolute(relative)) throw new Error('Native recovery directory escapes its private workspace.');
    const name = hash(requestId) + '.json';
    d.writeDurable({ fs: d.fs, path: d.path }, d.path.join(resolvedDir, name), raw);
    // Retain bounded canonical recovery points, never a growing archive. Only
    // this adapter's hash-named files inside its private directory are eligible.
    const rows = d.fs.readdirSync(resolvedDir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
      .map(n => ({ name: n, at: n === name ? Infinity : d.fs.statSync(d.path.join(resolvedDir, n)).mtimeMs }));
    rows.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    for (const old of rows.slice(MAX_BACKUPS)) d.fs.unlinkSync(d.path.join(resolvedDir, old.name));
    return name;
  }
  function mirror(next, previous, changes) {
    const result = d.sync(next, previous, changes);
    if (result && typeof result.then === 'function') throw new Error('Native station mirrors must finish synchronously before reporting success.');
    if (result === false || result && result.ok === false) throw new Error('The native roster or routing mirror refused the saved change.');
  }
  function replayBasis(current, requestId) {
    // Repair mirrors against the pre-mutation truth, rather than comparing the
    // committed save to itself. A pruned recovery point is explicit to the host
    // so it can reconstruct generated prompts from their admitted documents.
    const dir = d.path.join(d.workspaces, '_flo.native.backups');
    try {
      const root = d.fs.realpathSync(d.workspaces), resolved = d.fs.realpathSync(dir);
      const relative = d.path.relative(root, resolved);
      if (relative === '..' || relative.startsWith('..' + d.path.sep) || d.path.isAbsolute(relative)) throw new Error('Native recovery directory escapes its private workspace.');
      const file = d.path.join(resolved, hash(requestId) + '.json');
      const realFile = d.fs.realpathSync(file);
      if (d.path.dirname(realFile) !== resolved) throw new Error('Native recovery snapshot escapes its private workspace.');
      if (d.fs.statSync(realFile).size > 20 * 1024 * 1024) throw new Error('Station recovery snapshot exceeds its limit.');
      const record = JSON.parse(d.fs.readFileSync(realFile, 'utf8'));
      const basis = record && record.version === 1 && record.canonical_save;
      if (!basis || !Array.isArray(basis.agents) || revision(basis) >= revision(current)) throw new Error('Native recovery snapshot does not prove the previous station.');
      checkedStation(basis);
      return { previous: basis, recovery_basis: true };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { previous: current, recovery_basis: false };
      throw e;
    }
  }
  function mutate(verb, args, meta, change) {
    meta = meta || {};
    if (!REQUEST.test(String(meta.requestId || ''))) return fail(400, 'A host-owned request ID is required for a station mutation.');
    if (meta.expectedRevision !== undefined && (!Number.isSafeInteger(meta.expectedRevision) || meta.expectedRevision < 0)) return fail(400, 'Invalid expected station revision.');
    let current, saved, backupId;
    try {
      current = load();
      const fingerprint = hash({ verb, args });
      const receipts = current.floNative && current.floNative.receipts || [];
      const retired = current.floNative && current.floNative.retired_receipts || [];
      if (!Array.isArray(receipts) || !Array.isArray(retired) || receipts.length > MAX_RECEIPTS
        || retired.some(r => !r || !/^[a-f0-9]{64}$/.test(r.request_hash || '') || !/^[a-f0-9]{64}$/.test(r.fingerprint || ''))) {
        return fail(503, 'The native station mutation ledger needs owner review before further changes.');
      }
      const prior = receipts.find(r => r.request_id === meta.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) return fail(409, 'This station request ID was already used for different arguments.');
        const basis = replayBasis(current, meta.requestId);
        mirror(current, basis.previous, { replay: true, recovery_basis: basis.recovery_basis, verb, agentId: prior.result.agentId || null });
        return { ok: true, result: Object.assign({}, clone(prior.result), { replayed: true, current_revision: revision(current) }) };
      }
      if (retired.some(r => r.request_hash === hash(meta.requestId))) return fail(409, 'This station request receipt was retired. It cannot be replayed; inspect the current station before issuing a new action.', { retired_receipt: true });
      if (retired.length >= MAX_RETIRED_RECEIPTS) return fail(409, 'The native station mutation ledger reached its review limit. Owner review is required before additional station changes.', { ledger_review_required: true });
      if (meta.expectedRevision !== undefined && meta.expectedRevision !== revision(current)) return fail(409, 'The station changed; inspect its current revision and retry with a new request.', { stale: true, revision: revision(current) });
      if (typeof d.hasActiveRun === 'function' && d.hasActiveRun(meta, verb, args)) return fail(409, 'The targeted crew or station geometry is busy; wait for its active work.');
      const next = clone(current);
      const out = change(next, current);
      if (!out || !out.result) throw new Error('Native station action did not return proof.');
      checkedStation(next);
      const result = Object.assign({}, out.result, { durable: true, revision: revision(current) + 1 });
      const allReceipts = receipts.concat([{
        request_id: meta.requestId, fingerprint, verb, at: d.now(), result: clone(result)
      }]);
      const retiredReceipts = retired.concat(allReceipts.slice(0, Math.max(0, allReceipts.length - MAX_RECEIPTS))
        .map(r => ({ request_hash: hash(r.request_id), fingerprint: r.fingerprint })));
      next.floNative = Object.assign({}, next.floNative, { version: 1,
        receipts: allReceipts.slice(-MAX_RECEIPTS), retired_receipts: retiredReceipts });
      backupId = backup(current, meta.requestId);
      saved = d.saveStore.save('agent', next, { compareRevision: true });
      if (!saved || !saved.ok) return fail(saved && saved.conflict ? 409 : 503, 'The native station save refused this change.', { stale: !!(saved && saved.conflict), backup_id: backupId });
      const committed = load();
      if (revision(committed) !== saved.revision || !(committed.floNative.receipts || []).some(r => r.request_id === meta.requestId && r.fingerprint === fingerprint)) throw new Error('Canonical station read-back did not prove the change.');
      mirror(committed, current, Object.assign({ verb }, out.changes));
      return { ok: true, result: Object.assign({}, result, { revision: saved.revision, backup_id: backupId }) };
    } catch (e) { return fail(saved && saved.ok ? 503 : 400, String(e && e.message || e), { partial: !!(saved && saved.ok), revision: saved && saved.revision, backup_id: backupId }); }
  }
  function buildCatalog() {
    const props = new Map();
    for (const art of PropCatalog.views) {
      const capability = WorldModel.capForProp(art.id);
      if (art.r !== 0 || art.requiredMount || !(SAFE_CAPS.has(capability) || MACHINES.has(art.id)) || props.has(art.id)) continue;
      props.set(art.id, { type: art.id, label: art.label, capability: capability || null,
        footprint: clone(art.footprint), placement: 'floor', required_mount: null, flat: !!art.flat,
        worker_binding: art.id === 'bay' ? 'existing crew required' : capability === 'computer' ? 'optional existing crew' : 'shared station gear' });
    }
    return { room_kinds: Object.entries(WorldModel.ROOM_KINDS).map(([kind, value]) => ({ kind, label: value.label })),
      props: [...props.values()], coordinate_frame: 'native world tiles',
      placement_rules: { additive_only: true, min_room_side: WorldModel.MIN_ROOM,
        max_coordinate_abs: 240, catalog_footprints_only: true, floor_mount_only: true,
        native_geometry_and_routing_validation: true } };
  }
  function layout(doc) {
    const c = checkedStation(doc), station = c.station;
    return { revision: revision(doc), coordinate_frame: 'native world tiles', bounds: station.bounds(),
      rooms: station.rooms().map(r => ({ id: r.id, name: r.name, kind: r.kind, rects: clone(r.rects) })),
      props: station.props().map(p => Object.assign({}, clone(p), { capability: station.capForProp(p.t) })),
      routing: { state: 'validated', deployable: c.routingOk, hash: c.routingPlan.hash, lines: clone(c.routingPlan.lines || []) },
      additive_build: { max_actions: MAX_ACTIONS, allowed_capabilities: [...SAFE_CAPS], workflow_machines: [...MACHINES], catalog: buildCatalog(),
        grants_permissions: false, starts_work: false, limits_preserved: true } };
  }
  function summon(spec, meta) {
    if (!keys(spec, ['name', 'specId', 'purpose', 'persona', 'skin'], ['name']) || !validText(spec.name, 40)
      || spec.specId !== undefined && spec.specId !== '' && !ID.test(spec.specId) || spec.purpose !== undefined && !validText(spec.purpose, 400, true)
      || spec.persona !== undefined && spec.persona !== '' && !ID.test(spec.persona) || spec.skin !== undefined && spec.skin !== '' && !ID.test(spec.skin)) return fail(400, 'Invalid native specialist request; provider, model, permissions and paths cannot be supplied.');
    return mutate('crew.summon', spec, meta, next => {
      if (next.agents.length >= MAX_CREW) throw new Error('The admitted operation reached its 32-worker station limit.');
      const base = spec.specId ? Specialties.get(spec.specId) : null;
      if (spec.specId && !base) throw new Error('Unknown native specialist class.');
      if (spec.purpose) scan(spec.purpose);
      const hero = crew(next, 'agent');
      if (hero.provider !== 'codex') throw new Error('The station must retain its configured ChatGPT OAuth provider.');
      const id = AgentId.alloc(spec.specId || spec.name, new Set(next.agents.map(a => a.id)));
      const name = AgentId.allocName(spec.name || base && base.name, next.agents);
      const patch = Specialties.compose(base || { purpose: spec.purpose || '', manual: '' });
      const worker = { id, name, role: 'specialist', color: base && base.accent || '#6fb3bf', skin: spec.skin || hero.skin || 'g',
        model: hero.model || null, provider: hero.provider, reasoningEffort: hero.reasoningEffort || 'medium',
        personaId: Personas.resolve(spec.persona || base && base.persona || hero.personaId),
        approvalMode: 'ask', executionProfile: 'trusted-project', purpose: spec.purpose || patch.purpose || '',
        specialtyId: base && base.id || null, skills: base ? base.skills.slice() : [], createdAt: d.now(), workshop: false,
        docs: { identity: 'You are ' + name + ', a specialist in the real StarNet station. Use only the live capabilities granted by its host, perform real work and verify outcomes.',
          purpose: spec.purpose || patch.purpose || '', manual: contractManual(patch.manual), context: String(hero.docs && hero.docs.context || '') } };
      worker.systemPrompt = composeAgentSystem(worker);
      const station = checkedStation(next).station;
      const desk = station.ensureWorkstation(id);
      if (!desk || !desk.ok) throw new Error('Native workstation placement failed: ' + String(desk && (desk.error || desk.code) || 'no space'));
      next.station = station.serialize(); next.agents.push(worker);
      const stream = newStream(next, name, id, 'chat');
      const room = station.roomById(desk.roomId);
      return { result: { agentId: id, name, desk: room && room.name || desk.roomId, workstation_id: desk.id,
        session_id: stream.id, specialty_id: worker.specialtyId, provider: worker.provider,
        model: worker.model, reasoning_effort: worker.reasoningEffort, approval_mode: 'ask', execution_profile: 'trusted-project' }, changes: { agentId: id, crew: true, floor: true, sessions: true } };
    });
  }
  function build(args, meta) {
    if (!keys(args, ['actions'], ['actions']) || !Array.isArray(args.actions) || !args.actions.length || args.actions.length > MAX_ACTIONS) return fail(400, 'Provide one additive native Build batch of at most 24 actions.');
    return mutate('station.build', args, meta, next => {
      const station = checkedStation(next).station, refs = new Map(), additions = [];
      const resolve = value => refs.get(value) || value;
      for (const action of args.actions) {
        if (!action || typeof action !== 'object') throw new Error('Invalid Build action.');
        let out;
        if (action.op === 'room') {
          if (!keys(action, ['op', 'ref', 'kind', 'name', 'rect'], ['op', 'kind', 'name', 'rect']) || !WorldModel.ROOM_KINDS[action.kind]
            || !validText(action.name, 80) || !keys(action.rect, ['x1', 'y1', 'x2', 'y2'], ['x1', 'y1', 'x2', 'y2'])
            || !Object.values(action.rect).every(n => Number.isSafeInteger(n) && Math.abs(n) <= 240)
            || action.rect.x2 < action.rect.x1 || action.rect.y2 < action.rect.y1) throw new Error('Room placement needs a native kind, name and bounded world-tile rectangle.');
          out = station.addRoom({ kind: action.kind, name: action.name, rect: action.rect });
        } else if (action.op === 'prop') {
          if (!keys(action, ['op', 'ref', 'type', 'x', 'y', 'agentId', 'brief', 'label'], ['op', 'type', 'x', 'y'])
            || !Number.isSafeInteger(action.x) || !Number.isSafeInteger(action.y) || Math.abs(action.x) > 240 || Math.abs(action.y) > 240) throw new Error('Invalid native prop placement.');
          const capability = WorldModel.capForProp(action.type);
          if (!(SAFE_CAPS.has(capability) || MACHINES.has(action.type))) throw new Error('This operation cannot add terminal, browser, connector, media, messaging or unknown gear.');
          const art = PropCatalog.views.find(v => v.id === action.type && v.r === 0);
          if (!art || art.requiredMount) throw new Error('This native prop has no supported floor placement.');
          if (action.agentId) crew(next, action.agentId);
          if (action.type === 'bay' && !action.agentId) throw new Error('A workflow Bay must bind an existing native worker.');
          if (action.brief !== undefined) { if (!validText(action.brief, 2000)) throw new Error('Invalid Bay brief.'); scan(action.brief); }
          if (action.label !== undefined && !validText(action.label, 80)) throw new Error('Invalid prop label.');
          out = station.addProp({ t: action.type, x: action.x, y: action.y, w: art.footprint.w, h: art.footprint.h,
            block: !art.flat, agentId: action.agentId });
          if (out.ok && action.brief) { const b = station.setPropBrief(out.id, action.brief); if (!b.ok) throw new Error('Native Bay brief was refused.'); }
          if (out.ok && action.label) { const b = station.setPropLabel(out.id, action.label); if (!b.ok) throw new Error('Native prop label was refused.'); }
        } else if (action.op === 'belt') {
          if (!keys(action, ['op', 'from', 'to'], ['op', 'from', 'to']) || typeof action.from !== 'string' || typeof action.to !== 'string') throw new Error('Invalid additive belt connection.');
          out = station.connectBelt(resolve(action.from), resolve(action.to));
        } else throw new Error('Only additive room, prop and belt actions are admitted.');
        if (!out || !out.ok) throw new Error('Native Build rejected ' + action.op + ': ' + String(out && (out.error || out.message || out.code) || 'placement failed'));
        if (action.ref !== undefined) {
          if (!ID.test(action.ref) || refs.has(action.ref) || !out.id) throw new Error('Build references must be unique valid IDs for new rooms or props.');
          refs.set(action.ref, out.id);
        }
        additions.push({ op: action.op, id: out.id || null, ref: action.ref || null });
      }
      const original = next.station; next.station = station.serialize();
      // Successful additive routing may not silently rewrite an existing limit,
      // worker binding, room or prop. The native placement only appends geometry.
      for (const [id, room] of Object.entries(original.rooms)) if (JSON.stringify(next.station.rooms[id]) !== JSON.stringify(room)) throw new Error('Build tried to alter an existing room.');
      for (const prop of original.props) if (JSON.stringify(next.station.props.find(p => p.id === prop.id)) !== JSON.stringify(prop)) throw new Error('Build tried to alter existing gear.');
      for (const [tile, belt] of Object.entries(original.belts || {})) if (JSON.stringify(next.station.belts[tile]) !== JSON.stringify(belt)) throw new Error('Build tried to alter an existing belt.');
      if (JSON.stringify(next.station.edges) !== JSON.stringify(original.edges)) throw new Error('Build tried to change existing workflow rules.');
      checkedStation(next);
      const proven = checkedStation(next);
      return { result: { additions, rooms: station.rooms().length, props: station.props().length,
        routing_hash: proven.routingPlan.hash, routing_valid: proven.routingOk,
        starts_work: false, permissions_changed: false }, changes: { floor: true } };
    });
  }
  function request(verb, args, meta) {
    args = args || {};
    try {
      if (verb === 'station.build') return build(args, meta);
      const doc = load();
      if (verb === 'station.layout') return { ok: true, result: layout(doc) };
      if (verb === 'station.agent_config') return { ok: true, result: args.agentId
        ? { id: crew(doc, args.agentId).id, name: crew(doc, args.agentId).name, docs: clone(crew(doc, args.agentId).docs || {}) }
        : { revision: revision(doc), agents: doc.agents.map(a => ({ id: a.id, name: a.name, specialtyId: a.specialtyId || null })) } };
      if (verb === 'station.sessions' || verb === 'station.tasks') {
        const rows = (doc.workstreams || []).filter(w => !w.archived && (verb !== 'station.tasks' || w.kind === 'task'));
        return { ok: true, result: { revision: revision(doc), count: rows.length, activeId: doc.activeId || null,
          [verb === 'station.tasks' ? 'tasks' : 'sessions']: rows.map(w => ({ id: w.id, title: w.title || (w.id === doc.generalId ? 'General' : 'Untitled'), agentId: w.agentId, kind: w.kind, lane: w.lane, active: w.id === doc.activeId })) } };
      }
      if (verb === 'station.read_session') {
        const row = resolveStream(doc, args.session);
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
        const persisted = typeof d.readSession === 'function' ? d.readSession(row.id, limit) : null;
        const source = Array.isArray(persisted) && persisted.length ? persisted : row.history || [];
        const messageText = m => typeof (m.content || m.text) === 'string' ? m.content || m.text
          : Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
        return { ok: true, result: { id: row.id, title: row.title || 'General', turns: source.filter(m => !m.hidden && !m.internal && ['user', 'assistant'].includes(m.role)).slice(-limit).map(m => ({ speaker: m.role, text: messageText(m).slice(0, 3000) })) } };
      }
      if (verb === 'station.new_session' || verb === 'station.new_task') {
        if (!keys(args, ['title', 'agentId', 'focus', 'origin'], ['title']) || !validText(args.title, 80) || args.focus) return fail(400, 'Headless creation requires a title and does not change the owner focus.');
        return mutate(verb, args, meta, next => {
          const kind = verb === 'station.new_task' ? 'task' : 'chat';
          const existing = (next.workstreams || []).find(w => !w.archived && w.kind === kind && String(w.title || '').toLowerCase() === args.title.trim().toLowerCase());
          if (existing) return { result: { id: existing.id, title: existing.title, agentId: existing.agentId, created: false, focused: false }, changes: { sessions: false } };
          const agentId = args.agentId || 'agent'; crew(next, agentId);
          const row = newStream(next, args.title.trim(), agentId, kind);
          return { result: { id: row.id, title: row.title, agentId, created: true, focused: false }, changes: { sessions: true } };
        });
      }
      if (verb === 'station.update_agent') {
        if (!keys(args, ['agentId', 'field', 'previousText', 'text'], ['agentId', 'field', 'previousText', 'text']) || !['identity', 'purpose', 'manual', 'context'].includes(args.field)
          || !validText(args.text, 20000, true) || typeof args.previousText !== 'string') return fail(400, 'Only native Dossier text may be edited; settings and grants are preserved.');
        return mutate(verb, args, meta, next => {
          const a = crew(next, args.agentId), old = String(a.docs && a.docs[args.field] || '');
          if (old !== args.previousText && old !== args.text) throw new Error('The agent document changed; read its configuration again.');
          scan(args.text);
          a.docs = Object.assign({}, a.docs, { [args.field]: args.text });
          if (args.field === 'purpose') a.purpose = args.text.trim();
          // Preserve the owner's unrelated prompt content. Native documents have
          // explicit blocks; replace an existing block's exact old text. Empty
          // documents append their new block rather than erasing the persona.
          const currentSystem = String(a.systemPrompt || '');
          a.systemPrompt = currentSystem && old && currentSystem.includes(old)
            ? currentSystem.replace(old, args.text)
            : currentSystem ? currentSystem + '\n\n' + args.field.toUpperCase() + ' (' + args.field + '.md):\n' + args.text : composeAgentSystem(a);
          if (next.agent && next.agent.id === a.id) next.agent.docs = clone(a.docs);
          return { result: { agentId: a.id, field: args.field, text: args.text, applies: 'next run' }, changes: { crew: true, agentId: a.id } };
        });
      }
      if (verb === 'station.manage_task') {
        if (!keys(args, ['task', 'action', 'lane', 'title', 'agentId'], ['task', 'action']) || !['move', 'rename', 'assign', 'archive', 'restore', 'remove'].includes(args.action)) return fail(400, 'Invalid native board action.');
        if (args.action === 'move' && !validBoardMove(args)) return fail(400, 'A board move requires an exact task and a valid lane only.');
        if (args.action === 'move' && args.lane === 'shipped' && !(meta && meta.ownerConfirmed) && !admittedBoardMove(args, meta)) return fail(403, 'Shipping a board card requires an explicit owner decision or admitted native operation.');
        if (['remove', 'archive'].includes(args.action) && !(meta && meta.ownerConfirmed)) return fail(403, 'Removing or archiving a board card requires an explicit owner decision.');
        return mutate(verb, args, meta, next => {
          const target = resolveStream(next, args.task, 'task', args.action === 'restore');
          initializeStreams(next); let ok;
          if (args.action === 'move') ok = Workstreams.setLane(target.id, args.lane);
          if (args.action === 'rename') { if (!validText(args.title, 80)) throw new Error('A task title is required.'); ok = Workstreams.rename(target.id, args.title); }
          if (args.action === 'assign') { crew(next, args.agentId); ok = Workstreams.setAgent(target.id, args.agentId); }
          if (args.action === 'archive' || args.action === 'restore') ok = Workstreams.archive(target.id, args.action !== 'restore');
          if (args.action === 'remove') ok = Workstreams.del(target.id);
          if (!ok) throw new Error('Native workstream engine refused the board change.');
          const slice = Workstreams.serialize(), updated = Workstreams.get(target.id);
          next.workstreams = next.workstreams.filter(w => w.id !== target.id).concat(updated ? [Object.assign({}, target, clone(updated))] : []);
          if (!updated || updated.archived && next.activeId === target.id) next.activeId = slice.activeId;
          if (!updated) next.deletedIds = clone(slice.deletedIds);
          return { result: { id: target.id, removed: !updated, task: updated ? clone(updated) : null }, changes: { sessions: true } };
        });
      }
      return fail(400, 'This native command is not available headlessly; visual focus and arbitrary mutations are not admitted.');
    } catch (e) { return fail(400, String(e && e.message || e)); }
  }
  function snapshot() {
    try { const doc = load(); return { ok: true, revision: revision(doc), crew_count: doc.agents.length,
      classes: Specialties.builtins().map(s => ({ id: s.id, name: s.name, kit: s.kit.slice(), skills: s.skills.slice() })),
      build_catalog: buildCatalog(),
      mutation_ledger: { recent_receipts: (doc.floNative && doc.floNative.receipts || []).length,
        retired_receipts: (doc.floNative && doc.floNative.retired_receipts || []).length,
        max_retired_receipts: MAX_RETIRED_RECEIPTS,
        review_required: (doc.floNative && doc.floNative.retired_receipts || []).length >= MAX_RETIRED_RECEIPTS },
      capabilities: { recruitment: true, workstations: true, canonical_sessions: true, dossier_configuration: true, additive_build: true,
        arbitrary_host_paths: false, permission_changes: false, model_changes: false, starts_work: false,
        max_crew: MAX_CREW, max_build_actions: MAX_ACTIONS } }; }
    catch (e) { return fail(503, String(e && e.message || e)); }
  }
  function enroll(meta) {
    return mutate('station.enroll', {}, meta, next => {
      Object.assign(next, upgradeContracts(next));
      return { result: { contract: 'flo-native', crew_count: next.agents.length,
        native_coordination: true, permissions_changed: false, starts_work: false }, changes: { crew: true } };
    });
  }
  function configureManagedSettings(args, meta) {
    // This owner-only API is deliberately absent from request()/model tools.
    // The caller resolves the current operation objective on the host and
    // admits this exact reviewed correction while all native work is idle.
    if (!meta || meta.ownerConfirmed !== true) return fail(403, 'Managed settings require an explicit owner decision.');
    if (!keys(args, ['goal', 'operation_id'], ['goal', 'operation_id']) || !validText(args.goal, 6000)
      || !Number.isSafeInteger(args.operation_id) || args.operation_id < 1) return fail(400, 'The host current operation and objective are required.');
    return mutate('station.managed_settings', args, meta, next => {
      scan(args.goal);
      for (const a of next.agents) a.reasoningEffort = 'high';
      if (next.agent) next.agent.reasoningEffort = 'high';
      next.reasoningEffort = 'high';
      const dossier = Dossier.hydrate(next.dossier);
      const prior = Dossier.beliefs(dossier, 'goals').find(b => b.source === 'flo-native-operation');
      Dossier.upsert(dossier, 'goals', { id: prior && prior.id, text: args.goal.trim(), source: 'flo-native-operation', weight: 'stated',
        evidenceRef: { kind: 'flo-native-operation', operation_id: args.operation_id } }, d.now());
      next.dossier = dossier;
      next.floNative = Object.assign({}, next.floNative, { managed_settings: { version: 1,
        operation_id: args.operation_id, goal: args.goal.trim(), reasoning_effort: 'high', reviewed_at: d.now() } });
      return { result: { operation_id: args.operation_id, crew_count: next.agents.length, saved_reasoning: 'high',
        goal: args.goal.trim(), permissions_changed: false, providers_changed: false, starts_work: false },
        changes: { crew: true, managed_settings: true } };
    });
  }
  function repairMirrors(meta) {
    meta = meta || {};
    if (!REQUEST.test(String(meta.requestId || ''))) return fail(400, 'The original host-owned enrollment request ID is required.');
    try {
      const current = load(), ledger = current.floNative || {};
      const fingerprint = hash({ verb: 'station.enroll', args: {} });
      const recent = Array.isArray(ledger.receipts) && ledger.receipts.find(r => r && r.request_id === meta.requestId && r.fingerprint === fingerprint && r.verb === 'station.enroll');
      const retired = Array.isArray(ledger.retired_receipts) && ledger.retired_receipts.find(r => r && r.request_hash === hash(meta.requestId) && r.fingerprint === fingerprint);
      if (!recent && !retired) return fail(409, 'The original native enrollment could not be proven. No station repair was admitted.');
      checkedStation(current);
      const basis = replayBasis(current, meta.requestId);
      mirror(current, basis.previous, { replay: true, read_only: true, enrollment_verified: true,
        recovery_basis: basis.recovery_basis, verb: 'station.enroll', agentId: null });
      return { ok: true, result: { repaired: true, canonical_changed: false, revision: revision(current),
        enrollment_receipt: recent ? 'recent' : 'retired', recovery_basis: basis.recovery_basis } };
    } catch (e) { return fail(503, String(e && e.message || e), { canonical_changed: false, mirror_repair_incomplete: true }); }
  }
  return { snapshot, request, summon, enroll, repairMirrors, configureManagedSettings };
}

module.exports = { makeFloNativeStation, upgradeContracts, upgradeGeneratedContract: contractManual, composeAgentSystem, managedCommanderGoal, applyManagedSettingsRequest,
  NATIVE_CONTRACT, NATIVE_BOUNDARY, MAX_CREW, MAX_ACTIONS };
