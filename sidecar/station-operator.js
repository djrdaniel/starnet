'use strict';

// Read-only, bounded owner-facing projection. The source readers remain the
// authorities; this module never starts work or manufactures capability grants.
const { starnetManual, MANUAL_SECTIONS } = require('./manual.js');
const { makeStationStore } = require('./station-store.js');
const floCapabilities = require('./flo-capability-profile.js');

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const list = value => Array.isArray(value) ? value : [];
const text = (value, max) => String(value == null ? '' : value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max || 280);
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function consentArgumentDetails(args, redact) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { args: null, argsComplete: false, argsPreview: '' };
    let nodes = 0;
    function privacy(value, depth) {
      if (++nodes > 1500 || depth > 20) throw new Error('Unsupported consent arguments');
      if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (Array.isArray(value)) return value.map(v => privacy(v, depth + 1));
      if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Unsupported consent arguments');
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
        /token|secret|password|authorization|cookie|credential|private|customer_data|card_number|cvc/i.test(k)
          ? '[redacted-private]' : privacy(v, depth + 1)]));
    }
    const original = JSON.stringify(args), safe = JSON.stringify(privacy(redact(args), 0));
    // Redacted or oversized requests require the native station's fuller review.
    // No concealed command/body can acquire authority from a short summary.
    if (!safe || safe.length > 6000) return { args: null, argsComplete: false, argsPreview: (safe || '').slice(0, 6000) };
    return { args: JSON.parse(safe), argsComplete: original === safe, argsPreview: '' };
  } catch (_) { return { args: null, argsComplete: false, argsPreview: '' }; }
}

function section(reader, shape, redact) {
  if (typeof reader !== 'function') return { status: 'unavailable', reason: 'source is not wired' };
  try { return { status: 'confirmed', data: redact(shape(reader())) }; }
  catch (_) { return { status: 'unavailable', reason: 'source could not be read' }; }
}

function goalShape(goal) {
  if (!goal || !goal.text) return null;
  return { id: text(goal.id, 64), text: text(goal.text, 280), done: number(goal.done), total: number(goal.total),
    pct: number(goal.pct), next: text(goal.next, 200) || null, milestoneId: text(goal.milestoneId, 80) || null };
}

function layoutShape(saved, routed) {
  if (!saved || !saved.station) throw new Error('station has not been saved');
  const checked = makeStationStore().validateStationDoc(saved.station);
  if (!checked.ok) throw new Error('saved station is invalid');
  const station = checked.station, plan = checked.routingPlan;
  const rooms = station.rooms(), props = station.props(), lines = list(plan.lines);
  const sameHash = !!(routed && routed.hash && routed.hash === plan.hash);
  return {
    save_revision: number(saved._saveRevision),
    room_count: rooms.length, prop_count: props.length, line_count: lines.length,
    rooms: rooms.slice(0, 80).map(r => ({ id: text(r.id, 80), name: text(r.name || r.kind, 100), kind: text(r.kind, 40) })),
    props: props.slice(0, 160).map(p => ({ id: text(p.id, 80), type: text(p.t, 80),
      capability: station.capForProp(p.t) || null, agentId: text(p.agentId, 40) || null })),
    belts_count: Object.keys(saved.station.belts || {}).length,
    edges_count: Object.keys(saved.station.edges || {}).length,
    routing: { state: !routed ? 'off' : sameHash ? 'live' : 'mismatch', confirmed: sameHash,
      saved_hash: text(plan.hash, 100), running_hash: routed ? text(routed.hash, 100) : null,
      deployable: checked.routingOk, errors: list(plan.errors).slice(0, 15).map(e => text(typeof e === 'string' ? e : e.reason || e.code || 'routing issue', 200)) },
    lines: lines.slice(0, 60).map(l => ({ id: text(l.id || l.lineId, 80),
      name: text(l.name || l.id || l.lineId, 100), agents: list(l.agents).slice(0, 40).map(a => text(a, 40)),
      step_count: list(plan.dockBays).filter(b => plan.lineOfDock && plan.lineOfDock[b.propId || b.dockId || b.id] === (l.id || l.lineId)).length })),
    truncated: rooms.length > 80 || props.length > 160 || lines.length > 60
  };
}

