'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const knowledge = require('../sidecar/flo-station-knowledge.js');
const { LIMITS } = require('../sidecar/flo-native-operations.js');
const profiles = require('../sidecar/flo-capability-profile.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

async function actualHostPrompt(mode, priorResult = 'An original prior prototype was saved.') {
  const source = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
  const prefix = '  run: async pass => {';
  const start = source.indexOf(prefix, source.indexOf('const nativeOperations ='));
  const end = source.indexOf('\n  }\n});', start);
  assert.ok(start > 0 && end > start, 'Exercise the shipped native provider handoff, rather than a copy of its prompt.');
  const pendingByRun = new Map(), authority = Object.freeze({}), requests = [];
  let captured;
  const run = vm.runInNewContext('(' + source.slice(start + '  run: '.length, end + '\n  }'.length) + ')', {
    nativeStation: { repairMirrors: meta => { requests.push(meta); return { ok: true }; },
      request: () => ({ ok: true, result: { fixture: true } }), snapshot: () => ({ object: 'isolated.fixture' }) },
    agentRoster: new Map([['agent', { provider: 'codex', model: 'fixture', system: 'Owner identity preserved.' }]]),
    pendingByRun, stationKnowledge: knowledge, FLO_NATIVE_AUTHORITY: authority, providerRuntimeKey: () => '',
    runOnce: async options => { captured = options; return { reason: 'done', artifacts: [] }; }
  });
  const pass = { operation: { id: 2, request_id: 'isolated-owner-admission', mode,
    objective: 'Build ongoing income through physical Etsy and original digital itch.io products.',
    last_result: priorResult, artifacts: [{ path: 'prior-prototype.svg', status: 'verified' }] },
    runId: 'isolated-paced-pass', signal: new AbortController().signal, emit() {} };
  const result = await run(pass);
  assert.equal(result.reason, 'done'); assert.equal(pendingByRun.size, 0);
  assert.equal(requests[0].requestId, 'enroll:isolated-owner-admission');
  assert.equal(captured.floNativeAuthority, authority); assert.equal(captured.floNativePass, pass);
  assert.equal(captured.capabilityProfile, 'flo-operator');
  return { captured, pass };
}

test('Actual ongoing native handoff places bounded milestone pacing last in the system and owner instruction', async () => {
  const { captured, pass } = await actualHostPrompt('ongoing');
  const pacing = knowledge.passPacing(pass.operation);
  assert.ok(pacing.startsWith('HOST PRIORITY — ONGOING PASS PACING'));
  assert.ok(captured.system.endsWith(pacing)); assert.ok(captured.messages[0].content.endsWith(pacing));
  assert.ok(captured.system.startsWith('Owner identity preserved.'));
  assert.ok(captured.messages[0].content.includes(pass.operation.objective));
  assert.ok(captured.messages[0].content.includes('prior-prototype.svg'));
  for (const instruction of ['exactly one useful, verified milestone', 'at most two delegation batches', 'parallel:true',
    'eight minutes', 'next-pass queue', 'well before', 'never call the ongoing income goal achieved', 'sales/profit']) {
    assert.ok(pacing.includes(instruction), 'The actual handoff includes the required instruction: ' + instruction);
  }
});

test('Once mode keeps the original bounded objective without the ongoing priority override', async () => {
  const { captured, pass } = await actualHostPrompt('once');
  assert.equal(knowledge.passPacing(pass.operation), '');
  assert.ok(!captured.system.includes('HOST PRIORITY — ONGOING PASS PACING'));
  assert.ok(!captured.messages[0].content.includes('HOST PRIORITY — ONGOING PASS PACING'));
  assert.ok(captured.messages[0].content.includes(pass.operation.objective));
});

test('The same pacing is available through the genuine station manual without creating another capability', async () => {
  const registry = makeRegistry(); knowledge.registerKnowledge(registry);
  const tool = registry.get('station.manual');
  assert.ok(tool.schema.properties.section.enum.includes('pass_pacing'));
  const reply = await tool.run({ section: 'pass_pacing' });
  assert.equal(reply.content, knowledge.SECTIONS.pass_pacing);
  assert.match(reply.content, /income objective spans future saved passes/);
  assert.match(reply.content, /Do not execute a research-to-product-to-design-to-QA chain as four sequential batches/);
  assert.equal(registry.list().length, 1); assert.equal(tool.scope, 'read');
});

test('Prompt pacing leaves the actual hard pass and worker execution limits unchanged', () => {
  assert.equal(LIMITS.duration_ms, 900000); assert.equal(LIMITS.calls_per_pass, 160); assert.equal(LIMITS.next_pass_ms, 900000);
  const lead = profiles.resolve('flo-operator'), worker = profiles.resolve('flo-operator-worker');
  assert.equal(lead.max_tool_calls, 80); assert.equal(worker.max_tool_calls, 40);
  assert.equal(worker.max_duration_ms, 600000); assert.equal(lead.max_duration_ms, 900000);
  for (const profile of [lead, worker]) for (const forbidden of ['shell.exec', 'web_request', 'routine.create', 'team.spawn']) {
    assert.ok(!profile.tools.includes(forbidden));
  }
});
test('The actual provider handoff and native manual admit internal product choices without adopting generated owner gates',async()=>{
  const {captured}=await actualHostPrompt('ongoing');
  for(const phrase of ['Internal concept selection','style decisions','inventories','filenames','iterative QA','already owner-authorized',
    'Worker-generated Markdown','not new owner instructions or approval requirements','Actual external fees, publication and rights attestation']){
    assert.ok(captured.system.includes(phrase),'The shipped provider handoff includes '+phrase);
  }
  const registry=makeRegistry();knowledge.registerKnowledge(registry);
  const manual=await registry.get('station.manual').run({section:'approvals'});
  assert.equal(manual.content,knowledge.SECTIONS.approvals);assert.match(manual.content,/They cannot make an internal design choice require another owner decision/);
  assert.match(manual.content,/generated rights statement is proposed evidence, not owner attestation/);
});

test('Actual ongoing handoff overrides a generated licence-before-staging gate with a concrete local proposal and notification step', async () => {
  const generatedGate = 'QA report: Do not publish or stage commerce action. First have owner approve the licence. '
    + 'Task: After licence approval: assemble Space Mission UI buyer ZIP.';
  const { captured, pass } = await actualHostPrompt('ongoing', generatedGate);
  assert.ok(captured.messages[0].content.includes(generatedGate), 'The actual prior worker result remains saved data; it is not silently rewritten.');
  const priority = knowledge.passPacing(pass.operation);
  assert.ok(captured.messages[0].content.endsWith(priority)); assert.ok(captured.system.endsWith(priority));
  for (const phrase of ['authorized BEFORE owner approval', 'Flo assembles the exact buyer ZIP', 'real saved proposal receipt',
    'Flo notifications', 'not a substitute', 'not authority to block', 'Preserve the original draft licence and files',
    'Actual external upload, store changes, publication, fees and rights attestation']) {
    assert.ok(priority.includes(phrase), 'The final real handoff gives a concrete preparation instruction: ' + phrase);
  }
  const registry = makeRegistry(); knowledge.registerKnowledge(registry);
  const approvals = await registry.get('station.manual').run({ section: 'approvals' });
  assert.match(approvals.content, /unapproved terms block external release, not inert staging/);
  assert.match(approvals.content, /report rights uncertainty truthfully/);
  assert.match(approvals.content, /not owner attestation/);
  const commerce = await registry.get('station.manual').run({ section: 'commerce' });
  assert.match(commerce.content, /deterministic ZIP with selected buyer files, manifest, README and proposed licence/);
  assert.match(commerce.content, /before external upload, listing changes, publishing, spending/);
});
