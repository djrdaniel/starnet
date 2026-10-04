'use strict';

// One host-owned, read-only connection to Flo's existing local commerce records.
// Neither a model nor a connector can supply a destination, credential or method.
const ENDPOINT = 'http://127.0.0.1:8765/api/native-station/commerce-context';
const MAX_BYTES = 16 * 1024;
function makeFloNativeCommerce(d) {
  async function read() {
    const key = String(d.key() || '');
    if (key.length < 16) return { ok: false, summary: 'Flo commerce connection unavailable', content: 'The local commerce bridge is not authenticated. No store capability or action is implied.' };
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 5000);
    try {
      const reply = await d.fetch(ENDPOINT, { method: 'GET', redirect: 'error', signal: control.signal,
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
      if (!reply.ok) throw new Error('Local commerce record unavailable.');
      let size = 0; const pieces = [];
      for await (const chunk of reply.body) {
        const part = Buffer.from(chunk); size += part.length;
        if (size > MAX_BYTES) { control.abort(); throw new Error('Local record exceeds its admitted size.'); }
        pieces.push(part);
      }
      const value = JSON.parse(Buffer.concat(pieces).toString('utf8'));
      if (!value || value.object !== 'flo.native.commerce_context' || value.read_only !== true || value.schema_version !== 1
        || !value.source || value.source.kind !== 'saved_local_flo_state' || value.source.live_store_request !== false) throw new Error('Local record provenance unavailable.');
      return { ok: true, summary: 'Actual Flo commerce records read', content: JSON.stringify(value) };
    } catch (_) {
      return { ok: false, summary: 'Flo commerce record unavailable', content: 'Flo commerce records could not be verified. Do not invent connected stores, revenue, products or authority. Inspect Flo Connections when the local app is available.' };
    } finally { clearTimeout(timer); }
  }
  return { read };
}
module.exports = { makeFloNativeCommerce, ENDPOINT, MAX_BYTES };
