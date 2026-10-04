'use strict';

// A native, local production tool, not a general image/terminal adapter. Only
// bounded geometry SVGs from this caller's jail reach sharp; original bytes,
// deterministic create-only PNGs and their read-back hashes remain auditable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { assertWorkspaceId } = require('./workspace-reserved.js');
const SIZES = Object.freeze([32, 64, 128, 256]);
const LIMITS = Object.freeze({ sources: 16, source_bytes: 128 * 1024, total_source_bytes: 1024 * 1024,
  output_bytes: 16 * 1024 * 1024, nodes: 2048, dimension: 4096, path_chars: 32768 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { const e = new Error(message); e.toolSummary = 'svg-export-refused'; throw e; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const attributes = Object.freeze({
  svg: ['xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio'], g: [],
  path: ['d', 'pathLength'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'],
  defs: [], linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  stop: ['offset', 'stop-color', 'stop-opacity'], clipPath: ['clipPathUnits'], title: [], desc: []
});
const common = new Set(['id', 'fill', 'stroke', 'color', 'fill-opacity', 'stroke-opacity', 'opacity', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule',
  'clip-rule', 'clip-path', 'transform', 'vector-effect']);
const numeric = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height',
  'stroke-width', 'stroke-miterlimit', 'stroke-dashoffset', 'pathLength', 'offset']);
const enums = { 'stroke-linecap': ['butt', 'round', 'square'], 'stroke-linejoin': ['miter', 'round', 'bevel'],
  'fill-rule': ['nonzero', 'evenodd'], 'clip-rule': ['nonzero', 'evenodd'], 'vector-effect': ['none', 'non-scaling-stroke'],
  gradientUnits: ['objectBoundingBox', 'userSpaceOnUse'], clipPathUnits: ['objectBoundingBox', 'userSpaceOnUse'], spreadMethod: ['pad', 'reflect', 'repeat'] };
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numberRx = new RegExp('^(' + NUMBER + ')(px|%)?$');
function numbers(value) {
  const parts = String(value).trim().split(/[\s,]+/);
  if (!parts.length || parts.some(p => !new RegExp('^' + NUMBER + '$').test(p) || !Number.isFinite(Number(p)) || Math.abs(Number(p)) > 1000000)) fail('SVG coordinates exceed the supported bounds.');
  return parts.map(Number);
}
function paint(value) {
  return /^(?:none|currentColor|transparent|black|white|red|green|blue|yellow|orange|purple|pink|grey|gray|silver|navy|teal|aqua|lime|maroon|olive|fuchsia|#[a-fA-F0-9]{3,8}|rgb\(\s*[\d.,%\s]+\)|rgba\(\s*[\d.,%\s]+\)|url\(#[A-Za-z][A-Za-z0-9_-]{0,79}\))$/.test(value);
}
function validateAttribute(tag, name, value) {
  if (!(attributes[tag].includes(name) || common.has(name)) || value.length > LIMITS.path_chars) fail('SVG contains an unsupported attribute.');
  if (name === 'xmlns') { if (tag !== 'svg' || value !== 'http://www.w3.org/2000/svg') fail('SVG namespace is unsupported.'); return; }
  if (name === 'id') { if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value)) fail('SVG identifiers are unsupported.'); return; }
  if (['fill', 'stroke', 'color', 'stop-color'].includes(name)) { if (!paint(value)) fail('SVG paints must be local solid colours or local gradients.'); return; }
  if (name === 'clip-path') { if (!/^(?:none|url\(#[A-Za-z][A-Za-z0-9_-]{0,79}\))$/.test(value)) fail('SVG clipping must reference a local definition.'); return; }
  if (['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(name)) {
    if (!new RegExp('^' + NUMBER + '$').test(value) || Number(value) < 0 || Number(value) > 1) fail('SVG opacity must be between zero and one.'); return;
  }
  if (numeric.has(name)) {
    const m = numberRx.exec(value); if (!m || !Number.isFinite(Number(m[1])) || Math.abs(Number(m[1])) > 1000000) fail('SVG numbers exceed the supported bounds.');
    if (['width', 'height', 'r', 'rx', 'ry', 'fr', 'stroke-width'].includes(name) && Number(m[1]) < 0) fail('SVG geometry cannot have negative dimensions.');
    if (tag === 'svg' && ['width', 'height'].includes(name) && (m[2] === '%' || Number(m[1]) <= 0 || Number(m[1]) > LIMITS.dimension)) fail('SVG root dimensions exceed the supported bounds.');
    return;
  }
  if (name === 'viewBox') { const ns = numbers(value); if (ns.length !== 4 || ns[2] <= 0 || ns[3] <= 0 || ns[2] > LIMITS.dimension || ns[3] > LIMITS.dimension) fail('SVG viewBox exceeds the supported dimensions.'); return; }
  if (['points', 'stroke-dasharray'].includes(name)) { if (name === 'stroke-dasharray' && value === 'none') return; const ns = numbers(value); if (ns.length > 8192 || name === 'points' && ns.length % 2) fail('SVG coordinate list is unsupported.'); return; }
  if (name === 'd') {
    if (!value || !/^[MmZzLlHhVvCcSsQqTtAa\d.,\s+eE-]+$/.test(value)) fail('SVG path data is unsupported.');
    const ns = value.match(new RegExp(NUMBER, 'g')) || []; if (ns.length > 8192 || ns.some(v => !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1000000)) fail('SVG path data exceeds supported bounds.'); return;
  }
  if (name === 'transform' || name === 'gradientTransform') {
    if (value.length > 1024) fail('SVG transform exceeds supported bounds.');
    let rest = value.trim(), count = 0;
    while (rest) { const m = /^(matrix|translate|scale|rotate|skewX|skewY)\(\s*([^()]*)\)\s*/.exec(rest); if (!m || ++count > 16) fail('SVG transform is unsupported.');
      const ns = numbers(m[2]), permitted = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] }[m[1]];
      if (!permitted.includes(ns.length)) fail('SVG transform arguments are unsupported.'); rest = rest.slice(m[0].length); }
    return;
  }
  if (enums[name]) { if (!enums[name].includes(value)) fail('SVG attribute value is unsupported.'); return; }
  if (name === 'preserveAspectRatio') { if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) fail('SVG aspect ratio is unsupported.'); return; }
  if (name === 'version' && ['1.0', '1.1'].includes(value)) return;
  fail('SVG attribute value is unsupported.');
}
function validateSvg(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.source_bytes) fail('SVG source exceeds the byte allowance.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { fail('SVG source must be valid UTF-8.'); }
  // No entity processing, XML instructions, CSS, embedded resources or fetch
  // syntax enters librsvg. The permitted local paint/clip URLs are validated
  // separately; every other tag and attribute is refused rather than stripped.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f&]/.test(text) || /<\?|<!\s*(?:DOCTYPE|ENTITY)|@import/i.test(text)) fail('SVG entities and XML processing instructions are not supported.');
  const stack = [], ids = new Set(), refs = [], root = {}; let offset = 0, nodes = 0, closed = false;
  while (offset < text.length) {
    if (text.startsWith('<!--', offset)) { const end = text.indexOf('-->', offset + 4); if (end < 0 || text.slice(offset + 4, end).includes('--')) fail('SVG comments are malformed.'); offset = end + 3; continue; }
    if (text[offset] !== '<') { const end = text.indexOf('<', offset), stop = end < 0 ? text.length : end, body = text.slice(offset, stop);
      if (body.trim() && !['title', 'desc'].includes(stack.at(-1))) fail('SVG text/font rendering is outside this exporter.'); offset = stop; continue; }
    const end = text.indexOf('>', offset + 1); if (end < 0) fail('SVG markup is malformed.');
    const token = text.slice(offset + 1, end); offset = end + 1;
    if (token.startsWith('/')) { const m = /^\/([A-Za-z][A-Za-z0-9]*)\s*$/.exec(token); if (!m || stack.pop() !== m[1]) fail('SVG element nesting is malformed.'); if (!stack.length) closed = true; continue; }
    const m = /^([A-Za-z][A-Za-z0-9]*)([\s\S]*?)\s*(\/?)$/.exec(token);
    if (!m || !Object.hasOwn(attributes, m[1]) || ++nodes > LIMITS.nodes || closed || stack.length > 32) fail('SVG contains an unsupported element or exceeds the geometry allowance.');
    const tag = m[1]; if ((!stack.length && (tag !== 'svg' || nodes !== 1)) || (stack.length && tag === 'svg') || ['title', 'desc'].includes(stack.at(-1))) fail('SVG must have one simple root.');
    let rest = m[2]; const seen = new Set();
    while (rest.trim()) {
      const a = /^\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(rest); if (!a || seen.has(a[1])) fail('SVG attributes are malformed or duplicated.');
      const name = a[1], value = a[2] === undefined ? a[3] : a[2]; seen.add(name); validateAttribute(tag, name, value);
      if (name === 'id') { if (ids.has(value)) fail('SVG identifiers must be unique.'); ids.add(value); }
      const ref = /^url\(#([^)]*)\)$/.exec(value); if (ref) refs.push(ref[1]);
      if (!stack.length) root[name] = value; rest = rest.slice(a[0].length);
    }
    if (!m[3]) stack.push(tag); else if (!stack.length) closed = true;
  }
  if (!closed || stack.length || !nodes || !root.viewBox && !(root.width && root.height) || refs.some(id => !ids.has(id))) fail('SVG dimensions, nesting or local references are incomplete.');
  return { bytes: bytes.length, sha256: hash(bytes), nodes };
}

function makeFloNativeSvgExport(options) {
  const d = options || {}, io = d.fsp || fs.promises, root = path.resolve(d.root || '.'), sharp = d.sharp || require('sharp');
  const abort = ctx => { if (ctx && ctx.signal && ctx.signal.aborted) { const e = new Error('SVG export cancelled; inspect its verified file receipts before resuming.'); e.toolSummary = 'cancelled'; e.cancelled = true; throw e; } };
  function relative(value) { if (typeof value !== 'string' || !value || value.length > 180 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || !/^[A-Za-z0-9_. /-]+$/.test(value)
      || value.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith(' ') || p.endsWith('.'))) fail('Use a plain workspace-relative SVG path.'); return value; }
  async function directory(base, parts, create) {
    let at = base;
    for (const part of parts) { at = path.join(at, part); if (create) { try { await io.mkdir(at, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const st = await io.lstat(at); if (st.isSymbolicLink() || !st.isDirectory()) fail('SVG source/export directory must be a real jailed directory.');
      const real = await io.realpath(at); if (real !== at) fail('SVG source/export paths cannot traverse symbolic links.'); }
    return at;
  }
  async function jail(ctx) {
    const aid = ctx && ctx.agentId; if (typeof aid !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(aid)) fail('SVG tools require the actual host worker identity.'); assertWorkspaceId(aid);
    const rootStat = await io.lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await io.realpath(root) !== root) fail('SVG workspace root must be a real directory.');
    return { aid, base: await directory(root, [aid], false) };
  }
  async function read(base, relativePath, limit) {
    const segments = relativePath.split('/'); await directory(base, segments.slice(0, -1), false);
    const file = path.join(base, ...segments), ls = await io.lstat(file); if (ls.isSymbolicLink() || !ls.isFile() || ls.nlink !== 1 || ls.size > limit) fail('SVG input/output must be a bounded regular file without links.');
    const fd = await io.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const before = await fd.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.ino !== ls.ino || before.dev !== ls.dev) fail('SVG file changed during validation.');
      // A file growing after stat cannot turn readFile into an unbounded
      // allocation. Read only the proven size plus one growth-detection byte.
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
      const bytes = buffer.subarray(0, length), after = await fd.stat(); if (bytes.length > limit || before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('SVG file changed during validation.'); return bytes;
    } finally { await fd.close(); }
  }
  async function inspect(args, ctx) {
    try {
      abort(ctx); if (!plain(args) || Object.keys(args).some(k => k !== 'paths') || !Array.isArray(args.paths) || !args.paths.length || args.paths.length > LIMITS.sources) fail('Inspect one to sixteen SVG paths.');
      const { base } = await jail(ctx), sources = []; let total = 0;
      for (const raw of args.paths) { abort(ctx); const p = relative(raw); if (!/\.svg$/i.test(p) || sources.some(s => s.path === p)) fail('Inspect distinct SVG files.'); const bytes = await read(base, p, LIMITS.source_bytes); total += bytes.length;
        if (total > LIMITS.total_source_bytes) fail('SVG inputs exceed the shared byte allowance.'); sources.push({ path: p, ...validateSvg(bytes) }); }
      return { content: JSON.stringify({ object: 'starnet.svg_sources', sources, sizes: SIZES, limits: LIMITS }), summary: sources.length + ' jailed SVG sources validated and hashed' };
    } catch (e) { if (e.toolSummary) throw e; fail('SVG source is unavailable or could not be safely validated in this worker workspace.'); }
  }
  async function exportSvg(args, ctx) {
    const receipt = { object: 'starnet.svg_export', version: 1, operation: 'asset.export_svg', state: 'attempted', sources: [], files: [] }; let activeWrite = false;
    try {
      abort(ctx); if (!plain(args) || Object.keys(args).some(k => !['sources', 'sizes', 'contact_sheet'].includes(k)) || !Array.isArray(args.sources) || !args.sources.length || args.sources.length > LIMITS.sources
        || args.contact_sheet !== undefined && typeof args.contact_sheet !== 'boolean') fail('Export one to sixteen hashed SVG sources with fixed PNG sizes.');
      const sizes = args.sizes === undefined ? SIZES.slice() : args.sizes;
      if (!Array.isArray(sizes) || !sizes.length || sizes.length > 4 || new Set(sizes).size !== sizes.length || sizes.some(s => !SIZES.includes(s))) fail('PNG sizes must be a subset of 32, 64, 128 and 256.');
      const selectedSizes = sizes.slice().sort((a, b) => a - b), contact = args.contact_sheet !== false, { aid, base } = await jail(ctx), inputs = [];
      let inputBytes = 0;
      for (const spec of args.sources) { abort(ctx); if (!plain(spec) || Object.keys(spec).some(k => !['path', 'sha256'].includes(k)) || !/^[a-f0-9]{64}$/.test(spec.sha256 || '')) fail('Use actual source SHA256s from asset.svg_info or a file write receipt.');
        const p = relative(spec.path); if (!/\.svg$/i.test(p) || inputs.some(s => s.path === p)) fail('Export distinct SVG files.'); const bytes = await read(base, p, LIMITS.source_bytes), info = validateSvg(bytes);
        if (info.sha256 !== spec.sha256) fail('SVG input changed since its hash receipt; inspect it again before exporting.'); inputBytes += bytes.length;
        if (inputBytes > LIMITS.total_source_bytes) fail('SVG inputs exceed the shared byte allowance.'); inputs.push({ ...info, path: p, bytes }); }
      receipt.sources = inputs.map(({ path: p, sha256, bytes }) => ({ path: p, sha256, bytes: bytes.length }));
      const key = hash(Buffer.from(JSON.stringify({ sources: receipt.sources, sizes: selectedSizes, contact_sheet: contact }))).slice(0, 24), folder = 'exports/svg-' + key;
      const outputs = [], tiles = []; let outputBytes = 0;
      for (let n = 0; n < inputs.length; n++) {
        abort(ctx); const input = inputs[n], slug = path.basename(input.path, path.extname(input.path)).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'icon';
        // Render once at the largest admitted icon size. Smaller PNGs derive
        // from these exact pixels; no fonts, resources or provider are loaded.
        const largest = await sharp(input.bytes, { limitInputPixels: LIMITS.dimension * LIMITS.dimension, density: 72, failOn: 'error' })
          .timeout({ seconds: 5 }).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        abort(ctx); tiles.push(largest);
        for (const size of selectedSizes) { const bytes = size === 256 ? largest : await sharp(largest).resize(size, size).png().toBuffer();
          const item = { path: folder + '/' + String(n + 1).padStart(2, '0') + '-' + slug + '-' + size + '.png', bytes, width: size, height: size, source_sha256: input.sha256 };
          outputs.push(item); outputBytes += bytes.length; }
      }
      if (contact) {
        abort(ctx); const columns = Math.min(4, inputs.length), rows = Math.ceil(inputs.length / columns), cell = 128, gap = 16, width = columns * cell + (columns + 1) * gap, height = rows * cell + (rows + 1) * gap;
        const composite = []; for (let n = 0; n < tiles.length; n++) composite.push({ input: await sharp(tiles[n]).resize(cell, cell).png().toBuffer(), left: gap + (n % columns) * (cell + gap), top: gap + Math.floor(n / columns) * (cell + gap) });
        const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 24, g: 28, b: 38, alpha: 1 } } }).composite(composite).png().toBuffer();
        outputs.push({ path: folder + '/contact-sheet.png', bytes, width, height }); outputBytes += bytes.length;
      }
      if (outputBytes > LIMITS.output_bytes || outputs.some(o => o.bytes.length > 8 * 1024 * 1024)) fail('PNG outputs exceed the bounded artifact allowance.');
      // Revalidate all source snapshots before any file effect, and preflight
      // the entire output set so a conflicting owner edit is never overwritten.
      for (const input of inputs) { abort(ctx); if (hash(await read(base, input.path, LIMITS.source_bytes)) !== input.sha256) fail('SVG input changed during rendering; no PNG files were written.'); }
      await directory(base, folder.split('/'), true);
      for (const output of outputs) { abort(ctx); try { const prior = await read(base, output.path, LIMITS.output_bytes); if (!prior.equals(output.bytes)) fail('An existing export differs; preserve it and export a revised SVG into a new bundle.'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; } }
      if (ctx && typeof ctx.checkpointMutation === 'function') await ctx.checkpointMutation(base, 'jailed SVG export', { resolvedRoot: true });
      for (const output of outputs) {
        abort(ctx); await directory(base, folder.split('/'), false); let fd, replayed = false;
        try { fd = await io.open(path.join(base, output.path), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          activeWrite = true; await fd.writeFile(output.bytes); await fd.sync(); await fd.close(); fd = null;
        } catch (e) { if (fd) { try { await fd.close(); } catch (_) {} } if (e.code !== 'EEXIST') throw e; replayed = true; }
        const bytes = await read(base, output.path, LIMITS.output_bytes); if (!bytes.equals(output.bytes)) fail('PNG read-back failed; inspect the retained export before retrying.'); activeWrite = false;
        const file = { kind: 'file', path: output.path, bytes: bytes.length, sha256: hash(bytes), width: output.width, height: output.height,
          state: 'read-back-verified', replayed }; if (output.source_sha256) file.source_sha256 = output.source_sha256; receipt.files.push(file);
        if (ctx && typeof ctx.emit === 'function') { const deliverable = { id: 'file_' + output.path.replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: output.path }; if (ctx.room) deliverable.room = ctx.room; try { ctx.emit('deliverable', deliverable); } catch (_) {} }
      }
      receipt.state = 'read-back-verified'; receipt.total_bytes = outputBytes; receipt.bundle = folder;
      return { content: JSON.stringify(receipt), mutationReceipt: receipt, summary: receipt.files.length + ' PNG artifacts rendered locally and read-back verified' };
    } catch (e) { receipt.state = receipt.files.length || activeWrite ? 'partially-applied' : 'failed'; e.mutationReceipt = receipt;
      if (activeWrite) e.effectUnknown = true;
      // No absolute host paths, SVG data or loader diagnostics leak into model
      // errors. Verified earlier outputs stay in the host artifact ledger.
      if (!e.toolSummary) { const safe = new Error('Local SVG export failed; inspect the file receipts before retrying.'); safe.toolSummary = 'svg-export-failed'; safe.mutationReceipt = receipt; safe.effectUnknown = e.effectUnknown === true; throw safe; }
      throw e;
    }
  }
  function register(registry) {
    registry.register({ name: 'asset.svg_info', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 10000,
      description: 'Validate and SHA256-hash up to sixteen SVG geometry files in your own worker workspace. Use the exact returned paths/hashes in asset.export_svg. No shell, fonts, network, embedded images or external resources.',
      schema: { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } } } }, run: inspect });
    registry.register({ name: 'asset.export_svg', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 90000,
      description: 'Render up to sixteen verified, own-workspace SVG geometry files into transparent square PNGs at fixed32/64/128/256px and a contact sheet using local sharp. Creates deterministic export bundles without overwriting files. No arbitrary binary writes, shell, providers, fonts, scripts, filters, CSS or external resources. Inspect source hashes with asset.svg_info first. Produces verified file/artifact receipts.',
      schema: { type: 'object', additionalProperties: false, required: ['sources'], properties: { sources: { type: 'array', minItems: 1, maxItems: 16,
        items: { type: 'object', additionalProperties: false, required: ['path', 'sha256'], properties: { path: { type: 'string' }, sha256: { type: 'string' } } } },
        sizes: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'integer', enum: SIZES } }, contact_sheet: { type: 'boolean' } } }, run: exportSvg });
  }
  return { inspect, exportSvg, register };
}
module.exports = { makeFloNativeSvgExport, validateSvg, SIZES, LIMITS };
