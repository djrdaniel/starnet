'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const DomainTask = require('../sidecar/domain-task.js');
const profiles = require('../sidecar/flo-capability-profile.js');
const { composeOffice } = require('../sidecar/capability/office.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

// Flo's default owner goal, followed by the real native host's instruction.
// A channel hostname here is task context, rather than a one-host lookup.
const GOAL = 'Build ongoing evidenced income to fund DJR. Use the real StarNet station, '
  + 'growing its specialist workforce, saved workstreams and useful capabilities '
  + 'as workload requires. Research eligible physical products for Etsy through '
  + 'reviewed suppliers or production partners, and create original digital '
  + 'products for itch.io. Measure actual sales and costs; sales are not profit. '
  + 'Keep both channels distinct. Bring concrete exceptions and external '
  + 'actions to Flo notifications. Existing store publication, purchases, '
  + 'spending and DJR production permissions remain separately approved.';
const message = GOAL + '\nFor commerce goals, first read commerce.read for actual Flo store connections. '
  + 'Inspect existing sessions/tasks before creating duplicates and produce original files with evidence and review criteria.';
const source = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const declaration = name => {
  const match = source.match(new RegExp('  const ' + name + ' = [^\\n]+;'));
  assert.ok(match, 'Exercise the shipped host declaration: ' + name); return match[0];
};
const wireStart = source.indexOf('  const directDomainWithheld =');
const wireEnd = source.indexOf('  // WITHHELD-vs-UNKNOWN', wireStart);
const guardStart = source.indexOf('    if (directDomainTask && directDomainWithheld(c.name))');
const guardEnd = source.indexOf('    // TAINT ENFORCEMENT', guardStart);
assert.ok(wireStart > 0 && wireEnd > wireStart && guardStart > 0 && guardEnd > guardStart);

function fixture({ native = true, worker = false, text = message, deferAll = false, env = {}, lookup = null } = {}) {
  const registry = makeRegistry(), providerCalls = [], fetchCalls = [];
  const web = makeWebTools({ publicOnly: true, lookup, politeMinGapMs: 0,
    fetchImpl: async (url, options) => { fetchCalls.push({ url: String(url), options }); return {
      status: 200, text: async () => 'Actual fixture public Etsy evidence about physical products.',
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/plain' : '' }
    }; } });
  web.register(registry);
  makeOrchestrationTools({ roster: () => new Map([['researcher', { name: 'RESEARCH', model: 'fixture' }]]), model: 'fixture',
    boundedDomainTasks: !native, newId: () => 'isolated-child', runOnce: async child => {
      providerCalls.push(child); return { reason: 'done', messages: [{ role: 'assistant', content: 'Actual isolated worker result' }], artifacts: [] };
    } }).register(registry);
  makeStationTools({ station: { request: async () => ({ ok: true, result: { sessions: [], count: 0 } }) } }).register(registry);
  const station = { agents: { agent: { id: 'agent', room: 'office' } }, rooms: { office: {
    id: 'office', objects: composeOffice({ surface: 'autonomous', lead: !worker }) } } };
  const profile = native ? profiles.resolve(worker ? 'flo-operator-worker' : 'flo-operator') : null;
  const resolved = profiles.restrict(resolveTools('agent', station), profile);
  if (deferAll) resolved.deferred = resolved.tools.slice();
  const authority = Object.freeze({});
  const o = { floNativeAuthority: native ? authority : {}, floNativePass: native ? {} : undefined };
  // Execute the actual host classifier, advertisement and dispatch restriction
  // seams against the genuine placed-capability projection and registry.
  const policy = vm.runInNewContext(declaration('floNative') + '\n' + declaration('directDomainTask') + '\n'
    + declaration('deferralOff') + '\n' + source.slice(wireStart, wireEnd)
    + '\n({ floNative, directDomainTask, deferralOff, toolDefs, deferredToolDefs, fromWire, '
    + 'guard: c => {\n' + source.slice(guardStart, guardEnd) + '\nreturn null; } })', {
      floProfile: profile, FLO_NATIVE_AUTHORITY: authority, o, isTask: true, DomainTask, resolved, registry,
      messages: [{ role: 'user', content: text }], latestUserText: messages => messages.at(-1).content, process: { env }
    });
  const capCtx = makeCapCtx(resolved, { consent: async () => ({ allow: true, mode: 'once' }), signal: new AbortController().signal });
  const guard = profiles.makeGuard(profile);
  const dispatch = async call => {
    const real = { ...call, name: policy.fromWire.get(call.name) || call.name };
    const blocked = policy.guard(real); if (blocked) return blocked;
    const admission = guard && guard.start(real.name, real.args);
    if (admission && !admission.ok) return { ...admission, isError: true };
    return registry.dispatch(real, capCtx);
  };
  return { policy, profile, resolved, registry, capCtx, dispatch, providerCalls, fetchCalls, web };
}

test('Default ongoing income goal keeps genuine native lead delegation and public search on its initial wire', () => {
  assert.equal(DomainTask.classify(message).host, 'itch.io', 'The old heuristic demonstrably misclassified the real composite goal.');
  const f = fixture(), names = f.policy.toolDefs.map(def => def.function.name);
  assert.equal(f.policy.floNative, true); assert.equal(f.policy.directDomainTask, null);
  for (const name of ['team_dispatch', 'team_summon', 'session_list', 'task_create', 'station_layout', 'web_search', 'web_fetch']) {
    assert.ok(names.includes(name), name + ' is actually declared from the native registry on the first model request.');
  }
  assert.equal(f.policy.deferredToolDefs.length, 0);
  for (const name of names) assert.ok(f.profile.tools.includes(f.policy.fromWire.get(name)), 'Advertisement cannot widen the execution envelope.');
  for (const name of ['tool_search', 'team_spawn', 'shell_exec', 'web_request', 'browser_navigate', 'routine_create']) assert.ok(!names.includes(name));
});

test('The actual model loop can invoke advertised named-worker delegation directly without tool.search', async () => {
  const f = fixture(); let turns = 0;
  const provider = { contextLimit: () => 32768, async *stream(request) {
    assert.ok(request.tools.some(def => def.function.name === 'team_dispatch'));
    assert.ok(request.tools.some(def => def.function.name === 'web_search'));
    assert.ok(!request.tools.some(def => def.function.name === 'tool_search'));
    if (turns++ === 0) {
      yield { type: 'tool_start', index: 0, id: 'actual-delegate', name: 'team_dispatch' };
      yield { type: 'tool_args', index: 0, chunk: JSON.stringify({ workers: [{ agentId: 'researcher', prompt: 'Research original physical product opportunities for Etsy and digital opportunities for itch.io.' }] }) };
      yield { type: 'done', finishReason: 'tool_calls' };
    } else { yield { type: 'text', delta: 'The real isolated worker returned its work.' }; yield { type: 'done', finishReason: 'stop' }; }
  } };
  const result = await runAgentLoop({ provider, messages: [{ role: 'user', content: message }], tools: f.policy.toolDefs,
    deferredTools: f.policy.deferredToolDefs, dispatch: f.dispatch, capCtx: f.capCtx,
    cost: makeCostEngine({ priceOf: () => ({ prompt: 0, completion: 0 }) }), emit() {}, agentId: 'agent', runId: 'isolated-model-loop',
    model: 'fixture', isTask: true, limits: { maxIters: 4, maxCostUsd: Infinity } });
  assert.equal(result.reason, 'done'); assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].agentId, 'researcher');
  assert.ok(result.messages.some(row => row.role === 'tool' && row.content.includes('Actual isolated worker result')));
});

