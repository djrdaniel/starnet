'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { makeFloNativeDeliveries, MAX_BYTES, MAX_ITEMS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } = require('../sidecar/flo-native-deliveries.js');
const { makeFloNativeOperations } = require('../sidecar/flo-native-operations.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeFloNativeCommerce } = require('../sidecar/flo-native-commerce.js');
const { makeFloNativeSvgExport } = require('../sidecar/flo-native-svg-export.js');
const { makeArtifactCollector } = require('../sidecar/artifacts.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const profiles = require('../sidecar/flo-capability-profile.js');
const { makeImageWire } = require('../sidecar/tools/builtin/imagewire.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const codex = require('../sidecar/providers/codex.js');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ctx = (profile = 'flo-operator', outputMax = 8000) => Object.assign(makeCapCtx(profiles.restrict({
  agentId: 'agent', room: 'office', hasCompute: true, tools: ['station.deliveries', 'station.delivery_read', 'commerce.propose', 'asset.svg_info', 'asset.export_svg'],
  grants: [], approvalRules: {}
}, profiles.resolve(profile)), { consent: async () => ({ allow: true, mode: 'once' }) }), { outputMax });
const receipt = n => ({ id: digest('artifact-' + n).slice(0, 32), operation_id: 2, agent_id: n % 2 ? 'designer' : 'researcher',
  run_id: 'real-child-run-' + n, path: 'products/icon-' + n + '.png', sha256: digest('file-' + n), size: n + 1, status: 'verified' });
const fixture = (length = 83) => {
  const state = { object: 'starnet.station.operations', schema_version: 1, ledger_status: 'ok',
    operation: { id: 2, run_id: 'host-current-pass', status: 'running' }, artifacts: Array.from({ length }, (_, n) => receipt(n)) };
  let reads = 0;
  const tool = makeFloNativeDeliveries({ context: () => ({ operation_id: 2, run_id: 'host-current-pass' }),
    snapshot: () => { reads++; return state; } });
  return { state, tool, reads: () => reads };
};

test('Fresh bounded pages return every exact receipt once, with optional actual worker filtering', () => {
  const f = fixture(), actual = []; let cursor;
  do {
    const page = f.tool.read(cursor ? { cursor } : {}, { outputMax: 8000 });
    assert.equal(page.read_only, true); assert.equal(page.source.operation_id, 2); assert.equal(page.source.run_id, 'host-current-pass');
    assert.equal(page.total, 83); assert.ok(page.artifacts.length <= MAX_ITEMS);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= Math.min(MAX_BYTES, 8000));
    actual.push(...page.artifacts); cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(actual.map(row => row.id), f.state.artifacts.map(row => row.id));
  assert.equal(new Set(actual.map(row => row.id)).size, 83);
  assert.ok(!JSON.stringify(actual).includes('file_'));
  const worker = f.tool.read({ agent_id: 'designer' }); assert.equal(worker.total, 41);
  assert.ok(worker.artifacts.every(row => row.agent_id === 'designer'));
  assert.deepEqual(f.tool.read({ agent_id: 'missing-worker' }).artifacts, []);
});

test('A changed delivery at an existing path invalidates pagination instead of silently omitting or duplicating files', () => {
  const f = fixture(), first = f.tool.read({}); assert.ok(first.next_cursor);
  f.state.artifacts[5] = { ...f.state.artifacts[5], id: digest('changed-receipt').slice(0, 32), sha256: digest('changed-bytes') };
  assert.throws(() => f.tool.read({ cursor: first.next_cursor }), /manifest changed/);
  const fresh = f.tool.read({}); assert.notEqual(fresh.manifest_revision, first.manifest_revision);
  assert.equal(fresh.artifacts[5].id, f.state.artifacts[5].id);
  assert.throws(() => f.tool.read({ cursor: fresh.next_cursor, agent_id: 'designer' }), /manifest changed/);
});

test('Forged operation/run/path/URL selectors and invalid cursors are refused before any ledger read', () => {
  const f = fixture();
  for (const args of [{ operation_id: 7 }, { run_id: 'model' }, { path: '../../private' }, { url: 'http://127.0.0.1/private' },
    { cursor: 'model-invented' }, { agent_id: '' }, { agent_id: 'a\nprivate' }, [], null]) assert.throws(() => f.tool.read(args));
  assert.equal(f.reads(), 0);
  const revision = f.tool.read({}).manifest_revision;
  for (const offset of ['0', '83', '999']) assert.throws(() => f.tool.read({ cursor: revision + ':' + offset }), /cursor/);
});

