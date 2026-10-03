'use strict';
// Child-only deterministic OAuth provider. The fixture cannot reach an account
// or the network; it drives the real native write/consent host instead.
const actualFetch = globalThis.fetch;
const attempts = new Map();
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://chatgpt.com/backend-api/codex/')) return actualFetch(url, init);
  if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }));
  if (process.env.STATION_PROVIDER_CALLS_FILE) require('node:fs').appendFileSync(process.env.STATION_PROVIDER_CALLS_FILE, 'call\n');
  const body = JSON.parse(init.body), input = JSON.stringify(body);
  const mode = input.includes('STATION_BRIDGE_APPROVE') ? 'approve' : input.includes('STATION_BRIDGE_DENY') ? 'deny' : 'aux';
  const n = attempts.get(mode) || 0; attempts.set(mode, n + 1);
  const events = [];
  if (n === 0 && mode !== 'aux') {
    const item = { type: 'function_call', call_id: 'write-' + mode, name: 'fs_write' };
    events.push({ type: 'response.output_item.added', output_index: 0, item });
    events.push({ type: 'response.function_call_arguments.delta', output_index: 0,
      delta: JSON.stringify({ path: 'operator-' + mode + '.txt', content: 'Owner-reviewed local test draft.' }) });
    events.push({ type: 'response.output_item.done', output_index: 0, item });
  } else events.push({ type: 'response.output_text.delta', output_index: 0, delta: 'Finished the consent test.' });
  events.push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } });
  return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
};
