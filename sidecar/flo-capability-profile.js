/* Fixed host-owned execution envelopes for Flo. They narrow every station grant,
   including Full Power, and cannot be widened by a prompt or a tool result. */
'use strict';
const { assertSafeUrl } = require('./tools/builtin/web.js');
const PROFILES = Object.freeze({
  'flo-text': Object.freeze({ id: 'flo-text', tools: Object.freeze([]), max_tool_calls: 0, max_iterations: 1, max_duration_ms: 600000 }),
  'flo-research': Object.freeze({ id: 'flo-research', tools: Object.freeze(['web_search', 'web_fetch']), max_tool_calls: 4, max_iterations: 8, max_duration_ms: 300000 }),
  'flo-operator': Object.freeze({ id: 'flo-operator', host_only: true, tools: Object.freeze([
    'web_search', 'web_fetch', 'fs.read', 'fs.write', 'fs.append', 'fs.edit', 'fs.search', 'fs.list', 'fs.patch',
    'notebook.read', 'notebook.write', 'notebook.search', 'notebook.feedback', 'recall_conversation', 'asset.svg_info', 'asset.export_svg',
    'team.list', 'team.dispatch', 'team.summon', 'team.subagents', 'team.steer',
    'session.list', 'session.create', 'session.peek', 'task.list', 'task.create', 'task.manage',
    'team.config', 'team.configure', 'station.layout', 'station.build', 'station.manual', 'station.deliveries', 'station.delivery_read', 'commerce.read', 'commerce.propose'
  ]), max_tool_calls: 80, max_iterations: 48, max_duration_ms: 900000 }),
  'flo-operator-worker': Object.freeze({ id: 'flo-operator-worker', host_only: true, tools: Object.freeze([
    'web_search', 'web_fetch', 'fs.read', 'fs.write', 'fs.append', 'fs.edit', 'fs.search', 'fs.list', 'fs.patch',
    'notebook.read', 'notebook.write', 'notebook.search', 'notebook.feedback', 'recall_conversation', 'asset.svg_info', 'asset.export_svg', 'station.delivery_read'
  ]), max_tool_calls: 40, max_iterations: 32, max_duration_ms: 600000 })
});
function resolve(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILES, value)) {
    throw new Error('Unknown capability_profile.');
  }
  return PROFILES[value];
}
function catalog() { return Object.values(PROFILES).map(p => Object.assign({}, p, { tools: p.tools.slice() })); }
function restrict(resolved, profile) {
  if (!profile) return resolved;
  const allowed = new Set(profile.tools);
  const out = Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(n => allowed.has(n)),
    deferred: (resolved.deferred || []).filter(n => allowed.has(n)),
    grants: (resolved.grants || []).filter(g => allowed.has(g.tool))
  });
  for (const key of ['approvalRules', 'networkCaps', 'unavailable']) {
    out[key] = {};
    for (const [name, value] of Object.entries(resolved[key] || {})) if (allowed.has(name)) out[key][name] = value;
  }
  return out;
}
function publicEvidenceUrl(value) {
  try {
    const u = assertSafeUrl(String(value));
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    return u.href.slice(0, 2000);
  } catch (_) { return null; }
}
function makeGuard(profile, sharedBudget) {
  if (!profile) return null;
  const allowed = new Set(profile.tools), trace = [], sources = [];
  let calls = 0, denied = 0, limitReason = null;
  function start(name, args) {
    if (!allowed.has(name)) { denied++; return { ok: false, summary: 'capability-profile-denied', content: 'This Flo profile cannot use ' + name + '. Continue only with its permitted capabilities.' }; }
    // Background station workers outlive the normal lead return. This durable
    // operation instead settles only after its foreground children have ended,
    // so its shared budget, pause signal and outcome remain one proven pass.
    if (profile.host_only && name === 'team.dispatch' && args
      && Object.prototype.hasOwnProperty.call(args, 'background') && args.background !== false) {
      denied++;
      return { ok: false, summary: 'capability-profile-foreground-required',
        content: 'Native Flo operations require foreground team.dispatch so every worker remains within this durable pass. Omit background or set it to false. Use parallel:true for concurrent work within the pass.' };
    }
    if (calls >= profile.max_tool_calls || sharedBudget && !sharedBudget.take()) {
      limitReason = limitReason || 'max_tool_calls';
      return { ok: false, summary: 'capability-profile-limit', content: 'This Flo run reached its admitted tool or time allowance. Finish with verified work and state what remains unfinished.' };
    }
    calls++;
    trace.push({ sequence: calls, tool: name, query: name === 'web_search' ? String((args || {}).query || '').slice(0, 2000) : undefined,
      url: name === 'web_fetch' ? publicEvidenceUrl((args || {}).url) : undefined, status: 'started' });
    return { ok: true, sequence: calls };
  }
  function finish(sequence, name, args, result) {
    const row = trace.find(r => r.sequence === sequence);
    if (!row) return;
    row.status = result && result.ok && !result.isError ? 'returned' : 'failed';
    row.summary = String((result && result.summary) || '').slice(0, 300);
    const content = String((result && result.content) || '');
    if (row.status !== 'returned') return;
    if (name === 'web_fetch') {
      // A refusal is a returned informational tool response, not a fetched public page.
      if (!/^[1-9]\d* chars via /.test(row.summary) || !row.url) { row.status = 'fetch_no_content'; return; }
      row.excerpt = content.slice(0, 8000);
      sources.push({ url: row.url, kind: 'page', excerpt: content.slice(0, 1000), sequence });
    } else if (name === 'web_search') {
      // Keyless engines report throttling/empty results as non-error answers. Preserve that
      // limitation explicitly without turning their URLs or advice into successful evidence.
      if (!/^[1-9]\d* result\(s\) via /.test(row.summary)) { row.status = 'search_no_results'; return; }
      const publicResults = [];
      const blocks = content.split(/(?=^\d+\. )/m);
      for (const block of blocks) for (const match of block.matchAll(/https?:\/\/[^\s<>]+/g)) {
        const url = publicEvidenceUrl(match[0]);
        if (url) publicResults.push({ url, kind: 'search_result', excerpt: block.slice(0, 1000), sequence });
      }
      if (!publicResults.length) { row.status = 'search_no_results'; return; }
      row.excerpt = content.slice(0, 8000);
      for (const source of publicResults) if (!sources.some(s => s.url === source.url && s.kind === 'search_result')) sources.push(source);
    }
  }
  function receipt() { return { capability_profile: profile.id, limits: Object.assign({}, profile, { tools: profile.tools.slice() }),
    tool_calls: calls, tools_ok: trace.filter(r => r.status === 'returned').length, denied_calls: denied, limit_reason: limitReason,
    tool_trace: trace.map(r => Object.assign({}, r)), sources: sources.slice(0, 40),
    public_web_evidence: sources.slice(0, 40).map(s => ({ tool: s.kind === 'page' ? 'web_fetch' : 'web_search', url: s.url,
      query: s.kind === 'search_result' ? (trace.find(r => r.sequence === s.sequence) || {}).query : undefined, status: s.kind === 'page' ? 'read' : 'search_result' })) }; }
  return { profile, start, finish, receipt, exhaust: reason => { limitReason = limitReason || String(reason); } };
}
module.exports = { resolve, catalog, restrict, makeGuard, publicEvidenceUrl };