test('Paused, stale, corrupt and incomplete ledger state cannot supply a staging manifest', () => {
  for (const mutation of [f => { f.state.operation.status = 'paused'; }, f => { f.state.operation.run_id = 'another-pass'; },
    f => { f.state.operation.id = 3; }, f => { f.state.ledger_status = 'unproven'; },
    f => { f.state.artifacts[0].sha256 = 'guessed'; }, f => { f.state.artifacts[0].status = 'written'; },
    f => { f.state.artifacts[0].operation_id = 3; }, f => { f.state.artifacts[0].size = -1; }]) {
    const f = fixture(); mutation(f); assert.throws(() => f.tool.read({}));
  }
  assert.throws(() => makeFloNativeDeliveries({ context: () => null, snapshot: () => fixture().state }).read({}));
});

test('Registered reader follows the actual output budget and is refused to native children before reading state', async () => {
  const f = fixture(), registry = makeRegistry(); f.tool.register(registry);
  const lead = await registry.dispatch({ id: 'lead-read', name: 'station.deliveries', args: {} }, ctx());
  assert.equal(lead.isError, false, lead.content); const value = JSON.parse(lead.content);
  assert.ok(Buffer.byteLength(lead.content) <= 8000); assert.ok(value.next_cursor);
  const before = f.reads();
  for (const profile of ['flo-operator-worker', 'flo-research', 'flo-text']) {
    const denied = await registry.dispatch({ id: 'denied-read', name: 'station.deliveries', args: {} }, ctx(profile));
    assert.equal(denied.isError, true);
  }
  assert.equal(f.reads(), before); assert.equal(profiles.makeGuard(profiles.resolve('flo-operator-worker')).start('station.deliveries', {}).ok, false);
  const forged = await registry.dispatch({ id: 'forged-read', name: 'station.deliveries', args: { operation_id: 999 } }, ctx());
  assert.equal(forged.isError, true); assert.equal(f.reads(), before);
});

test('Exact delivery reads fail closed for guessed hashes, unknown files, changed bytes, unsupported binary and pause races', async () => {
  const textBytes = Buffer.from('Original buyer README\n');
  const f = fixture(1); f.state.artifacts[0] = { ...f.state.artifacts[0], size: textBytes.length, sha256: digest(textBytes), path: 'README.md' };
  let attempts = 0, raw = textBytes, pause = false;
  const reader = makeFloNativeDeliveries({ context: () => ({ operation_id: 2, run_id: 'host-current-pass' }), snapshot: () => f.state,
    imageWire: makeImageWire({}), artifact: async () => { attempts++; if (pause) f.state.operation.status = 'paused'; return { ...f.state.artifacts[0], bytes: raw }; } });
  const exact = { artifact_id: f.state.artifacts[0].id, sha256: f.state.artifacts[0].sha256 };
  for (const args of [{ ...exact, path: '../../private' }, { ...exact, operation_id: 3 }, { ...exact, url: 'http://127.0.0.1/private' },
    { artifact_id: 'file_README.md', sha256: exact.sha256 }, { ...exact, sha256: 'f'.repeat(64) }, { ...exact, artifact_id: 'f'.repeat(32) }]) {
    await assert.rejects(reader.readFile(args));
  }
  assert.equal(attempts, 0);
  const read = await reader.readFile(exact); assert.match(read.content, /Original buyer README/); assert.match(read.content, /untrusted DATA/);
  assert.equal(read.images, undefined); raw = Buffer.from('Changed buyer README!\n'); await assert.rejects(reader.readFile(exact), /do not match/);
  raw = textBytes; pause = true; await assert.rejects(reader.readFile(exact), /cannot be verified/);
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('ELF\x00binary'), Buffer.alloc(MAX_TEXT_BYTES + 1, 65), Buffer.alloc(MAX_IMAGE_BYTES + 1, 65)]) {
    pause = false; f.state.operation.status = 'running'; raw = bytes;
    f.state.artifacts[0] = { ...f.state.artifacts[0], size: bytes.length, sha256: digest(bytes) };
    await assert.rejects(reader.readFile({ artifact_id: exact.artifact_id, sha256: digest(bytes) }));
  }
  raw = Buffer.from('x'.repeat(1000)); f.state.artifacts[0] = { ...f.state.artifacts[0], size: raw.length, sha256: digest(raw) };
  await assert.rejects(reader.readFile({ artifact_id: exact.artifact_id, sha256: digest(raw) }, { outputMax: 600 }), /tool-result budget/);
});