// Native consent decisions remain owned by consentwait. The bridge calls the
// very same finisher as /api/consent, without creating a standing grant.
function makeNativeConsentBridge(deps) {
  const now = deps.now, pending = deps.pending;
  const redact = typeof deps.redact === 'function' ? deps.redact : value => value;
  function find(runId, promptId) {
    if (!ID.test(String(runId || '')) || !ID.test(String(promptId || ''))) return null;
    const finish = pending.get(runId) && pending.get(runId).get(promptId);
    const row = finish && typeof finish.snapshot === 'function' ? finish.snapshot() : null;
    if (!row) return null;
    if (!Number.isFinite(row.expiresAt) || row.expiresAt <= now()) return null;
    return { finish, row };
  }
  function project(runId, row) {
    const kind = row.tool === 'brief.ask' ? 'question' : 'permission';
    return redact({ run_id: runId, prompt_id: row.promptId, agent_id: text(row.agentId, 40),
      tool: text(row.tool, 100), scope: text(row.scope, 40), args_summary: text(row.argsSummary, 4000), kind,
      created_at: row.createdAt, expires_at: row.expiresAt, displayed: row.displayed === true,
      args: row.args || null, args_preview: text(row.argsPreview, 6000), args_complete: row.argsComplete === true,
      allowed_decisions: kind === 'permission' && row.argsComplete === true ? ['once', 'deny'] : ['deny'] });
  }
  function snapshot() {
    const items = []; let count = 0;
    for (const [runId, prompts] of pending) for (const promptId of prompts.keys()) {
      const found = find(runId, promptId);
      if (found) { count++; if (items.length < 80) items.push(project(runId, found.row)); }
    }
    return { count, items, truncated: count > items.length };
  }
  function decide(runId, promptId, decision) {
    if (!['once', 'deny'].includes(decision)) return { ok: false, code: 400, error: 'Only approve once or deny is allowed.' };
    const found = find(runId, promptId);
    if (!found) return { ok: false, code: 409, stale: true, error: 'This request expired or is no longer pending.' };
    if (decision === 'once' && found.row.tool === 'brief.ask') return { ok: false, code: 400, error: 'This is a question; answer it in the station.' };
    if (decision === 'once' && found.row.argsComplete !== true) return { ok: false, code: 409, incomplete: true, error: 'This request needs full review in the native station. Flo can only deny it.' };
    found.finish(decision);
    return { ok: true, run_id: runId, prompt_id: promptId, decision };
  }
  function ack(runId, promptId, displayed) {
    if (displayed !== true) return { ok: false, code: 400, error: 'A displayed request must be confirmed.' };
    const found = find(runId, promptId);
    if (!found) return { ok: false, code: 409, stale: true, error: 'This request expired or is no longer pending.' };
    const extended = typeof found.finish.extend === 'function' && found.finish.extend();
    const row = found.finish.snapshot();
    return { ok: true, run_id: runId, prompt_id: promptId, extended: !!extended, expires_at: row.expiresAt };
  }
  return { snapshot, decide, ack };
}

function makeStationOperator(deps) {
  const d = deps || {}, redact = typeof d.redact === 'function' ? d.redact : value => value;
  const read = (fn, shape) => section(fn, shape, redact);
  return { snapshot() {
    return {
      object: 'starnet.station.operator', schema_version: 1, observed_at: d.now(),
      goal: read(d.goal, goalShape),
      journey: read(d.journey, raw => ({
        goals: list(raw.goals).slice(0, 30).map(g => ({ id: text(g.id, 64), text: text(g.text, 280), status: text(g.status, 30),
          success_condition: text(g.successCondition, 1000), verified_by: text(g.verifiedBy, 40) || null })),
        progression: { level: number((raw.progression || {}).level), points: number((raw.progression || {}).points) },
        metric_count: list(raw.metrics).length, outcome_count: list(raw.outcomes).length,
        truncated: list(raw.goals).length > 30
      })),
      autonomy: read(d.autonomy, raw => ({ initiative: text(raw.initiative, 30), reach: text(raw.reach, 30),
        leashPerDay: number(raw.leashPerDay), enabled: raw.enabled === true,
        actsUnattended: raw.actsUnattended === true, buildsUnattended: raw.buildsUnattended === true,
        reachesOut: raw.reachesOut === true })),
      grounding: read(d.grounding, raw => ({ known: list(raw && raw.known).slice(0, 24).map(k => text(k, 50)),
        ready: !!(raw && raw.ready && raw.ready.ok), reasons: list(raw && raw.ready && raw.ready.reasons).slice(0, 8).map(r => text(r, 100)),
        observed_at: number(raw && raw.at) || null })),
      crew: read(d.crew, rows => ({ count: list(rows).length,
        workers: list(rows).slice(0, 60).map(a => ({ agent_id: text(a.agentId || a.id, 40), name: text(a.name, 100),
          role: text(a.role, 280), provider: text(a.provider, 40), model: text(a.model, 160),
          reasoning_effort: text(a.reasoningEffort, 30), approval_mode: text(a.approvalMode, 30),
          execution_profile: text(a.executionProfile, 40), manual_summary: {
            flo_contract: /FLO COMPANY CONTRACT/.test(a.manual || ''),
            delegation_disabled: /Internal worker(?:-to-worker)? delegation is disabled/i.test(a.manual || ''),
            supplied_text_only: /supplied-text reasoning only/i.test(a.manual || '')
          } })), truncated: list(rows).length > 60 })),
      layout: read(() => layoutShape(d.saved(), d.routing()), raw => raw),
      pending_consents: read(d.consents, raw => raw),
      operation: read(d.operation, raw => ({ mode: ['native', 'flo-managed'].includes(raw && raw.mode) ? raw.mode : 'unavailable',
        native_unscoped_autonomous_allowed: !!(raw && raw.native_unscoped_autonomous_allowed), policy_status: text(raw && raw.policy_status, 40) })),
      operator_reference: {
        source: 'sidecar/manual.js', text: starnetManual(),
        sections: MANUAL_SECTIONS.map(s => ({ id: s.id, title: s.title, kind: s.kind })),
        integration: { worker_execution: 'Flo starts individually named workers using host-owned bounded profiles.',
          capability_profiles: floCapabilities.catalog(),
          native_consent_decisions: ['once', 'deny'],
          native_layout_editing: 'The native station.layout tool reads the floor. The station Build UI edits it; /v1/station/setup reviews and applies one fixed, additive Flo commerce room with revision and proposal checks.',
          starts_work_on_read: false, grants_authority_on_read: false }
      }
    };
  } };
}

module.exports = { makeStationOperator, makeNativeConsentBridge, consentArgumentDetails, goalShape, layoutShape };
