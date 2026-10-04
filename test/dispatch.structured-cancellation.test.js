'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { getEventListeners } = require('node:events');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

// Load the shipped engine with only its wall clock virtualized. The actual
// native dispatcher, result validator and AbortController execute unchanged.
function fixture() {
  let time = 0, seq = 0;
  const timers = new Map(), created = [];
  const file = path.join(__dirname, '../sidecar/tools/builtin/orchestration.js');
  const context = { module: { exports: {} }, require: createRequire(file), AbortController, console,
    setTimeout(fn, delay) { const id = ++seq; const timer = { fn, at: time + delay, delay }; timers.set(id, timer); created.push(timer); return id; },
    clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const clock = { now: () => time, elapse: ms => { time += ms; }, async advance(ms) {
    time += ms;
    for (const [id, task] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (task.at <= time && timers.has(id)) { timers.delete(id); task.fn(); await flush(); }
    }
    await flush();
  } };
  let ids = 0;
  return { clock, timers, created, tools: (impl, extra = {}) => context.module.exports.makeOrchestrationTools({
    roster: () => new Map([['maker', { name: 'MAKER' }], ['reviewer', { name: 'REVIEWER' }]]),
    model: 'fixture', newId: () => 'child-' + (++ids), now: clock.now, dispatchTimeoutMs: 600000, runOnce: impl, ...extra }) };
}
const resultSchema = { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] };
const result = (content, reason = 'done') => ({ reason, messages: [{ role: 'assistant', content }], artifacts: [] });

test('The parent cancellation link remains attached throughout genuine structured-output repair', async () => {
  const f = fixture(), parent = new AbortController();
  let repairSignal, initialSignal;
  const tools = f.tools(async child => {
    if (!child.outputOnly) { initialSignal = child.signal; return result('not structured JSON'); }
    repairSignal = child.signal;
    return new Promise(resolve => child.signal.addEventListener('abort', () => resolve(result('Stopped repair', 'cancelled')), { once: true }));
  });
  const pending = tools.dispatchTool.run({ workers: [{ agentId: 'maker', prompt: 'Assess the original prototype.', resultSchema }] },
    { agentId: 'agent', signal: parent.signal });
  await flush(); assert.ok(repairSignal); assert.equal(repairSignal, initialSignal);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 1, 'The real parent-to-child abort link still exists during repair.');
  parent.abort(); assert.equal(repairSignal.aborted, true, 'Pausing the lead immediately cancels the active repair.');
  const rows = JSON.parse((await pending).content); assert.notEqual(rows[0].reason, 'done');
  assert.equal(f.timers.size, 0); assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('Initial run and repair share the actual 600s dispatch fair share and preserve the next worker', async () => {
  const f = fixture(), parent = new AbortController();
  let repairSignal, calls = 0;
  const tools = f.tools(async child => {
    calls++;
    if (child.agentId === 'reviewer') return result('Useful final review');
    if (!child.outputOnly) { f.clock.elapse(250000); return { ...result('Saved original partial prototype notes'), usd: 0.2 }; }
    repairSignal = child.signal;
    return new Promise(resolve => child.signal.addEventListener('abort', () => resolve({ ...result('Repair stopped at shared deadline', 'cancelled'), usd: 0.1 }), { once: true }));
  });
  const pending = tools.dispatchTool.run({ workers: [{ agentId: 'maker', prompt: 'Assess the original prototype.', resultSchema },
    { agentId: 'reviewer', prompt: 'Inspect another independent product.' }] }, { agentId: 'agent', signal: parent.signal });
  await flush(); assert.ok(repairSignal);
  assert.equal(f.created.length, 1); assert.equal(f.created[0].delay, 300000, 'Two sequential workers share the 600000ms dispatch.');
  await f.clock.advance(49999); assert.equal(repairSignal.aborted, false);
  await f.clock.advance(1); assert.equal(repairSignal.aborted, true, 'The repair uses only the remaining initial slice.');
  const rows = JSON.parse((await pending).content);
  assert.equal(rows[0].reason, 'timeout'); assert.match(rows[0].result, /PARTIAL work/);
  assert.ok(Math.abs(rows[0].usd - 0.3) < 1e-9, 'Both real run costs survive the timeout row.');
  assert.equal(rows[1].reason, 'done'); assert.equal(calls, 3);
  assert.equal(f.created.length, 2, 'Repair creates no additional wall clock or renewed allowance.');
  assert.equal(f.created[1].delay, 300000, 'The next worker keeps the remaining dispatch allocation.');
  assert.equal(parent.signal.aborted, false); assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('A successful genuine repair releases the same timer and parent listener after both runs settle', async () => {
  const f = fixture(), parent = new AbortController();
  let calls = 0;
  const tools = f.tools(async child => { calls++; return result(child.outputOnly ? '{"accepted":true}' : 'Needs JSON repair'); });
  const output = await tools.dispatchTool.run({ workers: [{ agentId: 'maker', prompt: 'Assess the original prototype.', resultSchema }] },
    { agentId: 'agent', signal: parent.signal });
  const row = JSON.parse(output.content)[0]; assert.equal(row.reason, 'done'); assert.equal(row.validation.state, 'repaired');
  assert.equal(calls, 2); assert.equal(f.created.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('Host-admitted native delegation keeps its profile clock when a commerce brief names itch.io; ordinary lookup stays narrow', async () => {
  for (const native of [true, false]) {
    const f = fixture(), children = [];
    const tools = f.tools(async child => { children.push(child); return result('Actual isolated worker result'); },
      { boundedDomainTasks: !native, workerMaxIters: 32 });
    await tools.dispatchTool.run({ workers: [{ agentId: 'maker', prompt: 'Review ongoing digital product income for itch.io and create original prototype files.' }] },
      { agentId: 'agent', signal: new AbortController().signal });
    assert.equal(f.created[0].delay, native ? 600000 : 45000);
    assert.equal(children[0].maxIters, native ? 32 : 3);
    assert.equal(children[0].maxToolCalls, native ? undefined : 3);
    assert.equal(f.timers.size, 0);
  }
});