test('Native worker reviews exact verified PNG pixels while public profiles and forged schema fields remain refused', async () => {
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const f = fixture(1); f.state.artifacts[0] = { ...f.state.artifacts[0], path: 'preview.png', size: pixels.length, sha256: digest(pixels) };
  let attempts = 0; const registry = makeRegistry();
  makeFloNativeDeliveries({ context: () => ({ operation_id: 2, run_id: 'host-current-pass' }), snapshot: () => f.state,
    imageWire: makeImageWire({}), artifact: async () => { attempts++; return { ...f.state.artifacts[0], bytes: pixels }; } }).register(registry);
  const args = { artifact_id: f.state.artifacts[0].id, sha256: f.state.artifacts[0].sha256 };
  const actual = await registry.dispatch({ id: 'actual-worker-preview', name: 'station.delivery_read', args }, ctx('flo-operator-worker'));
  assert.equal(actual.isError, false, actual.content); assert.equal(attempts, 1);
  assert.deepEqual(actual.images, [{ mime: 'image/png', data: pixels.toString('base64') }]);
  assert.ok(!actual.content.includes(pixels.toString('base64')), 'Pixels use the image channel, not textual output.');
  for (const profile of ['flo-research', 'flo-text']) {
    const denied = await registry.dispatch({ id: 'public-refused', name: 'station.delivery_read', args }, ctx(profile)); assert.equal(denied.isError, true);
  }
  const forged = await registry.dispatch({ id: 'forged-path', name: 'station.delivery_read', args: { ...args, path: 'private' } }, ctx('flo-operator-worker'));
  assert.equal(forged.isError, true); assert.equal(attempts, 1);
});

