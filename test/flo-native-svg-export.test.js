'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const sharp = require('sharp');
const { makeFloNativeSvgExport, validateSvg, LIMITS, RENDERER_VERSION, CONTRAST_POLICY } = require('../sidecar/flo-native-svg-export.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const profiles = require('../sidecar/flo-capability-profile.js');
const { makeArtifactCollector } = require('../sidecar/artifacts.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
const { makeFloNativeOperations } = require('../sidecar/flo-native-operations.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const svg = colour => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>Original fixture icon</title><rect x="64" y="64" width="128" height="128" rx="8" fill="${colour || '#ff0000'}"/></svg>`;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-svg-test-')), jail = path.join(root, 'designer'), outside = path.join(root, 'other-worker');
  fs.mkdirSync(jail); fs.mkdirSync(outside); const exporter = makeFloNativeSvgExport({ root, ...options }), registry = makeRegistry(), events = [], ac = new AbortController(); exporter.register(registry);
  const resolved = { agentId: 'designer', room: 'native-room', hasCompute: true, tools: ['asset.svg_info', 'asset.export_svg'], deferred: [], grants: [], approvalRules: {} };
  const ctx = makeCapCtx(profiles.restrict(resolved, profiles.resolve('flo-operator-worker')), {
    agentId: 'designer', room: 'native-room', signal: ac.signal, consent: async () => ({ allow: true, mode: 'once' }),
    emit: (name, value) => events.push({ name, value }) });
  // The host's actual dispatch context supplies identity/emit alongside the
  // capability object; a claimed project scope must never escape this jail.
  Object.assign(ctx, { agentId: 'designer', room: 'native-room', emit: (name, value) => events.push({ name, value }), signal: ac.signal,
    projectRoot: outside, workdir: outside, cwd: outside });
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'native-svg-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (p, content = svg()) => { fs.mkdirSync(path.dirname(path.join(jail, p)), { recursive: true }); fs.writeFileSync(path.join(jail, p), content); return { path: p, sha256: digest(Buffer.from(content)) }; };
  const call = (name, args, extra = {}) => registry.dispatch({ id: name + '-fixture', name, args }, { ...ctx, ...extra });
  return { root, jail, outside, exporter, registry, events, ac, ctx, write, call };
}
const allFiles = root => fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).flatMap(d => d.isDirectory() ? allFiles(path.join(root, d.name)) : [path.join(root, d.name)]) : [];

test('Actual sharp renders a full16-icon pack:64 valid square PNGs plus a genuine contact sheet and durable native artifact receipts', async t => {
  const f = fixture(t), sources = Array.from({ length: 16 }, (_, n) => f.write('original/icon-' + n + '.svg', svg(n % 2 ? '#00ff00' : '#ff0000')));
  const info = await f.call('asset.svg_info', { paths: sources.map(s => s.path) }); assert.equal(info.isError, false, info.content);
  assert.deepEqual(JSON.parse(info.content).sources.map(({ path, sha256 }) => ({ path, sha256 })), sources);
  const result = await f.call('asset.export_svg', { sources }, { outputMax: 8000 }); assert.equal(result.isError, false, result.content);
  const receipt = result.mutationReceipt; assert.equal(receipt.state, 'read-back-verified'); assert.equal(receipt.files.length, 65); assert.equal(f.events.length, 65);
  for (const file of receipt.files) {
    const bytes = fs.readFileSync(path.join(f.jail, file.path)); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(digest(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes); assert.equal(fs.statSync(path.join(f.jail, file.path)).mode & 0o777, 0o600);
    const meta = await sharp(bytes).metadata(); assert.equal(meta.width, file.width); assert.equal(meta.height, file.height); assert.equal(meta.format, 'png');
    if (!file.path.endsWith('contact-sheet.png')) {
      assert.ok([32, 64, 128, 256].includes(meta.width)); assert.equal(meta.width, meta.height);
      const { data, info: pixels } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); assert.equal(data[3], 0, 'The corner is transparent.');
      assert.ok(data[(Math.floor(meta.height / 2) * meta.width + Math.floor(meta.width / 2)) * pixels.channels + 3] > 0, 'Actual artwork pixels were rendered.');
    } else { assert.equal(meta.width, 592); assert.equal(meta.height, 592); }
  }
  assert.ok(f.events.every(e => e.name === 'deliverable' && e.value.agentId === 'designer' && e.value.room === 'native-room' && receipt.files.some(file => file.path === e.value.title)));
  assert.equal(allFiles(f.outside).length, 0, 'A claimed projectRoot cannot redirect output.');
  const execution = makeRunExecutionState({ artifacts: makeArtifactCollector({ maxEntries: 200 }) });
  execution.observeArtifact({ toolName: 'asset.export_svg', args: { sources }, result }); assert.equal(execution.artifactList().length, 65, 'The full native pack survives actual output truncation.');
  const ordinary = makeArtifactCollector(); ordinary.observe({ toolName: 'asset.export_svg', result }); assert.equal(ordinary.count(), 50, 'Ordinary collector bounds remain unchanged.');
  const verifyArtifact = async (agent, relative, includeBytes) => { assert.equal(agent, 'designer'); const bytes = fs.readFileSync(path.join(f.root, agent, relative)); return { sha256: digest(bytes), size: bytes.length, ...(includeBytes ? { bytes } : {}) }; };
  const deps = { fs, path, workspaces: f.root, writeDurable: writeFileDurable, now: () => 1791100000000, setTimeout: () => ({ unref() {} }), clearTimeout() {},
    newId: () => 'isolated-run', workers: () => [{ agent_id: 'agent' }, { agent_id: 'designer' }], enroll() {}, run: async () => { throw Error('No provider in this artifact capture fixture'); }, verifyArtifact };
  const operations = makeFloNativeOperations(deps); t.after(() => operations.close());
  const op = operations.start({ request_id: 'isolated-svg-operation', confirm: true, objective: 'Verify an original icon export', mode: 'once' }); assert.equal(op.ok, true);
  await operations.recordResult(op.operation.id, 'designer', 'actual-export-fixture-run', { reason: 'done', artifacts: execution.artifactList() });
  assert.equal(operations.snapshot().artifacts.length, 65, 'The real durable operation retains artifacts beyond its former50-item limit.'); operations.close();
  const reopened = makeFloNativeOperations(deps); t.after(() => reopened.close()); assert.equal(reopened.snapshot().artifacts.length, 65);
  for (const item of reopened.snapshot().artifacts) { const delivered = await reopened.artifact(op.operation.id, item.id); assert.equal(digest(delivered.bytes), item.sha256); }
});

test('Local gradients/clipping work; unsupported resource/processing/CSS/filter/text graphs never reach sharp', async t => {
  const f = fixture(t); const local = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop offset="0%" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/></linearGradient><clipPath id="c"><circle cx="32" cy="32" r="20"/></clipPath></defs><g clip-path="url(#c)"><rect width="64" height="64" fill="url(#g)"/></g></svg>';
  const result = await f.call('asset.export_svg', { sources: [f.write('gradient.svg', local)], sizes: [64], contact_sheet: false }); assert.equal(result.isError, false, result.content);
  assert.equal(result.mutationReceipt.files.length, 1);
  const bad = [
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1">&x;</svg>',
    '<?xml version="1.0"?><svg viewBox="0 0 1 1"/>', '<svg viewBox="0 0 1 1"><script>bad()</script></svg>',
    '<svg viewBox="0 0 1 1"><foreignObject/></svg>', '<svg viewBox="0 0 1 1"><image href="https://example.org/a.png"/></svg>',
    '<svg viewBox="0 0 1 1"><image href="data:image/svg+xml,bad"/></svg>', '<svg viewBox="0 0 1 1"><use xlink:href="file:///etc/passwd"/></svg>',
    '<svg viewBox="0 0 1 1"><style>@import "https://example.org/style";</style></svg>', '<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.org/a)"/></svg>',
    '<svg viewBox="0 0 1 1"><rect fill="url(file:///etc/passwd)"/></svg>', '<svg viewBox="0 0 1 1" onload="bad()"/>',
    '<svg viewBox="0 0 1 1"><filter id="f"><feTurbulence/></filter></svg>', '<svg viewBox="0 0 1 1"><text>font</text></svg>',
    '<svg width="10000000" height="10000000"/>', '<svg viewBox="0 0 99999999 99999999"/>', '<svg viewBox="0 0 1 1"><rect fill="url(#missing)"/></svg>',
    '<svg viewBox="0 0 1 1"><g></svg>', '<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>',
    '<svg viewBox="0 0 1 1"><g>' + '<circle r="1"/>'.repeat(LIMITS.nodes + 1) + '</g></svg>'
  ];
  let renders = 0; const locked = makeFloNativeSvgExport({ root: f.root, sharp: () => { renders++; throw Error('Unsafe input reached renderer'); } });
  const before = allFiles(path.join(f.jail, 'exports')).length;
  for (let n = 0; n < bad.length; n++) { const source = f.write('bad-' + n + '.svg', bad[n]); await assert.rejects(locked.exportSvg({ sources: [source] }, f.ctx)); }
  assert.equal(renders, 0); assert.equal(allFiles(path.join(f.jail, 'exports')).length, before);
  assert.throws(() => validateSvg(Buffer.from([0xff, 0xfe, 0x00]))); assert.throws(() => validateSvg(Buffer.alloc(LIMITS.source_bytes + 1, 32)));
});

test('Contact sheets choose actual readable contrast for black/white artwork, preserve transparent PNGs and retain old version bundles', async t => {
  const f = fixture(t);
  for (const [name, colour, expectedBackground] of [['black', '#000000', '#f2f4f8'], ['white', '#ffffff', '#181c26']]) {
    const source = f.write(name + '.svg', svg(colour)), original = fs.readFileSync(path.join(f.jail, source.path));
    const transparent = await sharp(original, { density: 72 }).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    // Real prior-policy pixels under its genuine version-one key establish
    // that a contrast upgrade neither conflicts with nor replaces old files.
    const oldKey = digest(Buffer.from(JSON.stringify({ sources: [{ path: source.path, sha256: source.sha256, bytes: original.length }], sizes: [256], contact_sheet: true }))).slice(0, 24);
    const oldFolder = path.join(f.jail, 'exports/svg-' + oldKey); fs.mkdirSync(oldFolder, { recursive: true });
    const oldSheet = await sharp({ create: { width: 160, height: 160, channels: 4, background: { r: 24, g: 28, b: 38, alpha: 1 } } })
      .composite([{ input: await sharp(transparent).resize(128, 128).png().toBuffer(), left: 16, top: 16 }]).png().toBuffer();
    fs.writeFileSync(path.join(oldFolder, 'contact-sheet.png'), oldSheet);
    const result = await f.call('asset.export_svg', { sources: [source], sizes: [256] }); assert.equal(result.isError, false, result.content);
    const receipt = result.mutationReceipt; assert.equal(receipt.renderer_version, RENDERER_VERSION); assert.equal(receipt.contact_sheet.contrast_policy, CONTRAST_POLICY);
    assert.equal(receipt.contact_sheet.background, expectedBackground); assert.equal(receipt.contact_sheet.sample_size, 64); assert.equal(receipt.contact_sheet.sampled_images, 1);
    assert.notEqual(receipt.bundle, 'exports/svg-' + oldKey); assert.deepEqual(fs.readFileSync(path.join(oldFolder, 'contact-sheet.png')), oldSheet);
    const png = receipt.files.find(file => file.path.endsWith('-256.png')), sheet = receipt.files.find(file => file.path.endsWith('contact-sheet.png'));
    assert.deepEqual(fs.readFileSync(path.join(f.jail, png.path)), transparent, 'Changing sheet contrast must not recolour/flatten transparent buyer artwork.');
    const { data, info } = await sharp(fs.readFileSync(path.join(f.jail, sheet.path))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = [...data.subarray(0, 4)], at = (80 * info.width + 80) * 4, foreground = [...data.subarray(at, at + 4)];
    assert.deepEqual(background, name === 'black' ? [242, 244, 248, 255] : [24, 28, 38, 255]);
    assert.deepEqual(foreground, name === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const lum = pixel => 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]; assert.ok(Math.abs(lum(background) - lum(foreground)) > 200, 'Real sheet pixels provide visible monochrome contrast.');
  }
});

test('The exporter refuses stale hashes, source changes during rendering, oversized requests and arbitrary output authority before PNG writes', async t => {
  const f = fixture(t), source = f.write('icon.svg'); f.write('icon.svg', svg('#0000ff'));
  const stale = await f.call('asset.export_svg', { sources: [source] }); assert.equal(stale.isError, true); assert.match(stale.content, /changed since its hash/);
  const actual = f.write('icon.svg'); let changed = false;
  const changing = makeFloNativeSvgExport({ root: f.root, sharp: (...args) => { if (Buffer.isBuffer(args[0]) && !changed) { changed = true; f.write('icon.svg', svg('#00ff00')); } return sharp(...args); } });
  await assert.rejects(changing.exportSvg({ sources: [actual] }, f.ctx), /changed during rendering/); assert.equal(allFiles(path.join(f.jail, 'exports')).length, 0);
  for (const args of [{ sources: Array(17).fill(actual) }, { sources: [actual], sizes: [512] }, { sources: [actual], sizes: [32, 32] },
    { sources: [actual], output_dir: f.outside }, { sources: [{ ...actual, agentId: 'other-worker' }] }, { sources: [actual], contact_sheet: 'yes' }]) {
    const denied = await f.call('asset.export_svg', args); assert.equal(denied.isError, true);
  }
  assert.equal(allFiles(path.join(f.jail, 'exports')).length, 0);
});

test('Own-agent jail denies traversal, absolute/Windows paths, source/output symlinks, hardlinks and reserved credential identities', async t => {
  const f = fixture(t), source = f.write('icon.svg'); fs.writeFileSync(path.join(f.outside, 'original.svg'), svg());
  for (const relative of ['../other-worker/original.svg', '/etc/passwd.svg', 'C:\\private.svg', 'nested/../../original.svg', 'a//b.svg']) {
    const denied = await f.call('asset.svg_info', { paths: [relative] }); assert.equal(denied.isError, true);
  }
  fs.symlinkSync(path.join(f.outside, 'original.svg'), path.join(f.jail, 'linked.svg'));
  assert.equal((await f.call('asset.svg_info', { paths: ['linked.svg'] })).isError, true);
  fs.symlinkSync(f.outside, path.join(f.jail, 'linked-directory'));
  assert.equal((await f.call('asset.svg_info', { paths: ['linked-directory/original.svg'] })).isError, true);
  fs.linkSync(path.join(f.outside, 'original.svg'), path.join(f.jail, 'hardlinked.svg'));
  assert.equal((await f.call('asset.svg_info', { paths: ['hardlinked.svg'] })).isError, true);
  fs.symlinkSync(f.outside, path.join(f.jail, 'exports'));
  assert.equal((await f.call('asset.export_svg', { sources: [source] })).isError, true);
  for (const agentId of ['codex', 'connectors', 'CODEX', '../designer']) assert.equal((await f.call('asset.svg_info', { paths: ['icon.svg'] }, { agentId })).isError, true);
  assert.deepEqual(fs.readdirSync(f.outside), ['original.svg'], 'The target jail and credentials were not written.');
});

test('Exact export replay is read-back verified; owner-modified existing PNGs are preserved and refuse the entire bundle', async t => {
  const f = fixture(t), sources = [f.write('icon.svg')], first = await f.call('asset.export_svg', { sources }); assert.equal(first.isError, false, first.content);
  const file = first.mutationReceipt.files[0], stat = fs.statSync(path.join(f.jail, file.path)), duplicate = await f.call('asset.export_svg', { sources });
  assert.equal(duplicate.isError, false); assert.ok(duplicate.mutationReceipt.files.every(file => file.replayed)); assert.equal(fs.statSync(path.join(f.jail, file.path)).mtimeMs, stat.mtimeMs);
  const edited = Buffer.from('Owner-managed edited bytes'); fs.writeFileSync(path.join(f.jail, file.path), edited);
  const refusal = await f.call('asset.export_svg', { sources }); assert.equal(refusal.isError, true); assert.match(refusal.content, /existing export differs/);
  assert.deepEqual(fs.readFileSync(path.join(f.jail, file.path)), edited); assert.equal(refusal.mutationReceipt.files.length, 0);
  const revision = f.write('icon.svg', svg('#0000ff')), fresh = await f.call('asset.export_svg', { sources: [revision] }); assert.equal(fresh.isError, false);
  assert.notEqual(fresh.mutationReceipt.bundle, first.mutationReceipt.bundle); assert.deepEqual(fs.readFileSync(path.join(f.jail, file.path)), edited);
});

test('Cancellation before rendering creates nothing; pause between writes stops further file effects and keeps only actual verified receipts', async t => {
  const f = fixture(t), sources = [f.write('icon.svg')]; f.ac.abort();
  const before = await f.call('asset.export_svg', { sources }); assert.equal(before.isError, true); assert.equal(allFiles(path.join(f.jail, 'exports')).length, 0);
  const ac = new AbortController(), events = [];
  const paused = await f.call('asset.export_svg', { sources }, { signal: ac.signal, emit: (name, value) => { events.push({ name, value }); ac.abort(); } });
  assert.equal(paused.isError, true); assert.equal(paused.mutationReceipt.state, 'partially-applied'); assert.equal(paused.mutationReceipt.files.length, 1);
  assert.equal(allFiles(path.join(f.jail, 'exports')).length, 1); assert.equal(events.length, 1); assert.equal(paused.effectUnknown, undefined, 'Settled verified file effects are known.');
  const collector = makeArtifactCollector({ maxEntries: 200 }); collector.observe({ toolName: 'asset.export_svg', result: paused }); assert.equal(collector.count(), 1);
  const resumed = await f.call('asset.export_svg', { sources }, { signal: new AbortController().signal }); assert.equal(resumed.isError, false); assert.equal(resumed.mutationReceipt.files.length, 5);
  assert.equal(resumed.mutationReceipt.files.filter(file => file.replayed).length, 1);
});

test('An injected actual binary write failure reports uncertainty and preserves earlier proven files through the genuine registry/artifact collector', async t => {
  const f = fixture(t), source = f.write('icon.svg'); let writes = 0;
  const faulty = Object.create(fs.promises); faulty.open = async (file, flags, mode) => { const fd = await fs.promises.open(file, flags, mode);
    if (flags & fs.constants.O_WRONLY && ++writes === 2) { fd.writeFile = async bytes => { await fd.write(bytes.subarray(0, 20)); throw Error('Injected private binary IO failure'); }; }
    return fd; };
  const exporter = makeFloNativeSvgExport({ root: f.root, fsp: faulty }), registry = makeRegistry(); exporter.register(registry);
  const result = await registry.dispatch({ id: 'faulted-write', name: 'asset.export_svg', args: { sources: [source] } }, f.ctx);
  assert.equal(result.isError, true); assert.equal(result.effectUnknown, true); assert.equal(result.mutationReceipt.state, 'partially-applied'); assert.equal(result.mutationReceipt.files.length, 1);
  assert.ok(!result.content.includes('Injected private')); assert.ok(!result.content.includes(f.root)); assert.equal(allFiles(path.join(f.jail, 'exports')).length, 2);
  const collector = makeArtifactCollector({ maxEntries: 200 }); collector.observe({ toolName: 'asset.export_svg', result }); assert.deepEqual(collector.list().map(file => file.path), [result.mutationReceipt.files[0].path]);
  // Requested/fake paths and a write that never passed read-back remain absent.
  const unproven = makeArtifactCollector(); unproven.observe({ toolName: 'asset.export_svg', result: { ok: true, mutationReceipt: { object: 'starnet.svg_export', operation: 'asset.export_svg', files: [
    { path: '../../private.png', state: 'read-back-verified', bytes: 1, sha256: 'a'.repeat(64) }, { ...result.mutationReceipt.files[0], state: 'written' } ] } } }); assert.equal(unproven.count(), 0);
});

test('A changed output inode/link cannot be accepted as an identical export, and no public profile receives local production authority', async t => {
  const f = fixture(t), sources = [f.write('icon.svg')], first = await f.call('asset.export_svg', { sources }); assert.equal(first.isError, false);
  const output = first.mutationReceipt.files[0], localPath = path.join(f.jail, output.path); fs.renameSync(localPath, path.join(f.outside, 'borrowed.png')); fs.symlinkSync(path.join(f.outside, 'borrowed.png'), localPath);
  const denied = await f.call('asset.export_svg', { sources }); assert.equal(denied.isError, true); assert.equal(denied.mutationReceipt.files.length, 0);
  const publicCtx = makeCapCtx(profiles.restrict({ agentId: 'designer', hasCompute: true, tools: ['asset.svg_info', 'asset.export_svg'], grants: [], approvalRules: {} }, profiles.resolve('flo-research')),
    { consent: async () => ({ allow: true, mode: 'once' }) });
  const gated = await f.registry.dispatch({ id: 'public-flag', name: 'asset.export_svg', args: { sources } }, { ...publicCtx, agentId: 'designer' }); assert.equal(gated.isError, true);
});
