'use strict';

// Fixed host-owned seams to Flo's saved commerce records and inert proposals.
// Neither a model nor a connector can supply a destination, credential or method.
const crypto = require('node:crypto');
const ENDPOINT = 'http://127.0.0.1:8765/api/native-station/commerce-context';
const PROPOSAL_ENDPOINT = 'http://127.0.0.1:8765/api/native-station/commerce-proposals';
const MAX_BYTES = 16 * 1024;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_PROPOSAL_ARTIFACTS = 96;
const PROPOSAL_KEYS = ['channel', 'intent', 'target', 'fields', 'artifact_ids', 'buyer_artifact_ids', 'evidence', 'remote_basis', 'supersedes'];
const FIELD_KEYS = ['title', 'description', 'price', 'currency', 'licence', 'quantity', 'taxonomy_id', 'who_made', 'when_made',
  'is_supply', 'shipping_profile_id', 'return_policy_id', 'tags', 'materials', 'personalization_instructions', 'announcement',
  'ai_disclosure', 'visibility', 'classification', 'cover_artifact_id', 'readiness_state_id', 'production_partner_ids', 'rank'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function validSource(value, object) {
  return value && value.object === object && value.schema_version === 1 && value.source
    && value.source.kind === 'saved_local_flo_state' && value.source.live_store_request === false;
}
async function boundedReply(reply, control, maximum) {
  if (!reply.ok) throw new Error('Local commerce record unavailable.');
  let size = 0; const pieces = [];
  for await (const chunk of reply.body) {
    const part = Buffer.from(chunk); size += part.length;
    if (size > maximum) { control.abort(); throw new Error('Local record exceeds its admitted size.'); }
    pieces.push(part);
  }
  return JSON.parse(Buffer.concat(pieces).toString('utf8'));
}
function makeFloNativeCommerce(d) {
  async function read() {
    const key = String(d.key() || '');
    if (key.length < 16) return { ok: false, summary: 'Flo commerce connection unavailable', content: 'The local commerce bridge is not authenticated. No store capability or action is implied.' };
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 5000);
    try {
      const reply = await d.fetch(ENDPOINT, { method: 'GET', redirect: 'error', signal: control.signal,
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
      const value = await boundedReply(reply, control, MAX_BYTES);
      if (!validSource(value, 'flo.native.commerce_context') || value.read_only !== true) throw new Error('Local record provenance unavailable.');
      return { ok: true, summary: 'Actual Flo commerce records read', content: JSON.stringify(value) };
    } catch (_) {
      return { ok: false, summary: 'Flo commerce record unavailable', content: 'Flo commerce records could not be verified. Do not invent connected stores, revenue, products or authority. Inspect Flo Connections when the local app is available.' };
    } finally { clearTimeout(timer); }
  }
  async function propose(args) {
    // Provenance is taken only from the admitted lead and its actual tool-call
    // identity. Model approval, publication and source flags never cross Flo.
    let payload;
    try {
      if (!plain(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_PROPOSAL_BYTES) throw new Error('Proposal exceeds its bound.');
      const context = typeof d.context === 'function' ? d.context() : null;
      if (!context || !Number.isSafeInteger(context.operation_id) || context.operation_id < 1
        || typeof context.run_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(context.run_id)
        || typeof context.call_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(context.call_id)) throw new Error('Native host provenance is unavailable.');
      payload = Object.fromEntries(PROPOSAL_KEYS.filter(key => Object.prototype.hasOwnProperty.call(args, key)).map(key => [key, args[key]]));
      payload.operation_id = context.operation_id; payload.run_id = context.run_id;
      payload.request_id = 'native-' + crypto.createHash('sha256').update(context.run_id + ':' + context.call_id).digest('hex');
      if (!['etsy', 'itch'].includes(payload.channel) || !plain(payload.target) || !plain(payload.fields)
        || Object.keys(payload.fields).some(key => !FIELD_KEYS.includes(key))
        || !Array.isArray(payload.artifact_ids) || !payload.artifact_ids.length || payload.artifact_ids.length > MAX_PROPOSAL_ARTIFACTS
        || payload.artifact_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{24,64}$/.test(id))) throw new Error('A concrete bounded proposal with native artifacts is required.');
      if (!(payload.channel === 'etsy' ? ['draft', 'edit', 'publish', 'shop_edit', 'image'] : ['package', 'page']).includes(payload.intent)) throw new Error('Unknown channel intent.');
      if (payload.channel === 'itch' && payload.intent === 'package' && (!Array.isArray(payload.buyer_artifact_ids)
        || !payload.buyer_artifact_ids.length || payload.buyer_artifact_ids.length > MAX_PROPOSAL_ARTIFACTS
        || payload.buyer_artifact_ids.some(id => !payload.artifact_ids.includes(id)))) throw new Error('Select the actual buyer files separately from evidence.');
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PROPOSAL_BYTES) throw new Error('Proposal exceeds its bound.');
    } catch (_) {
      return { ok: false, summary: 'Commerce proposal refused', content: 'Use a concrete Etsy physical or itch digital proposal with verified native artifact IDs and supported fields. Host operation, run and tool provenance are required; approval flags cannot grant external actions.' };
    }
    const key = String(d.key() || '');
    if (key.length < 16) return { ok: false, summary: 'Flo commerce connection unavailable', content: 'The local commerce bridge is not authenticated. No proposal or store action was verified.' };
    const control = new AbortController(), timer = setTimeout(() => control.abort(), 5000);
    try {
      const reply = await d.fetch(PROPOSAL_ENDPOINT, { method: 'POST', redirect: 'error', signal: control.signal,
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const value = await boundedReply(reply, control, MAX_PROPOSAL_BYTES), proposal = value && value.proposal;
      if (!validSource(value, 'flo.native.commerce_proposal') || !plain(proposal)
        || proposal.operation_id !== payload.operation_id || proposal.run_id !== payload.run_id
        || proposal.channel !== payload.channel || proposal.intent !== payload.intent
        || !plain(proposal.target) || Object.keys(proposal.target).length !== Object.keys(payload.target).length
        || Object.keys(payload.target).some(key => proposal.target[key] !== payload.target[key])
        || !Number.isSafeInteger(proposal.id) || proposal.id < 1 || typeof proposal.revision !== 'string' || !/^[a-f0-9]{64}$/.test(proposal.revision)
        || typeof value.duplicate !== 'boolean' || !['staged', 'reviewed_local', 'rejected', 'superseded'].includes(proposal.status)
        || !['not_requested', 'prepared', 'running', 'unknown', 'confirmed', 'failed'].includes(proposal.external_status)
        || !value.duplicate && (proposal.status !== 'staged' || proposal.external_status !== 'not_requested')) throw new Error('Local proposal provenance unavailable.');
      return { ok: true, summary: value.duplicate ? 'Existing commerce proposal read: ' + proposal.status + ' / ' + proposal.external_status
        : 'Local commerce proposal staged for owner review', content: JSON.stringify(value) };
    } catch (_) {
      return { ok: false, summary: 'Flo commerce proposal unverified', content: 'A local proposal could not be verified. No store action was requested and no automatic retry was made. Read commerce.read to inspect saved proposals before issuing another proposal.' };
    } finally { clearTimeout(timer); }
  }
  function register(registry) {
    registry.register({ name: 'commerce.read', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'Read actual saved Flo commerce connections, physical Etsy and digital itch product/release facts, saved proposals and dependencies. No live store request, buyer identity, credentials or external action.',
      schema: { type: 'object', additionalProperties: false, properties: {} }, run: async () => {
        const result = await read();
        if (!result.ok) throw Object.assign(new Error(result.content), { toolSummary: result.summary });
        return { content: result.content, summary: result.summary };
      } });
    const artifactId = { type: 'string', pattern: '^[a-f0-9]{24,64}$' };
    registry.register({ name: 'commerce.propose', capability: 'orchestrator', scope: 'write', requiresConsent: true,
      description: 'Stage an inert local Flo proposal backed by actual native artifact IDs: physical Etsy draft/edit/publication/shop copy, or itch buyer package/page. This never edits a shop, uploads files, publishes or spends. Flo validates evidence and displays review; external actions require their own verified connector and approval.',
      schema: { type: 'object', additionalProperties: false, required: ['channel', 'intent', 'target', 'fields', 'artifact_ids', 'evidence'], properties: {
        channel: { type: 'string', enum: ['etsy', 'itch'] }, intent: { type: 'string', enum: ['draft', 'edit', 'publish', 'shop_edit', 'image', 'package', 'page'] },
        target: { type: 'object', additionalProperties: false, properties: { shop_id: { type: 'integer' }, listing_id: { type: 'integer' }, username: { type: 'string' }, project_slug: { type: 'string' }, channel: { type: 'string' } } },
        fields: { type: 'object', additionalProperties: false, properties: Object.fromEntries(FIELD_KEYS.map(key => [key,
          key === 'rank' ? { type: 'integer', minimum: 1, maximum: 10 }
            : ['quantity', 'taxonomy_id', 'shipping_profile_id', 'return_policy_id', 'readiness_state_id'].includes(key) ? { type: 'integer', minimum: 1 }
            : key === 'production_partner_ids' ? { type: 'array', maxItems: 10, items: { type: 'integer', minimum: 1 } }
            : key === 'is_supply' ? { type: 'boolean' } : ['tags', 'materials'].includes(key) ? { type: 'array', items: { type: 'string' }, maxItems: 13 }
              : key === 'currency' ? { type: 'string', enum: ['GBP', 'USD', 'EUR'] } : { type: 'string' }])) },
        artifact_ids: { type: 'array', minItems: 1, maxItems: MAX_PROPOSAL_ARTIFACTS, items: artifactId }, buyer_artifact_ids: { type: 'array', minItems: 1, maxItems: MAX_PROPOSAL_ARTIFACTS, items: artifactId },
        evidence: { type: 'object', additionalProperties: false, properties: {
          rights: { type: 'object', additionalProperties: false, required: ['statement', 'artifact_id'], properties: { statement: { type: 'string' }, artifact_id: artifactId } },
          fulfilment: { type: 'object', additionalProperties: false, required: ['supplier', 'method', 'dispatch', 'returns', 'artifact_id'], properties: {
            supplier: { type: 'string' }, method: { type: 'string' }, dispatch: { type: 'string' }, returns: { type: 'string' }, artifact_id: artifactId } } } },
        remote_basis: { type: 'string', pattern: '^[a-f0-9]{64}$' }, supersedes: { type: 'integer' }
      } }, run: async args => {
        const result = await propose(args);
        if (!result.ok) throw Object.assign(new Error(result.content), { toolSummary: result.summary });
        return { content: result.content, summary: result.summary };
      } });
  }
  return { read, propose, register };
}
module.exports = { makeFloNativeCommerce, ENDPOINT, PROPOSAL_ENDPOINT, MAX_BYTES, MAX_PROPOSAL_BYTES, MAX_PROPOSAL_ARTIFACTS };
