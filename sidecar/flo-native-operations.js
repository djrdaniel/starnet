'use strict';

// A durable owner-admitted operation over StarNet's real run host. This is not
// another simulated workforce: the caller supplies native recruitment, tools,
// transcripts, roster and runOnce. Timer admission never comes from model text.
const crypto = require('node:crypto');
const { makeDomainStore } = require('./domain-store.js');
const REQUEST = /^[A-Za-z0-9_.:-]{1,180}$/;
const STATUSES = new Set(['running', 'paused', 'attention', 'stopped', 'completed', 'awaiting_approval']);
const clone = x => JSON.parse(JSON.stringify(x));
const LIMITS = Object.freeze({ max_crew: 32, calls_per_pass: 160, duration_ms: 900000,
  next_pass_ms: 900000, max_passes_per_day: 48, max_artifact_bytes: 8 * 1024 * 1024 });

function makeFloNativeOperations(d) {
  const store = makeDomainStore({ fs: d.fs, path: d.path,
    file: d.path.join(d.workspaces, '_flo.native-operations.json'), writeDurable: d.writeDurable,
    version: 1, defaults: () => ({ next_id: 1, operations: [], action_receipts: [], retired_receipts: [] }),
    normalize: v => {
      if (!v || !Number.isSafeInteger(v.next_id) || v.next_id < 1 || !Array.isArray(v.operations)
        || !Array.isArray(v.action_receipts) || v.operations.length > 100) throw new Error('Invalid native operation ledger');
      const ids = new Set(), requests = new Set();
      for (const op of v.operations) {
        if (!op || !Number.isSafeInteger(op.id) || op.id < 1 || ids.has(op.id) || requests.has(op.request_id)
          || !REQUEST.test(op.request_id) || !STATUSES.has(op.status) || typeof op.objective !== 'string' || !op.objective.trim() || op.objective.length > 6000
          || !['once', 'ongoing'].includes(op.mode) || !Array.isArray(op.events) || op.events.length > 200 || !Array.isArray(op.artifacts) || op.artifacts.length > 200
          || ![op.created_at, op.updated_at].every(n => Number.isSafeInteger(n) && n >= 0)
          || !(op.next_at === null || Number.isSafeInteger(op.next_at) && op.next_at >= 0)
          || !(op.run_id === null || typeof op.run_id === 'string' && REQUEST.test(op.run_id))
          || ![op.pass_count, op.day_passes, op.event_sequence].every(n => Number.isSafeInteger(n) && n >= 0)
          || typeof op.day !== 'string' || op.day && !/^\d{4}-\d{2}-\d{2}$/.test(op.day)) throw new Error('Invalid native operation record');
        for (const a of op.artifacts) if (!a || !/^[a-f0-9]{32}$/.test(a.id) || a.operation_id !== op.id
          || !/^[A-Za-z0-9_-]{1,40}$/.test(a.agent_id) || typeof a.path !== 'string' || !a.path || a.path.length > 260
          || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > LIMITS.max_artifact_bytes) throw new Error('Invalid native artifact receipt');
        for (const e of op.events) if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.message !== 'string'
          || !Number.isSafeInteger(e.ts) || e.ts < 0) throw new Error('Invalid native event receipt');
        if (op.current_pass_failures !== undefined && (!Array.isArray(op.current_pass_failures)
          || op.current_pass_failures.length > LIMITS.calls_per_pass
          || op.current_pass_failures.some(f => !f || typeof f.agent_id !== 'string' || typeof f.run_id !== 'string'
            || typeof f.reason !== 'string' || f.reason.length > 80
            || !Number.isSafeInteger(f.uncertain_mutations) || f.uncertain_mutations < 0
            || f.failed_artifacts !== undefined && (!Array.isArray(f.failed_artifacts) || f.failed_artifacts.length > 50
              || f.failed_artifacts.some(p => typeof p !== 'string' || !p || p.length > 260)
              || new Set(f.failed_artifacts).size !== f.failed_artifacts.length)))) throw new Error('Invalid native subordinate outcome receipt');
        ids.add(op.id); requests.add(op.request_id);
      }
      if (v.next_id <= Math.max(0, ...ids) || v.action_receipts.length > 100) throw new Error('Invalid native ledger sequence');
      for (const r of v.action_receipts) if (!r || !REQUEST.test(r.request_id) || requests.has(r.request_id)
        || !ids.has(r.operation_id) || !['pause', 'resume', 'stop'].includes(r.action) || r.status !== 'confirmed'
        || !Number.isSafeInteger(r.ts) || r.ts < 0) throw new Error('Invalid native action receipt');
      if (new Set(v.action_receipts.map(r => r.request_id)).size !== v.action_receipts.length) throw new Error('Duplicate native action receipt');
      const retired = v.retired_receipts || [];
      if (!Array.isArray(retired) || retired.length > 4096 || retired.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new Error('Invalid retired native receipts');
      return Object.assign(clone(v), { retired_receipts: retired.slice() });
    } });
  let state = store.load(), live = null, timer = null;
  const ready = () => ['ok', 'recovered', 'absent'].includes(state.status);
  const now = () => d.now();
  const redact = x => typeof d.redact === 'function' ? d.redact(x) : x;
  function save(next) {
    if (!ready()) throw new Error('The native operation ledger needs recovery; no new work was admitted.');
    try { const proven = store.save(next); state = { value: proven.value, status: 'ok' }; }
    catch (e) { state = Object.assign(store.load(), { status: 'unproven' }); if (live) live.abort.abort(); throw e; }
  }
  const current = () => state.value.operations.at(-1) || null;
  function update(id, fn) {
    const next = clone(state.value), op = next.operations.find(r => r.id === id);
    if (!op) throw new Error('Native operation not found');
    fn(op, next); op.updated_at = now(); save(next); return op;
  }
  function event(op, type, text, extra) {
    op.events.push(Object.assign({ id: String(op.id) + ':' + (++op.event_sequence), type,
      message: String(redact(text || '')).slice(0, 1500), ts: now() }, extra || {}));
    op.events = op.events.slice(-200);
  }
  function schedule() {
    if (timer) { d.clearTimeout(timer); timer = null; }
    const op = current();
    if (!ready() || live || !op || op.status !== 'running') return;
    timer = d.setTimeout(() => { timer = null; void pass(op.id).catch(() => {}); }, Math.max(0, (op.next_at || now()) - now()));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function snapshot() {
    const op = current(), copy = op ? clone(op) : null;
    if (copy && !ready()) { copy.status = 'attention'; copy.next_at = null;
      copy.message = 'The native ledger could not be verified. Restart and inspect its recovery before admitting work.'; }
    let workers = [];
    try { workers = d.workers().map(w => Object.assign({}, w, {
      status: live && live.workers.has(w.agent_id || w.agentId) ? 'working' : 'idle' })); } catch (_) {}
    return { object: 'starnet.station.operations', schema_version: 1, ledger_status: state.status,
      operation: copy, events: copy ? copy.events : [], artifacts: copy ? copy.artifacts : [], workers,
      action_receipts: clone(state.value.action_receipts).slice(-100),
      capabilities: { native: true, recruitment: true, delegation: true, station_build: true,
        tasks: true, sessions: true, artifacts: true, ongoing: true, restart_recovery: true,
        reasoning: 'high', provider: 'ChatGPT OAuth', limits: LIMITS,
        requires_owner_approval: ['publishing', 'purchases', 'spending', 'supplier_orders', 'external_messages', 'production_changes'],
        unavailable: ['unreviewed_shell_execution', 'unreviewed_paid_media', 'arbitrary_private_connectors', 'revenue_guarantees'] } };
  }
  function start(body) {
    if (!ready()) return { ok: false, code: 503, error: 'Native operation state could not be verified.' };
    if (!body || body.confirm !== true || !REQUEST.test(body.request_id || '')
      || typeof body.objective !== 'string' || !body.objective.trim() || body.objective.length > 6000
      || (body.mode !== undefined && !['once', 'ongoing'].includes(body.mode))
      || Object.keys(body).some(k => !['request_id', 'confirm', 'objective', 'mode'].includes(k))) return { ok: false, code: 400, error: 'Confirm one bounded objective and a unique request_id.' };
    const previous = state.value.operations.find(r => r.request_id === body.request_id);
    if (previous) {
      if (previous.objective !== body.objective.trim() || previous.mode !== (body.mode || 'ongoing')) return { ok: false, code: 409, error: 'This request_id belongs to a different instruction.' };
      return { ok: true, operation: clone(previous), replayed: true };
    }
    const active = current();
    if (state.value.operations.length >= 100) return { ok: false, code: 409, error: 'Native operation history needs reviewed archival before another admission.' };
    if (live || active && ['running', 'paused', 'attention', 'awaiting_approval'].includes(active.status)) return { ok: false, code: 409, error: 'Resume or stop the existing operation before starting another.' };
    // Enrollment is read-back verified before a goal can claim it is admitted.
    try { d.enroll(body.request_id); } catch (e) { return { ok: false, code: 503, error: String(e.message || e).slice(0, 600) }; }
    const next = clone(state.value), id = next.next_id++;
    const op = { id, request_id: body.request_id, objective: body.objective.trim(), mode: body.mode || 'ongoing',
      status: 'running', message: 'Native station operation admitted.', created_at: now(), updated_at: now(),
      next_at: now(), run_id: null, pass_count: 0, day: '', day_passes: 0, event_sequence: 0,
      events: [], artifacts: [], last_result: '', reasoning: 'high', capability_profile: 'flo-operator' };
    event(op, 'admitted', op.message); next.operations.push(op); save(next); schedule();
    return { ok: true, operation: clone(op) };
  }
  function action(id, body) {
    id = Number(id);
    if (!ready()) return { ok: false, code: 503, error: 'Native operation state could not be verified.' };
    if (!body || body.confirm !== true || !REQUEST.test(body.request_id || '')
      || !['pause', 'resume', 'stop'].includes(body.action)
      || Object.keys(body).some(k => !['request_id', 'confirm', 'action'].includes(k))) return { ok: false, code: 400, error: 'Confirm a native operation action with its request_id.' };
    const old = state.value.action_receipts.find(r => r.request_id === body.request_id);
    if (old) {
      if (old.operation_id !== id || old.action !== body.action) return { ok: false, code: 409, error: 'This request_id belongs to another action.' };
      return { ok: true, operation: clone(state.value.operations.find(r => r.id === id)), action_receipt: clone(old), replayed: true };
    }
    const retiredHash = crypto.createHash('sha256').update(body.request_id).digest('hex');
    if (state.value.retired_receipts.includes(retiredHash)) return { ok: false, code: 409, error: 'This action receipt was archived. It will not execute again; inspect current native state.' };
    if (state.value.retired_receipts.length >= 4096 && state.value.action_receipts.length >= 100) return { ok: false, code: 409, error: 'Native action history needs reviewed archival before another mutation.' };
    const op = current();
    if (!op || op.id !== id) return { ok: false, code: 404, error: 'This is not the current native operation.' };
    if (body.action === 'resume' && (live || ['completed', 'stopped'].includes(op.status))) return { ok: false, code: 409, error: live ? 'The preceding pass is still stopping.' : 'This operation has ended.' };
    const updated = update(id, (o, next) => {
      o.status = body.action === 'resume' ? 'running' : body.action === 'pause' ? 'paused' : 'stopped';
      o.next_at = body.action === 'resume' ? now() : null;
      o.message = body.action === 'resume' ? 'Native operation resumed from verified current state.' : body.action === 'pause' ? 'Operation paused; active workers are being cancelled.' : 'Operation stopped; active workers are being cancelled.';
      event(o, body.action, o.message);
      next.action_receipts.push({ request_id: body.request_id, operation_id: id, action: body.action, status: 'confirmed', ts: now() });
      if (next.action_receipts.length > 100) next.retired_receipts.push(crypto.createHash('sha256').update(next.action_receipts[0].request_id).digest('hex'));
      next.action_receipts = next.action_receipts.slice(-100);
    });
    if (body.action !== 'resume' && live && live.id === id) live.abort.abort();
    schedule(); return { ok: true, operation: clone(updated), action_receipt: clone(state.value.action_receipts.at(-1)) };
  }
  function observe(id, name, payload) {
    if (!ready()) { if (live) live.abort.abort(); return; }
    const p = payload || {};
    if (live && live.id === id && p.agentId) {
      if (name === 'agent.run.start') live.workers.add(p.agentId);
      if (name === 'agent.run.end' || name === 'agent.run.error') live.workers.delete(p.agentId);
    }
    if (!['agent.run.start', 'agent.run.end', 'agent.run.error', 'agent.tool_call', 'agent.tool_result'].includes(name)) return;
    update(id, op => {
      const message = name === 'agent.run.start' ? 'Worker started.' : name === 'agent.run.end' ? 'Worker ended: ' + (p.reason || 'unknown')
        : name === 'agent.run.error' ? String(p.message || 'Worker error') : String(p.name || p.tool || p.summary || 'Native tool');
      event(op, name, message, { agent_id: p.agentId || null, run_id: p.runId || null, tool: p.name || null });
    });
  }
  async function recordResult(id, agentId, runId, result) {
    const files = [];
    const subordinate = live && live.id === id && live.runId !== runId;
    const uncertainty = Array.isArray(result && result.uncertainMutations) ? result.uncertainMutations.length : 0;
    const failedOutcome = (op, reason, artifactPath) => {
      const prior = (op.current_pass_failures || []).find(f => f.run_id === String(runId));
      const outcome = Object.assign({}, prior || {}, { agent_id: String(agentId), run_id: String(runId),
        reason: String(artifactPath && prior ? prior.reason : reason).slice(0, 80),
        uncertain_mutations: Math.max(uncertainty, prior && prior.uncertain_mutations || 0) });
      if (artifactPath) outcome.failed_artifacts = [...new Set([...(prior && prior.failed_artifacts || []), artifactPath])].slice(-50);
      op.current_pass_failures = (op.current_pass_failures || []).filter(f => f.run_id !== outcome.run_id).concat([outcome]).slice(-LIMITS.calls_per_pass);
      return outcome;
    };
    if (subordinate && (!result || result.reason !== 'done' || uncertainty)) {
      update(id, op => {
        const outcome = failedOutcome(op, result && result.reason || 'no_result');
        event(op, 'worker_attention', 'A delegated worker did not finish cleanly; inspect its saved work before resuming.',
          { agent_id: outcome.agent_id, run_id: outcome.run_id, reason: outcome.reason, uncertain_mutations: uncertainty });
      });
    }
    for (const a of (result && result.artifacts || []).slice(0, 50)) {
      if (!a || !['file', 'image'].includes(a.kind)) continue;
      try {
        const file = await d.verifyArtifact(agentId, a.path);
        files.push({ id: crypto.createHash('sha256').update(id + '\0' + agentId + '\0' + a.path + '\0' + file.sha256).digest('hex').slice(0, 32),
          operation_id: id, agent_id: agentId, run_id: runId, path: a.path, title: d.path.basename(a.path),
          sha256: file.sha256, size: file.size, created_at: now(), status: 'verified' });
      } catch (e) {
        update(id, op => {
          const reported = String(a.path || '(missing artifact path)').slice(0, 260);
          failedOutcome(op, 'artifact_unavailable', reported);
          event(op, 'artifact_unavailable', 'A reported file failed native read-back: ' + reported.slice(0, 200), { agent_id: agentId, run_id: runId });
        });
      }
    }
    update(id, op => {
      for (const f of files) { op.artifacts = op.artifacts.filter(a => a.agent_id !== f.agent_id || a.path !== f.path); op.artifacts.push(f); event(op, 'artifact_verified', f.title, { artifact_id: f.id, agent_id: agentId, run_id: runId }); }
      op.artifacts = op.artifacts.slice(-200);
    });
  }
  async function artifact(id, artifactId) {
    if (!ready()) throw new Error('Native operation ledger unavailable');
    const op = state.value.operations.find(o => o.id === Number(id));
    const row = op && op.artifacts.find(a => a.id === artifactId);
    if (!row) throw new Error('Artifact not found');
    const bytes = await d.verifyArtifact(row.agent_id, row.path, true);
    if (bytes.sha256 !== row.sha256 || bytes.size !== row.size) throw new Error('The file changed after its verified delivery; it needs a fresh receipt.');
    return Object.assign({}, row, { bytes: bytes.bytes });
  }
  async function pass(id) {
    const op = current();
    if (!ready() || live || !op || op.id !== id || op.status !== 'running') return;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (op.day === day && op.day_passes >= LIMITS.max_passes_per_day) {
      update(id, o => { o.message = 'Daily ChatGPT operation allowance reached; resumes tomorrow.'; o.next_at = Date.parse(day + 'T00:00:00Z') + 86400000; }); schedule(); return;
    }
    const runId = 'flo-native-' + d.newId();
    live = { id, runId, abort: new AbortController(), workers: new Set(), calls: 0, deadline: now() + LIMITS.duration_ms };
    const active = live;
    const timebox = d.setTimeout(() => active.abort.abort(), LIMITS.duration_ms);
    try {
      update(id, o => { o.run_id = runId; o.next_at = null; o.pass_count++; o.day_passes = o.day === day ? o.day_passes + 1 : 1; o.day = day;
        o.current_pass_failures = []; o.current_tool_calls = 0;
        o.message = 'Chief of Staff is directing the real station.'; event(o, 'pass_started', o.message, { run_id: runId }); });
      const result = await d.run({ operation: clone(current()), runId, signal: active.abort.signal,
        budget: { take() {
          if (active.abort.signal.aborted || now() > active.deadline || active.calls >= LIMITS.calls_per_pass) return false;
          try { update(id, o => { o.current_tool_calls = active.calls + 1; }); active.calls++; return true; }
          catch (_) { active.abort.abort(); return false; }
        } },
        emit: (name, payload) => observe(id, name, payload),
        recordResult: (agentId, childRunId, value) => recordResult(id, agentId, childRunId, value) });
      await recordResult(id, 'agent', runId, result);
      update(id, o => {
        o.run_id = null; o.last_result = String(redact(result && (result.text || result.content) || '')).slice(0, 12000);
        o.last_reason = result && result.reason || 'no_result'; o.last_tool_calls = active.calls;
        if (o.status !== 'running') { event(o, 'pass_cancelled', 'Active pass stopped. Inspect saved files before resuming.'); return; }
        if (active.abort.signal.aborted || !result || result.reason !== 'done' || (result.uncertainMutations || []).length
          || (o.current_pass_failures || []).length) {
          o.status = 'attention'; o.message = 'This pass did not finish cleanly. Inspect its saved work, then resume explicitly.'; o.next_at = null;
        } else if (o.mode === 'once') { o.status = 'completed'; o.message = 'The bounded station pass finished; delivered files require owner review.'; o.next_at = null; }
        else { o.message = 'Native work saved. The station will reassess the goal on its next pass.'; o.next_at = now() + LIMITS.next_pass_ms; }
        event(o, 'pass_finished', o.message, { run_id: runId });
      });
    } catch (e) {
      try { update(id, o => { o.run_id = null; if (o.status === 'running') { o.status = 'attention'; o.message = 'Native run needs attention: ' + String(redact(e.message || e)).slice(0, 600); o.next_at = null; } event(o, 'pass_error', o.message, { run_id: runId }); }); } catch (_) {}
    } finally { d.clearTimeout(timebox); live = null; schedule(); }
  }
  function recover() {
    const op = current();
    if (!ready() || !op) return;
    const backupRecovered = state.status === 'recovered';
    if (op.run_id || backupRecovered) update(op.id, o => { o.interrupted_run_id = o.run_id; o.run_id = null; o.status = 'attention'; o.next_at = null;
      o.message = backupRecovered ? 'A backup ledger was recovered. The latest owner pause or stop may be missing; inspect saved work and confirm before resuming.'
        : 'StarNet restarted during a pass. Its saved station and files are preserved; inspect them before resuming.'; event(o, 'restart_recovery', o.message); });
    schedule();
  }
  function close() { if (timer) d.clearTimeout(timer); timer = null; if (live) live.abort.abort(); }
  return { snapshot, start, action, recover, close, artifact, recordResult, _pass: pass };
}
module.exports = { makeFloNativeOperations, LIMITS };
