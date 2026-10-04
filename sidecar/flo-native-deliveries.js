'use strict';

// Read settled, host-verified deliveries from the exact admitted operation.
// Metadata pages and exact verified delivery reads expose no arbitrary path or
// another operation's ledger. Cursors bind the current manifest so a changed
// delivery cannot silently shift pages.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { fenceExternal } = require('./tools/fence.js');
const MAX_ITEMS = 25;
const MAX_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
function refuse(message) { throw Object.assign(new Error(message), { toolSummary: 'Native deliveries unavailable' }); }

function makeFloNativeDeliveries(d) {
  if (!d || typeof d.snapshot !== 'function' || typeof d.context !== 'function') {
    throw new Error('Native deliveries need host-owned operation state and admission.');
  }
  function current() {
    const admitted = d.context(), state = d.snapshot(), op = state && state.operation;
    if (!plain(admitted) || !Number.isSafeInteger(admitted.operation_id) || admitted.operation_id < 1
      || !text(admitted.run_id, 180) || !plain(state) || state.object !== 'starnet.station.operations'
      || state.schema_version !== 1 || state.ledger_status !== 'ok' || !plain(op)
      || op.id !== admitted.operation_id || op.run_id !== admitted.run_id || op.status !== 'running'
      || !Array.isArray(state.artifacts) || state.artifacts.length > 200) {
      refuse('The current native operation and host run cannot be verified. No delivery or staging permission is implied.');
    }
    return { admitted, state };
  }
  function verifiedRow(row, admitted) {
      if (!plain(row) || row.operation_id !== admitted.operation_id || row.status !== 'verified'
        || !ID.test(row.id || '') || !SHA.test(row.sha256 || '') || !text(row.agent_id, 80)
        || !text(row.run_id, 180) || !text(row.path, 260) || !Number.isSafeInteger(row.size) || row.size < 0
        || row.size > 8 * 1024 * 1024) {
        refuse('The saved native delivery manifest is incomplete. Inspect the station before selecting product files.');
      }
    return { id: row.id, operation_id: row.operation_id, agent_id: row.agent_id, run_id: row.run_id,
        path: row.path, size: row.size, sha256: row.sha256, status: 'verified' };
  }
  function read(args, ctx) {
    args = args === undefined ? {} : args;
    if (!plain(args) || Object.keys(args).some(key => !['cursor', 'agent_id'].includes(key))
      || args.agent_id !== undefined && !text(args.agent_id, 80)
      || args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[a-f0-9]{64}:[0-9]{1,3}$/.test(args.cursor))) {
      refuse('Use only the returned cursor and, optionally, an actual worker agent_id. Operation IDs, paths and URLs are not accepted.');
    }
    const { admitted, state } = current();
    const files = state.artifacts.map(row => verifiedRow(row, admitted))
      .filter(row => args.agent_id === undefined || row.agent_id === args.agent_id);
    const revision = crypto.createHash('sha256').update(JSON.stringify({ operation_id: admitted.operation_id,
      run_id: admitted.run_id, agent_id: args.agent_id || null, files })).digest('hex');
    let offset = 0;
    if (args.cursor !== undefined) {
      const [savedRevision, value] = args.cursor.split(':'); offset = Number(value);
      if (savedRevision !== revision) refuse('The delivery manifest changed. Read station.deliveries again without a cursor before selecting exact files.');
      if (!Number.isSafeInteger(offset) || offset < 1 || offset >= files.length) refuse('This cursor does not point to another page of the current delivery manifest.');
    }
    const ceiling = Number(ctx && ctx.outputMax);
    const maximum = Number.isFinite(ceiling) && ceiling > 0 ? Math.min(MAX_BYTES, Math.floor(ceiling)) : MAX_BYTES;
    const result = { object: 'starnet.station.deliveries', schema_version: 1, read_only: true,
      source: { kind: 'verified_native_operation_ledger', operation_id: admitted.operation_id, run_id: admitted.run_id },
      manifest_revision: revision, agent_id: args.agent_id || null, total: files.length, offset,
      artifacts: [], next_cursor: null, limits: { max_items: MAX_ITEMS, max_response_bytes: maximum },
      scope: 'Saved host-verified file receipts only. File bytes are checked again when Flo stages a proposal. A delivery is not owner review, publication or revenue.' };
    for (const row of files.slice(offset, offset + MAX_ITEMS)) {
      result.artifacts.push(row);
      const nextOffset = offset + result.artifacts.length;
      result.next_cursor = nextOffset < files.length ? revision + ':' + nextOffset : null;
      if (Buffer.byteLength(JSON.stringify(result)) > maximum) { result.artifacts.pop(); break; }
    }
    const nextOffset = offset + result.artifacts.length;
    result.next_cursor = nextOffset < files.length ? revision + ':' + nextOffset : null;
    if (files.length > offset && !result.artifacts.length || Buffer.byteLength(JSON.stringify(result)) > maximum) {
      refuse('The saved delivery page exceeds its admitted bound. Inspect the station directly.');
    }
    return result;
  }
  async function readFile(args, ctx) {
    if (!plain(args) || Object.keys(args).length !== 2 || !Object.hasOwn(args, 'artifact_id')
      || !Object.hasOwn(args, 'sha256') || !ID.test(args.artifact_id || '') || !SHA.test(args.sha256 || '')) {
      refuse('Use the exact artifact_id and sha256 from station.deliveries. Paths, URLs, other operations and guessed receipts are refused.');
    }
    const { admitted, state } = current();
    const row = verifiedRow(state.artifacts.find(value => value && value.id === args.artifact_id), admitted);
    if (row.sha256 !== args.sha256) refuse('The requested SHA256 differs from this operation’s verified delivery. Read the current manifest before reviewing.');
    if (row.size > MAX_IMAGE_BYTES || typeof d.artifact !== 'function') refuse('This delivery cannot be read through the bounded native review tool.');
    let proven;
    try { proven = await d.artifact(admitted.operation_id, args.artifact_id); }
    catch (_) { refuse('The delivered file changed or could not be read back safely. It needs a fresh verified receipt.'); }
    const bytes = proven && proven.bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.size || crypto.createHash('sha256').update(bytes).digest('hex') !== args.sha256
      || Object.keys(row).some(key => key !== 'status' && proven[key] !== row[key])) {
      refuse('The delivered bytes do not match the exact native artifact receipt. No review data was returned.');
    }
    // A pause/new pass during the read invalidates admission, before bytes enter
    // a worker conversation. The host reader also rechecks its worker jail.
    const after = current();
    if (after.admitted.operation_id !== admitted.operation_id || after.admitted.run_id !== admitted.run_id
      || !after.state.artifacts.some(value => value.id === row.id && value.sha256 === row.sha256)) {
      refuse('The native operation changed during delivery read-back. Inspect the saved state before reviewing.');
    }
    const label = 'verified native delivery ' + row.id + ' from worker ' + row.agent_id + ', ' + row.path + ', SHA256 ' + row.sha256;
    const info = d.imageWire && d.imageWire.sniff(row.path, bytes);
    if (info) {
      if (!['image/png', 'image/jpeg'].includes(info.mime) || info.bytes > MAX_IMAGE_BYTES
        || !info.width || !info.height || info.width > 4096 || info.height > 4096) refuse('Only bounded PNG or JPEG deliveries can be shown directly for native review.');
      const wire = d.imageWire.toWire(bytes, info);
      if (!Array.isArray(wire.images) || wire.images.length !== 1) refuse('The existing native image channel could not show these verified pixels.');
      return { content: fenceExternal(d.imageWire.describe(info, row.path), label),
        summary: 'Verified native ' + info.ext + ' pixels from ' + row.agent_id,
        images: wire.images };
    }
    if (bytes.length > MAX_TEXT_BYTES) refuse('Text deliveries must be at most32KiB to be read as one exact review artifact.');
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { refuse('This delivery is not supported UTF-8 text, PNG or JPEG.'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) refuse('Binary deliveries cannot be presented as text for native review.');
    const content = fenceExternal(decoded, label), ceiling = Number(ctx && ctx.outputMax);
    if (Number.isFinite(ceiling) && ceiling > 0 && content.length > ceiling) {
      refuse('This exact text file exceeds the current conversation’s tool-result budget. Ask its producer for a smaller review document.');
    }
    return { content, summary: 'Verified native UTF-8 text from ' + row.agent_id };
  }
  function register(registry) {
    registry.register({ name: 'station.deliveries', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'Read fresh host-verified artifact IDs, worker ownership, paths, bytes and SHA256 for this admitted operation. After a foreground worker settles, use these IDs for commerce.propose in the same pass. Follow next_cursor with the same agent_id until null. Changed manifests require starting again without a cursor. No paths, downloads, arbitrary operation IDs or external action.',
      schema: { type: 'object', additionalProperties: false, properties: {
        cursor: { type: 'string', pattern: '^[a-f0-9]{64}:[0-9]{1,3}$' },
        agent_id: { type: 'string', minLength: 1, maxLength: 80 }
      } }, run: async (args, ctx) => {
        const value = read(args, ctx);
        return { content: JSON.stringify(value), summary: value.artifacts.length + ' verified native deliveries; ' + value.total + ' in manifest' };
      } });
    registry.register({ name: 'station.delivery_read', capability: 'cabinet', scope: 'read', requiresConsent: false,
      description: 'Review an exact delivered file from this native operation using artifact_id and sha256 supplied by the lead’s station.deliveries manifest. Reads another producer’s verified delivery without opening its workspace. UTF-8 text <=32KiB; PNG/JPEG <=1MiB returned as actual image pixels. No arbitrary paths, URLs, other operations or write authority.',
      schema: { type: 'object', additionalProperties: false, required: ['artifact_id', 'sha256'], properties: {
        artifact_id: { type: 'string', pattern: '^[a-f0-9]{32}$' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
      } }, run: readFile });
  }
  return { read, readFile, register };
}
module.exports = { makeFloNativeDeliveries, MAX_ITEMS, MAX_BYTES, MAX_TEXT_BYTES, MAX_IMAGE_BYTES };
