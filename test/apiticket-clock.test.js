'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const tickets = require('../sidecar/apitickets.js');

(async () => {
  let browserMs = 1700000000000, serverMs = browserMs + 3600000, mono = 100, probes = 0, fail = false;
  class BrowserDate extends Date { static now() { return browserMs; } }
  const key = 'fixture-clock-key-not-a-real-token';
  const window = { __STARNET_API_TOKEN__: key, performance: { now: () => mono }, crypto: crypto.webcrypto,
    fetch: async (url, init) => {
      probes++; assert.equal(url, '/api/health'); assert.equal(init.cache, 'no-store');
      if (fail) throw new Error('offline');
      return { ok: true, headers: { get: name => name === 'date' ? new Date(serverMs).toUTCString() : null } };
    } };
  const ctx = vm.createContext({ window, Date: BrowserDate, TextEncoder, AbortController, setTimeout, clearTimeout,
    btoa: s => Buffer.from(s, 'binary').toString('base64') });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app/apiticket.js'), 'utf8'), ctx);
  const api = window.ApiTicket, claim = () => new URL(api.sseUrl('cursor=fixture'), 'http://127.0.0.1').searchParams.get('ticket');
  const verify = ticket => tickets.verify(key, ticket, 'sse', tickets.SCOPE_SSE, { now: serverMs, guard: tickets.replayGuard(10) });
  assert.equal(verify(claim()).reason, 'expired', 'the old browser clock expires a freshly minted ticket');
  const first = api.refreshClock(), same = api.refreshClock(); assert.equal(first, same, 'concurrent clock probes share one request');
  assert.equal(await first, true); assert.equal(probes, 1);
  assert.equal(verify(claim()).ok, true, 'the server Date anchor keeps the two-minute ticket valid despite one-hour skew');
  const expires = tickets.parse(claim()).exp;
  assert.ok(expires - serverMs <= tickets.KINDS.sse.maxTtlMs, 'no larger TTL is granted');
  browserMs -= 7200000; mono += 5000; serverMs += 5000;
  assert.equal(verify(claim()).ok, true, 'browser wall-clock jumps do not change the server clock anchor');
  serverMs -= 3600000;
  assert.equal(verify(claim()).reason, 'lifetime over cap', 'a server correction remains fail closed until fresh clock evidence');
  assert.equal(await api.refreshClock(), true); assert.equal(verify(claim()).ok, true);
  const ticket = claim(), guard = tickets.replayGuard(10);
  assert.equal(tickets.verify(key, ticket, 'sse', tickets.SCOPE_SSE, { now: serverMs, guard }).ok, true);
  assert.equal(tickets.verify(key, ticket, 'sse', tickets.SCOPE_SSE, { now: serverMs, guard }).reason, 'replayed');
  fail = true; assert.equal(await api.refreshClock(), false, 'an offline clock probe does not pretend to succeed');
  assert.ok(!api.sseUrl().includes(key), 'only a scoped ticket appears in the URL');
  console.log('apiticket-clock: server clock anchor, one-hour WSL/browser skew, wall-clock jump/correction, bounded TTL, coalescing, offline and replay passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
