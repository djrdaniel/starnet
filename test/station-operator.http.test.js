'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const WM = require('../frontend/app/worldmodel.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture');

(async () => {
  const key = 'station-operator-host-fixture-123456';
  const fixture = SidecarFixture.create({ prefix: 'station-operator-', env: { STARNET_API_KEY: key,
    NODE_OPTIONS: '--require ' + path.resolve(__dirname, 'fixtures/station-operator-provider.cjs') } });
  const ws = fixture.workspace;
  fs.mkdirSync(path.join(ws, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'codex/tokens.json'), JSON.stringify({ access_token:
    'e30.' + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url') + '.fake',
    refresh_token: 'MUST_NOT_LEAK_FIXTURE_SECRET', last_refresh: new Date().toISOString() }));
  const agent = { id: 'agent', name: 'CHIEF OF STAFF', provider: 'codex', model: 'gpt-5.6-sol',
    approvalMode: 'ask', executionProfile: 'trusted-project', createdAt: 1,
    docs: { manual: 'FLO COMPANY CONTRACT\nInternal worker-to-worker delegation is disabled.' } };
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [
    { ...agent, agentId: 'agent', system: 'MUST_NOT_LEAK_PRIVATE_PERSONA' } ] }));
  await fixture.start();
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const get = async () => {
    const response = await fetch(fixture.baseUrl + '/v1/station/operator', { headers });
    assert.equal(response.status, 200); return response.json();
  };
  const postConsent = (runId, promptId, body, ack = false) => fetch(fixture.baseUrl
    + '/v1/station/consents/' + runId + '/' + promptId + (ack ? '/ack' : ''),
    { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(fixture.baseUrl + '/v1/station/operator')).status, 401);
    const saved = await fixture.json('POST', '/api/save', { agent, agents: [agent], _saveRevision: 0,
      station: WM.create().serialize() });
    assert.equal(saved.body.ok, true);
    await fixture.json('POST', '/api/goals', { goal: { id: 'owner-goal', text: 'Fund DJR with original digital products',
      done: 0, total: 5, pct: 0, next: 'Review prototype' } });
    const before = await get();
    assert.equal(before.goal.data.text, 'Fund DJR with original digital products');
    assert.equal(before.layout.status, 'confirmed');
    assert.equal(before.layout.data.line_count, 0);
    assert.equal(before.crew.data.workers[0].approval_mode, 'ask');
    assert.equal(before.crew.data.workers[0].manual_summary.delegation_disabled, true);
    assert.equal(before.pending_consents.data.count, 0);
    assert.equal(JSON.stringify(before).includes('MUST_NOT_LEAK'), false);
    const snapshot = await fixture.json('GET', '/api/state/snapshot');
    assert.equal(snapshot.body.runs.length, 0, 'operator read starts no run');

    for (const mode of ['approve', 'deny']) {
      const stream = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent', provider: 'codex', model: 'gpt-5.6-sol', isTask: true,
          system: 'Use your files tool to write the single requested local test draft.',
          messages: [{ role: 'user', content: 'STATION_BRIDGE_' + mode.toUpperCase() + ' write the local test draft.' }] }) });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader(), decoder = new TextDecoder();
      let buffered = '', runId = '', promptId = '', handled = false;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        buffered += decoder.decode(part.value, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line), payload = event.payload || {};
          if (event.name === 'agent.run.start') runId = payload.runId;
          if (event.name !== 'permission.prompt') continue;
          promptId = payload.promptId;
          const live = await get(), row = live.pending_consents.data.items.find(p => p.prompt_id === promptId);
          assert.ok(row, 'real native permission appears through bearer projection');
          assert.equal(row.run_id, runId); assert.equal(row.tool, payload.tool);
          assert.equal(row.args_summary, payload.argsSummary, 'dashboard receives the same concrete native request');
          assert.equal(row.args_complete, true); assert.equal(row.args.path, 'operator-' + mode + '.txt');
          assert.equal(row.args.content, 'Owner-reviewed local test draft.');
          assert.equal((await postConsent(runId, promptId, { decision: 'full' })).status, 400);
          const ack = await postConsent(runId, promptId, { displayed: true }, true);
          assert.equal(ack.status, 200); assert.equal((await ack.json()).extended, true);
          assert.equal((await (await postConsent(runId, promptId, { displayed: true }, true)).json()).extended, false);
          const answer = await postConsent(runId, promptId, { decision: mode === 'approve' ? 'once' : 'deny' });
          assert.equal(answer.status, 200); assert.equal((await answer.json()).ok, true);
          handled = true;
        }
      }
      assert.ok(handled, 'the real native ask broker paused for a concrete decision');
      assert.equal(fs.existsSync(path.join(ws, 'agent', 'operator-' + mode + '.txt')), mode === 'approve',
        'only exact approved native write reaches the workspace');
      assert.equal((await postConsent(runId, promptId, { decision: 'once' })).status, 409, 'settled native request cannot be replayed');
      assert.equal((await get()).pending_consents.data.count, 0);
    }
    const grants = await fixture.json('GET', '/api/permissions');
    assert.equal(grants.body.masterBypass, false);
    assert.ok(!(grants.body.grants || []).includes('cabinet:write'), 'approve-once does not persist a write grant');
  } finally { await fixture.dispose(); }
  console.log('station-operator.http: real native pending/once/deny/ack, auth, no credential projection and no standing grant passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
