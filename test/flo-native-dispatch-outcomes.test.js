'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { wrapNativeDispatch } = require('../sidecar/flo-native-dispatch.js');
const { makeFloNativeOperations } = require('../sidecar/flo-native-operations.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

function fixture(t, args, childImpl, mode = 'once', extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-native-dispatch-outcomes-'));
  let time = Date.parse('2026-10-04T09:00:00Z'), seq = 0, calls = 0, result;
  const timers = new Set();
  const roster = new Map([['maker', { name: 'MAKER', model: 'fixture' }], ['reviewer', { name: 'REVIEWER', model: 'fixture' }]]);
  const operations = makeFloNativeOperations({ fs, path, workspaces: workspace, writeDurable: writeFileDurable,
    now: () => time, newId: () => 'host-' + (++seq), redact: value => value,
    setTimeout() { const token = { unref() {} }; timers.add(token); return token; }, clearTimeout: token => timers.delete(token),
    workers: () => [], enroll() {}, verifyArtifact: async () => ({ sha256: 'a'.repeat(64), size: 5 }),
    run: async pass => {
      const tools = makeOrchestrationTools({ roster: () => roster, model: 'fixture', newId: () => 'child-' + (++seq),
        now: () => time, dispatchTimeoutMs: 600000, ...extra,
        runOnce: async child => {
          calls++;
          const value = await childImpl(child, { advance(ms) { time += ms; } });
          await pass.recordResult(child.agentId, child.runId, value);
          return value;
        } });
      const raw = tools.dispatchTool.run;
      tools.dispatchTool.run = wrapNativeDispatch(raw, { callIdentity: () => 'tool:host-owned-call', recordResult: pass.recordResult });
      result = await tools.dispatchTool.run(args, { agentId: 'agent', runId: pass.runId, signal: pass.signal });
      // The host must still hold attention if a lead overlooks the tool error.
      return { reason: 'done', text: 'Lead returned its final summary.', artifacts: [] };
    } });
  t.after(() => { operations.close(); assert.ok(workspace.startsWith(path.join(os.tmpdir(), 'flo-native-dispatch-outcomes-'))); fs.rmSync(workspace, { recursive: true, force: true }); });
  const started = operations.start({ confirm: true, request_id: 'owner-dispatch-proof', objective: 'Produce and review a real prototype.', mode });
  assert.equal(started.ok, true);
  return { async pass() { await operations._pass(started.operation.id); return operations.snapshot().operation; },
    result: () => result, calls: () => calls, timers, workspace };
}
const done = () => ({ reason: 'done', messages: [{ role: 'assistant', content: 'Original useful result' }], artifacts: [] });

test('A genuine dispatch preflight rejection prevents bounded completion and ongoing rescheduling', async t => {
  for (const mode of ['once', 'ongoing']) {
    const f = fixture(t, { workers: [{ agentId: 'missing', prompt: 'Save the prototype.' }] }, done, mode);
    const op = await f.pass();
    assert.equal(f.calls(), 0);
    assert.equal(JSON.parse(f.result().content)[0].reason, 'error');
    assert.equal(op.status, 'attention'); assert.equal(op.next_at, null);
    assert.equal(op.current_pass_failures[0].agent_id, 'missing');
    assert.equal(op.current_pass_failures[0].reason, 'error');
    assert.equal(f.timers.size, 0, 'No later pass is admitted after rejected dispatch.');
    const disk = JSON.parse(fs.readFileSync(path.join(f.workspace, '_flo.native-operations.json')));
    assert.equal(disk.value.operations[0].status, 'attention', 'The failure is durable.');
  }
});

test('Refusal survives genuine dispatcher retry and cannot be hidden by a done lead', async t => {
  const f = fixture(t, { workers: [{ agentId: 'maker', prompt: 'Save the prototype.' }] }, async () => null);
  const op = await f.pass(); assert.equal(f.calls(), 2);
  const row = JSON.parse(f.result().content)[0]; assert.equal(row.reason, 'refused');
  assert.equal(op.status, 'attention'); assert.equal(op.next_at, null);
  assert.ok(op.current_pass_failures.some(failure => failure.reason === 'refused'));
});

test('Genuine structured-output validation failure is recorded after raw children returned done', async t => {
  const resultSchema = { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false };
  const f = fixture(t, { workers: [{ agentId: 'maker', prompt: 'Assess original files.', resultSchema }] }, done);
  const op = await f.pass(); assert.equal(f.calls(), 2, 'The genuine validator attempted its one output repair.');
  assert.equal(JSON.parse(f.result().content)[0].reason, 'invalid-result');
  assert.equal(op.status, 'attention'); assert.equal(op.next_at, null);
  assert.equal(op.current_pass_failures[0].reason, 'invalid-result');
});

test('A native worker not reached within the real shared dispatch clock holds attention', async t => {
  const f = fixture(t, { workers: [{ agentId: 'maker', prompt: 'Save the prototype.' }, { agentId: 'reviewer', prompt: 'Review it.' }] },
    async (_child, clock) => { clock.advance(600001); return done(); });
  const op = await f.pass(); assert.equal(f.calls(), 1);
  assert.equal(JSON.parse(f.result().content)[1].reason, 'not-dispatched');
  assert.equal(op.status, 'attention');
  assert.ok(op.current_pass_failures.some(failure => failure.agent_id === 'reviewer' && failure.reason === 'not-dispatched'));
});

test('Clean genuine dispatch creates no extra success recording and preserves verified artifacts', async t => {
  const f = fixture(t, { workers: [{ agentId: 'maker', prompt: 'Save the prototype.' }] },
    async () => ({ ...done(), artifacts: [{ kind: 'file', path: 'prototype.txt' }] }));
  const op = await f.pass(); assert.equal(op.status, 'completed'); assert.equal(f.calls(), 1);
  assert.deepEqual(op.current_pass_failures, []); assert.equal(op.artifacts.length, 1);
  assert.equal(op.events.filter(event => event.type === 'artifact_verified').length, 1);
});

test('Final dispatch recording retains the exact genuine tool result and uses only host call identity', async () => {
  const original = { content: JSON.stringify([{ agentId: 'maker', reason: 'error', result: 'No such session.' }]), summary: 'dispatched 1', taintedBy: 'source' };
  const records = [];
  const run = wrapNativeDispatch(async () => original, { callIdentity: () => 'host-call', recordResult: async (...args) => records.push(args) });
  assert.equal(await run({ workers: [{ agentId: 'maker', prompt: 'x' }], request_id: 'model-supplied-id' }, {}), original);
  assert.equal(records.length, 1); assert.match(records[0][1], /^dispatch:[a-f0-9]{64}$/);
  assert.equal(records[0][2].reason, 'error'); assert.deepEqual(records[0][2].artifacts, []);
});

test('The shipped named-worker check is inside the native child error recorder', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
  const match = source.match(/const nativeChildRun = floNative \? (async child => \{[\s\S]*?\n  \}) : runOnce;/);
  assert.ok(match, 'Exercise the actual shipped host child wrapper.');
  for (const roster of [new Map(), new Map([['maker', { provider: 'other' }]])]) {
    const records = []; let providerCalls = 0;
    const run = vm.runInNewContext('(' + match[1] + ')', { agentRoster: roster,
      o: { floNativePass: { recordResult: async (...args) => records.push(args) } },
      runOnce: async () => { providerCalls++; }, providerRuntimeKey: () => '', FLO_NATIVE_AUTHORITY: {} });
    await assert.rejects(run({ agentId: 'maker', runId: 'child-recorded' }), /real named ChatGPT OAuth worker/);
    assert.equal(providerCalls, 0); assert.equal(records.length, 1);
    assert.equal(records[0][0], 'maker'); assert.equal(records[0][1], 'child-recorded');
    assert.equal(records[0][2].reason, 'error');
  }
  assert.match(source, /if \(floNative\) runOrchestration\.dispatchTool\.run = require\('\.\/flo-native-dispatch\.js'\)\.wrapNativeDispatch/);
});