test('Genuine foreground dispatch, sharp exports and durable native capture feed a same-pass commerce proposal with all83 actual file IDs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-deliveries-pipeline-'));
  const jail = path.join(root, 'designer'); fs.mkdirSync(jail);
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'native-deliveries-pipeline-'))); fs.rmSync(root, { recursive: true, force: true }); });
  let serial = 0, operation, proposed = 0, reviewFiles, actualReview = false;
  const verifyArtifact = async (agent, relative, includeBytes) => {
    assert.equal(agent, 'designer'); const bytes = fs.readFileSync(path.join(jail, relative));
    return { sha256: digest(bytes), size: bytes.length, ...(includeBytes ? { bytes } : {}) };
  };
  const operations = makeFloNativeOperations({ fs, path, workspaces: root, writeDurable: writeFileDurable,
    now: () => 1791100000000, newId: () => 'actual-host-' + (++serial), setTimeout: () => ({ unref() {} }), clearTimeout() {},
    workers: () => [{ agent_id: 'designer' }], enroll() {}, verifyArtifact,
    run: async pass => {
      const tools = makeOrchestrationTools({ roster: () => new Map([['designer', { name: 'DESIGNER', model: 'fixture' }], ['reviewer', { name: 'QA REVIEWER', model: 'fixture' }]]),
        model: 'fixture', newId: () => 'actual-child-' + (++serial), dispatchTimeoutMs: 600000,
        runOnce: async child => {
          if (child.agentId === 'reviewer') {
            assert.ok(JSON.stringify(child.messages).includes(reviewFiles[0].id), 'The lead hands exact verified artifact identities to its independent reviewer.');
            const reviewRegistry = makeRegistry(), readCollector = makeArtifactCollector({ maxEntries: 200 });
            makeFloNativeDeliveries({ snapshot: operations.snapshot, context: () => ({ operation_id: pass.operation.id, run_id: pass.runId }),
              artifact: operations.artifact, imageWire: makeImageWire({}) }).register(reviewRegistry);
            const reviewCtx = Object.assign(ctx('flo-operator-worker'), { agentId: 'reviewer', signal: child.signal });
            let turns = 0;
            const provider = { contextLimit: () => 32768, async *stream(request) {
              if (turns++ === 0) {
                for (const [n, file] of reviewFiles.entries()) {
                  yield { type: 'tool_start', index: n, id: 'review-file-' + n, name: 'station.delivery_read' };
                  yield { type: 'tool_args', index: n, chunk: JSON.stringify({ artifact_id: file.id, sha256: file.sha256 }) };
                }
                yield { type: 'done', finishReason: 'tool_calls' };
              } else {
                const textual = request.messages.find(row => row.role === 'tool' && row.content.includes('Original fixture artwork and buyer information.'));
                assert.ok(textual, 'The independent worker sees the producer’s exact rights/README text.');
                const images = request.messages.filter(row => row.role === 'user' && Array.isArray(row.content)).flatMap(row => row.content).filter(part => part.type === 'image_url');
                assert.equal(images.length, 1);
                const raw = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
                assert.equal(digest(raw), reviewFiles[1].sha256, 'The reviewer sees actual producer pixels, not filenames or another model’s description.');
                const input = codex._internals.messagesToInput(request.messages);
                assert.ok(JSON.stringify(input).includes('"type":"input_image"')); assert.ok(JSON.stringify(input).includes(images[0].image_url.url));
                actualReview = true;
                yield { type: 'text', delta: 'I inspected the actual producer text and rendered pixels in this isolated review.' };
                yield { type: 'done', finishReason: 'stop' };
              }
            } };
            const reviewed = await runAgentLoop({ provider, messages: child.messages,
              tools: reviewRegistry.wireFormat(reviewRegistry.list(new Set(['station.delivery_read']))), dispatch: async call => {
                const result = await reviewRegistry.dispatch(call, reviewCtx); readCollector.observe({ toolName: call.name, args: call.args, result }); return result;
              }, capCtx: reviewCtx, toolImages: true, cost: makeCostEngine({ priceOf: () => ({ prompt: 0, completion: 0 }) }),
              emit() {}, agentId: 'reviewer', runId: child.runId, model: 'fixture', isTask: true, limits: { maxIters: 4, grace: false } });
            assert.equal(readCollector.count(), 0, 'Review reads do not masquerade as new products or filesystem effects.');
            const result = { ...reviewed, artifacts: [] }; await pass.recordResult(child.agentId, child.runId, result); return result;
          }
          const registry = makeRegistry(), collector = makeArtifactCollector({ maxEntries: 200 });
          makeFloNativeSvgExport({ root }).register(registry);
          const sources = [];
          for (let n = 0; n < 16; n++) {
            const relative = 'icon-' + n + '.svg', source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" fill="#00aaff"/></svg>';
            fs.writeFileSync(path.join(jail, relative), source); collector.add({ kind: 'file', path: relative });
            sources.push({ path: relative, sha256: digest(source) });
          }
          for (const relative of ['rights.md', 'README.md']) { fs.writeFileSync(path.join(jail, relative), 'Original fixture artwork and buyer information.'); collector.add({ kind: 'file', path: relative }); }
          const workerCtx = Object.assign(ctx('flo-operator-worker'), { agentId: 'designer', signal: child.signal });
          const exported = await registry.dispatch({ id: 'export-real-svg', name: 'asset.export_svg', args: { sources } }, workerCtx);
          assert.equal(exported.isError, false, exported.content); collector.observe({ toolName: 'asset.export_svg', result: exported });
          const childResult = { reason: 'done', messages: [{ role: 'assistant', content: 'Actual original SVGs and rendered PNGs are saved.' }], artifacts: collector.list() };
          await pass.recordResult(child.agentId, child.runId, childResult); return childResult;
        } });
      const dispatched = await tools.dispatchTool.run({ workers: [{ agentId: 'designer', prompt: 'Create original SVGs, PNGs and rights evidence.' }] },
        { agentId: 'agent', runId: pass.runId, signal: pass.signal, outputMax: 8000 });
      const ordinary = JSON.parse(dispatched.content)[0]; assert.equal(ordinary.reason, 'done');
      assert.ok(ordinary.artifacts.every(row => !row.id), 'Ordinary dispatcher rows are file-path observations, not native staging IDs.');
      const deliveries = makeFloNativeDeliveries({ snapshot: operations.snapshot, context: () => ({ operation_id: pass.operation.id, run_id: pass.runId }) });
      const actual = []; let cursor;
      do { const page = deliveries.read(cursor ? { cursor, agent_id: 'designer' } : { agent_id: 'designer' }, { outputMax: 8000 }); actual.push(...page.artifacts); cursor = page.next_cursor; } while (cursor);
      assert.equal(actual.length, 83); assert.equal(operations.snapshot().operation.run_id, pass.runId, 'The parent pass is still running.');
      for (const file of actual) { assert.match(file.id, /^[a-f0-9]{32}$/); const proof = await operations.artifact(pass.operation.id, file.id); assert.equal(digest(proof.bytes), file.sha256); }
      const rights = actual.find(row => row.path === 'rights.md'), buyers = actual.filter(row => row.path.endsWith('.svg') || row.path.endsWith('.png') && !row.path.endsWith('contact-sheet.png'));
      assert.equal(buyers.length, 80);
      reviewFiles = [rights, buyers.find(row => row.path.endsWith('.png'))];
      const reviewed = await tools.dispatchTool.run({ workers: [{ agentId: 'reviewer', prompt: 'Independently inspect these exact producer delivery receipts using station.delivery_read: ' + JSON.stringify(reviewFiles) }] },
        { agentId: 'agent', runId: pass.runId, signal: pass.signal, outputMax: 8000 });
      assert.equal(JSON.parse(reviewed.content)[0].reason, 'done'); assert.equal(actualReview, true);
      const commerce = makeFloNativeCommerce({ key: () => 'fixture-native-delivery-bearer',
        context: () => ({ operation_id: pass.operation.id, run_id: pass.runId, call_id: 'tool-actual-same-pass-stage' }),
        fetch: async (_url, options) => {
          proposed++; const payload = JSON.parse(options.body); assert.deepEqual(payload.artifact_ids, actual.map(row => row.id));
          assert.deepEqual(payload.buyer_artifact_ids, buyers.map(row => row.id)); assert.equal(payload.run_id, pass.runId);
          assert.equal(payload.operation_id, pass.operation.id); assert.equal(payload.evidence.rights.artifact_id, rights.id);
          return new Response(JSON.stringify({ object: 'flo.native.commerce_proposal', schema_version: 1,
            source: { kind: 'saved_local_flo_state', live_store_request: false }, duplicate: false,
            proposal: { id: 1, revision: 'a'.repeat(64), operation_id: payload.operation_id, run_id: payload.run_id,
              channel: payload.channel, intent: payload.intent, target: payload.target, status: 'staged', external_status: 'not_requested' } }));
        } });
      const args = { channel: 'itch', intent: 'package', target: { username: 'fixture-owner', project_slug: 'original-product', channel: 'assets' },
        fields: { title: 'Original fixture icon pack', description: 'Original vectors and four PNG sizes.', price: '3.99', currency: 'GBP', licence: 'Original fixture buyer licence' },
        artifact_ids: actual.map(row => row.id), buyer_artifact_ids: buyers.map(row => row.id), evidence: { rights: { statement: 'Original fixture geometry with saved rights evidence.', artifact_id: rights.id } } };
      assert.equal((await commerce.propose(args)).ok, true); assert.equal(proposed, 1);
      assert.equal((await commerce.propose({ ...args, artifact_ids: ['file_icon-0.svg'] })).ok, false); assert.equal(proposed, 1);
      return { reason: 'done', text: 'Verified original product prepared for owner review; no upload or revenue.', artifacts: [] };
    } });
  t.after(() => operations.close());
  operation = operations.start({ request_id: 'owner-delivery-proof', confirm: true, objective: 'Produce an original reviewable pack.', mode: 'once' });
  assert.equal(operation.ok, true); await operations._pass(operation.operation.id);
  assert.equal(operations.snapshot().operation.status, 'completed'); assert.equal(proposed, 1); assert.equal(operations.snapshot().artifacts.length, 83);
  assert.equal(fs.existsSync(path.join(root, 'reviewer', 'icon-0.svg')), false, 'Review does not copy or alter the designer’s files.');
});