test('Native commerce fetch can read a public Etsy source while keeping private addresses and credentials blocked', async () => {
  const f = fixture();
  const publicResult = await f.dispatch({ id: 'public-etsy', name: 'web_fetch', args: { url: 'https://www.etsy.com/seller-handbook/article/fixture' } });
  assert.equal(publicResult.ok, true); assert.equal(publicResult.isError, false);
  assert.match(publicResult.content, /Actual fixture public Etsy evidence/); assert.ok(f.fetchCalls.length > 0);
  for (const call of f.fetchCalls) for (const name of Object.keys(call.options.headers || {})) {
    assert.ok(!/^(authorization|cookie)$/i.test(name), 'The public fixture fetch receives no credentials or cookies.');
  }
  const before = f.fetchCalls.length;
  for (const url of ['http://127.0.0.1/private', 'http://10.0.0.1/private', 'http://169.254.169.254/private',
    'file:///etc/passwd', 'https://fixture:credential@www.etsy.com/private']) {
    const denied = await f.dispatch({ id: 'private-refusal', name: 'web_fetch', args: { url } });
    assert.equal(denied.isError, true, 'The genuine reader still refuses ' + new URL(url).hostname);
  }
  assert.equal(f.fetchCalls.length, before, 'A refused URL cannot reach even the injected network seam.');
  const rebound = fixture({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const denied = await rebound.dispatch({ id: 'rebound', name: 'web_fetch', args: { url: 'https://www.etsy.com/public' } });
  assert.equal(denied.isError, true); assert.equal(rebound.fetchCalls.length, 0);
});

test('Ordinary direct-domain inspection still withholds delegation/search and refuses a different public host', async () => {
  const f = fixture({ native: false, text: 'Read the current documentation on itch.io.' });
  assert.equal(f.policy.directDomainTask.host, 'itch.io');
  const names = f.policy.toolDefs.map(def => def.function.name);
  assert.ok(names.includes('web_fetch')); assert.ok(!names.includes('team_dispatch')); assert.ok(!names.includes('web_search'));
  const denied = await f.dispatch({ id: 'wrong-public-host', name: 'web_fetch', args: { url: 'https://www.etsy.com/public' } });
  assert.equal(denied.summary, 'direct-domain-target-only'); assert.equal(f.fetchCalls.length, 0);
  const delegated = await f.dispatch({ id: 'ordinary-delegate', name: 'team.dispatch', args: { workers: [] } });
  assert.equal(delegated.summary, 'direct-domain-local'); assert.equal(f.providerCalls.length, 0);
});

test('Native direct advertisement handles admitted deferred names without restoring worker orchestration', () => {
  const lead = fixture({ deferAll: true });
  assert.ok(lead.policy.toolDefs.some(def => def.function.name === 'team_dispatch'));
  assert.equal(lead.policy.deferredToolDefs.length, 0);
  const worker = fixture({ worker: true, deferAll: true }), names = worker.policy.toolDefs.map(def => def.function.name);
  assert.ok(names.includes('web_fetch')); assert.ok(names.includes('web_search'));
  assert.ok(names.every(name => !/^team_|^session_|^task_|^station_/.test(name)));
  assert.equal(worker.capCtx.canUse({ name: 'team.dispatch' }).ok, false);
  assert.equal(worker.policy.deferredToolDefs.length, 0);
});
