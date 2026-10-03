'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const WM = require('../frontend/app/worldmodel.js');
const { makeStationStore } = require('../sidecar/station-store.js');
const { makeConsentWait } = require('../sidecar/consentwait.js');
const { makeStationOperator, makeNativeConsentBridge, consentArgumentDetails } = require('../sidecar/station-operator.js');
const { redact } = require('../sidecar/context.js');
const { makeOpenAiCompat } = require('../sidecar/openai-compat.js');

(async () => {
  let now = 1000, seq = 0, workCalls = 0;
  const timers = new Map(), pending = new Map(), ac = new AbortController();
  const prompts = new Map(); pending.set('run-1', prompts);
  const bridge = makeNativeConsentBridge({ pending, now: () => now });
  const wait = () => makeConsentWait({ pending: prompts, signal: ac.signal,
    timeoutMs: 120000, extendMs: 600000, now: () => now, uuid: () => 'prompt-' + (++seq),
    description: { agentId: 'agent', tool: 'fs.write', scope: 'write', argsSummary: 'save draft.txt',
      args: { path: 'draft.txt', content: 'Exact approved draft.' }, argsComplete: true },
    setTimeoutFn: fn => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeoutFn: id => timers.delete(id), emitPrompt() {} }).ask();
  const first = wait();
  assert.equal(bridge.snapshot().items[0].args_summary, 'save draft.txt');
  assert.equal(bridge.snapshot().items[0].args.content, 'Exact approved draft.');
  assert.equal(bridge.snapshot().items[0].args_complete, true);
  assert.equal(bridge.snapshot().items[0].expires_at, 121000);
  assert.equal(bridge.decide('run-1', 'prompt-1', 'full').code, 400);
  assert.equal(prompts.size, 1, 'rejected broad decisions cannot settle or grant');
  assert.equal(bridge.ack('run-1', 'prompt-1', false).code, 400);
  assert.equal(bridge.ack('run-1', 'prompt-1', true).extended, true);
  assert.equal(bridge.snapshot().items[0].expires_at, 601000);
  now += 50000;
  assert.equal(bridge.ack('run-1', 'prompt-1', true).extended, false);
  assert.equal(bridge.snapshot().items[0].expires_at, 601000, 'second ack cannot extend again');
  assert.equal(bridge.decide('run-1', 'prompt-1', 'once').ok, true);
  assert.equal(await first, 'once');
  assert.equal(bridge.decide('run-1', 'prompt-1', 'once').code, 409, 'settled approval is stale');
  assert.equal(bridge.snapshot().count, 0);

  const expired = wait(), expiredId = [...prompts.keys()][0];
  now += 120001;
  assert.equal(bridge.decide('run-1', expiredId, 'once').code, 409, 'expired approval cannot run before a delayed timer callback');
  assert.equal(bridge.snapshot().count, 0, 'expired prompt is absent even before the timer runs');
  assert.equal(bridge.ack('run-1', expiredId, true).code, 409);
  ac.abort(); assert.equal(await expired, 'deny', 'native abort retains its deny contract');
  assert.equal(consentArgumentDetails({ cmd: 'echo okay' }, redact).argsComplete, true);
  assert.equal(consentArgumentDetails({ cmd: 'x'.repeat(6001) }, redact).argsComplete, false);
  assert.equal(consentArgumentDetails({ authorization: 'private-token', cmd: 'echo okay' }, redact).argsComplete, false);
  assert.equal(JSON.stringify(consentArgumentDetails({ authorization: 'private-token' }, redact)).includes('private-token'), false);
  const incomplete = makeConsentWait({ pending: prompts, signal: new AbortController().signal, timeoutMs: 120000, now: () => now, uuid: () => 'incomplete',
    description: { tool: 'exec', argsComplete: false, argsSummary: 'an incomplete command' },
    setTimeoutFn: () => 900, clearTimeoutFn() {}, emitPrompt() {} }).ask();
  assert.deepEqual(bridge.snapshot().items[0].allowed_decisions, ['deny']);
  assert.equal(bridge.decide('run-1', 'incomplete', 'once').incomplete, true);
  assert.equal(bridge.decide('run-1', 'incomplete', 'deny').ok, true); assert.equal(await incomplete, 'deny');

  const station = WM.create().serialize(), checked = makeStationStore().validateStationDoc(station);
  let routed = checked.routingPlan;
  const operator = makeStationOperator({ now: () => now,
    saved: () => ({ station, _saveRevision: 7 }), routing: () => routed,
    goal: () => ({ id: 'g1', text: 'Fund DJR with original products', total: 5, done: 0, pct: 0, next: 'Review prototype', secret: 'MUST_NOT_LEAK' }),
    journey: () => ({ goals: [], progression: { level: 1, points: 0 }, receipts: ['MUST_NOT_LEAK'] }),
    grounding: () => ({ known: ['goals'], ready: { ok: false, reasons: ['no-person'] }, beliefs: { goals: ['MUST_NOT_LEAK'] } }),
    autonomy: () => ({ initiative: 'leash', reach: 'sandbox', leashPerDay: 3, enabled: true, secret: 'MUST_NOT_LEAK' }),
    crew: () => [{ agentId: 'agent', name: 'CHIEF', model: 'model', provider: 'codex', approvalMode: 'ask',
      system: 'MUST_NOT_LEAK', token: 'MUST_NOT_LEAK', manual: 'FLO COMPANY CONTRACT\nInternal worker-to-worker delegation is disabled.' }],
    consents: () => bridge.snapshot() });
  let snapshot = operator.snapshot();
  assert.equal(snapshot.goal.data.total, 5);
  assert.equal(snapshot.layout.data.routing.state, 'live');
  assert.equal(snapshot.crew.data.workers[0].manual_summary.delegation_disabled, true);
  assert.equal(snapshot.grounding.data.ready, false);
  assert.equal(snapshot.layout.data.line_count, 0);
  assert.equal(snapshot.operator_reference.integration.grants_authority_on_read, false);
  assert.equal(JSON.stringify(snapshot).includes('MUST_NOT_LEAK'), false, 'only allowlisted owner metadata crosses the boundary');
  routed = { hash: 'different-layout' };
  assert.equal(operator.snapshot().layout.data.routing.state, 'mismatch');
  routed = null;
  assert.equal(operator.snapshot().layout.data.routing.state, 'off');
  assert.equal(makeStationOperator({ now: () => now }).snapshot().goal.status, 'unavailable', 'missing reader is not confirmed empty');

  const key = 'station-owner-fixture-0123456789';
  const api = makeOpenAiCompat({ now: () => now, apiKey: () => key, isAllowedHost: h => /^127\.0\.0\.1(?::\d+)?$/.test(h),
    runOnce() { workCalls++; }, readBody: async req => { let body = ''; for await (const c of req) body += c; return body; },
    stationOperator: () => operator.snapshot(), stationConsent: q => q.action === 'ack'
      ? bridge.ack(q.runId, q.promptId, q.value) : bridge.decide(q.runId, q.promptId, q.value) });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const post = (route, body, h = headers) => fetch(base + route, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/v1/station/operator')).status, 401);
    assert.equal((await fetch(base + '/v1/station/operator', { headers: { 'X-StarNet-Token': key } })).status, 401, 'browser token header cannot replace bearer auth');
    const badHost = await new Promise(resolve => http.get(base + '/v1/station/operator',
      { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }));
    assert.equal(badHost, 403);
    assert.equal((await post('/v1/station/consents/run-1/prompt-1', { decision: 'once' }, {})).status, 401);
    const response = await fetch(base + '/v1/station/operator', { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).object, 'starnet.station.operator');
    for (const decision of ['always', 'session', 'full', 'approve', null]) {
      assert.equal((await post('/v1/station/consents/run-1/prompt-1', { decision })).status, 400);
    }
    assert.equal((await post('/v1/station/consents/run-1/prompt-1', { decision: 'once', full: true })).status, 400);
    assert.equal((await post('/v1/station/consents/run-1/prompt-1', { decision: 'once' })).status, 409);
    assert.equal((await post('/v1/station/consents/run-1/prompt-1/ack', { displayed: false })).status, 400);
    assert.equal((await post('/v1/station/consents/run-1/prompt-1/ack', { displayed: true })).status, 409);
    assert.equal((await post('/v1/station/consents/%ZZ/prompt-1', { decision: 'once' })).status, 404);
    assert.equal(workCalls, 0, 'reading and resolving stale requests starts no model work');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('station-operator: owner projection, auth, exact consent, stale/expiry and bounded ack passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
