'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const WM = require('../frontend/app/worldmodel.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture');
const { CREW } = require('../sidecar/station-setup.js');
const { makeWorkshopStore } = require('../sidecar/workshop-store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

(async () => {
  const key = 'station-setup-host-fixture-123456';
  const fixture = SidecarFixture.create({ prefix: 'station-setup-', env: { STARNET_API_KEY: key,
    NODE_OPTIONS: '--require ' + path.resolve(__dirname, 'fixtures/station-operator-provider.cjs') } });
  const ws = fixture.workspace, calls = path.join(ws, 'fixture-provider-calls.txt');
  fixture.env.STATION_PROVIDER_CALLS_FILE = calls;
  fs.mkdirSync(path.join(ws, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'codex/tokens.json'), JSON.stringify({ access_token:
    'e30.' + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url') + '.fake',
    refresh_token: 'MUST_NOT_LEAK_FIXTURE_SECRET', last_refresh: new Date().toISOString() }));
  const names = { agent: 'CHIEF OF STAFF', strategist: 'PRODUCT LEAD', researcher: 'RESEARCH', reviewer: 'QA REVIEWER' };
  const agents = CREW.map(id => ({ id, name: names[id], provider: 'codex', model: 'gpt-5.6-sol',
    approvalMode: 'ask', executionProfile: 'trusted-project', reasoningEffort: 'medium', role: 'Keep role ' + id,
    docs: { manual: 'Role instructions remain.\n\nFLO COMPANY CONTRACT\nOld contract.' } }));
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({ version: 1, agents: agents.map(a => ({ ...a,
    agentId: a.id, system: 'PRIVATE_PERSONA_KEEP\n' + a.docs.manual + '\nUNRELATED_TAIL_KEEP' })) }));
  fs.writeFileSync(path.join(ws, '_commander.autonomy.json'), JSON.stringify({ v: 1,
    posture: { v: 1, initiative: 'leash', reach: 'sandbox', leashPerDay: 3 }, beliefs: null }));
  const workshop = makeWorkshopStore({ fs, path, workspaces: ws, writeDurable: writeFileDurable });
  await workshop.queue('agent', { id: 'existing-build', title: 'Existing prototype decision brief', source: 'owner' }, 1);
  await workshop.markBuilt('agent', 'existing-build', 'prior-run', 2);
  const existingDir = path.join(ws, 'agent/workshop/prior-run'); fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(path.join(existingDir, 'decision.md'), 'Existing original draft.');
  fs.writeFileSync(path.join(existingDir, 'deliverable.json'), JSON.stringify({ v: 1, title: 'Existing prototype decision brief',
    summary: 'Original work awaiting owner review.', planOnly: true, files: [{ path: 'decision.md' }] }));
  const existingWorkshop = fs.readFileSync(path.join(ws, 'agent.workshop.json'), 'utf8');
  await fixture.start();
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const v1 = async (method, uri, body) => {
    const response = await fetch(fixture.baseUrl + uri, { method, headers, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const providerCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const run = async profile => {
    const created = await v1('POST', '/v1/runs', { model: 'RESEARCH', input: 'Only return a supplied-text answer.',
      ...(profile ? { capability_profile: profile } : {}) });
    assert.equal(created.status, 202);
    await (await fetch(fixture.baseUrl + '/v1/runs/' + created.body.run_id + '/events', { headers })).text();
    return (await v1('GET', '/v1/runs/' + created.body.run_id)).body;
  };
  try {
    const saved = await fixture.json('POST', '/api/save', { agent: agents[0], agents, _saveRevision: 0,
      station: WM.create().serialize(), preserve_me: { content: 'Existing Away build is not rewritten.' } });
    assert.equal(saved.body.ok, true);
    await fixture.json('POST', '/api/goals', { goal: { id: 'owner-goal', text: 'Fund DJR', done: 0, total: 5, pct: 0, next: 'Review prototype' } });
    const before = (await v1('GET', '/v1/station/operator')).body;
    assert.equal(before.operation.data.mode, 'native');
    assert.equal(before.owner_reviews.data.count, 1);
    assert.equal(before.owner_reviews.data.items[0].title, 'Existing prototype decision brief');
    assert.equal(before.owner_reviews.data.items[0].file_count, 1);
    assert.deepEqual(before.owner_reviews.data.items[0].allowed_actions, ['open_native_station']);
    const goalBefore = JSON.parse(fs.readFileSync(path.join(ws, '_commander.goals.json'))).goal;
    const postureBefore = JSON.parse(fs.readFileSync(path.join(ws, '_commander.autonomy.json'))).posture;
    const brief = { expected_revision: before.layout.data.save_revision,
      direction: 'Build original digital products for Etsy, itch and other low-maintenance income to fund DJR.',
      owner_context: 'Flo is my personal assistant and the workspace connecting all my projects.',
      standing_orders: 'Research and draft automatically. Bring publishing, spending and production changes to me for approval in Flo.' };
    assert.equal((await fetch(fixture.baseUrl + '/v1/station/brief', { method: 'POST', body: JSON.stringify(brief) })).status, 401);
    assert.equal((await v1('POST', '/v1/station/brief', { ...brief, extra_authority: true })).status, 400);
    const applied = await v1('POST', '/v1/station/brief', brief); assert.equal(applied.status, 200); assert.equal(applied.body.grounding.ready, true);
    assert.equal(applied.body.operation.native_unscoped_autonomous_allowed, false);
    const after = (await v1('GET', '/v1/station/operator')).body;
    assert.equal(after.operation.data.mode, 'flo-managed'); assert.equal(after.grounding.data.ready, true);
    assert.equal(after.owner_reviews.status, 'confirmed'); assert.equal(after.owner_reviews.data.count, 1);
    assert.equal(after.owner_reviews.data.items[0].source_revision, before.owner_reviews.data.items[0].source_revision);
    assert.equal(fs.readFileSync(path.join(ws, 'agent.workshop.json'), 'utf8'), existingWorkshop, 'setup preserves the existing native backlog/build');
    assert.equal(fs.readFileSync(path.join(existingDir, 'decision.md'), 'utf8'), 'Existing original draft.');
    assert.equal(after.goal.data.done, goalBefore.done); assert.equal(after.goal.data.total, goalBefore.total);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, '_commander.autonomy.json'))).posture, postureBefore);
    assert.ok(after.crew.data.workers.every(a => a.approval_mode === 'ask' && a.execution_profile === 'trusted-project' && a.model === 'gpt-5.6-sol'));
    assert.equal(JSON.stringify(after).includes('PRIVATE_PERSONA_KEEP'), false);
    assert.equal(providerCount(), 0, 'all setup uses only local native engines');
    const denied = await run(); assert.equal(denied.status, 'failed'); assert.match(denied.error, /Flo must explicitly admit/);
    assert.equal(providerCount(), 0, 'the host guard refuses unprofiled work before any provider call');
    const allowed = await run('flo-text'); assert.equal(allowed.status, 'completed'); assert.equal(providerCount(), 1);
    assert.equal((await v1('POST', '/v1/station/brief', brief)).status, 409, 'stale saved revision is refused');
    const floorPreview = await v1('GET', '/v1/station/setup'); assert.equal(floorPreview.status, 200);
    const floorRequest = { confirm: true, expected_revision: floorPreview.body.expected_revision, proposal_hash: floorPreview.body.proposal_hash };
    assert.equal((await v1('POST', '/v1/station/setup', { ...floorRequest, confirm: false })).status, 400);
    assert.equal((await v1('POST', '/v1/station/setup', floorRequest)).status, 200);
    const built = (await v1('GET', '/v1/station/operator')).body;
    assert.equal(built.layout.data.room_count, 2); assert.equal(built.layout.data.line_count, 1);
    assert.equal(built.layout.data.lines[0].step_count, 4); assert.equal(built.layout.data.routing.state, 'live');
    const canonical = await fixture.json('GET', '/api/save');
    assert.equal(canonical.body.save.preserve_me.content, 'Existing Away build is not rewritten.');
    assert.equal((await fixture.json('POST', '/api/autonomy/write', { agentId: 'agent', path: 'independent.txt', content: 'Must not appear.' })).status, 409);
    assert.equal(fs.existsSync(path.join(ws, 'agent/independent.txt')), false);
    const mirror = await fixture.json('POST', '/api/autonomy/posture', { beliefs: { known: [], beliefs: {}, ready: { ok: false } } });
    assert.equal(mirror.body.workshopGranted, false, 'readiness/posture sync cannot grant a new native away-build lane');
    await fixture.restart();
    const restarted = (await v1('GET', '/v1/station/operator')).body;
    assert.equal(restarted.operation.data.mode, 'flo-managed'); assert.equal(restarted.layout.data.routing.state, 'live');
    const countBefore = providerCount(); assert.equal((await run()).status, 'failed'); assert.equal(providerCount(), countBefore);
    assert.equal((await run('flo-text')).status, 'completed');
    console.log('station-setup.http: authenticated native setup, exact revision, preserved grants/settings/artifacts, live fixed routing and restart-persistent pre-provider admission guard passed');
  } finally { await fixture.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
