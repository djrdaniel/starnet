'use strict';

// The native operation needs the genuine dispatcher outcome, after session
// preflight, wall-clock admission and structured-result validation. Raw child
// results still own artifact verification; this wrapper records failures only.
const crypto = require('node:crypto');

function wrapNativeDispatch(run, deps) {
  if (typeof run !== 'function' || !deps || typeof deps.recordResult !== 'function'
    || typeof deps.callIdentity !== 'function') throw new Error('Native dispatch needs its host-owned outcome ledger.');
  return async function (args, ctx) {
    const asked = Array.isArray(args && args.workers) ? args.workers : [];
    const identity = String(deps.callIdentity() || ctx && ctx.runId || 'native-dispatch');
    const record = async (row, index, fallbackReason) => {
      if (row && row.reason === 'done') return;
      const agentId = String(row && row.agentId || asked[index] && asked[index].agentId || '(unnamed)').slice(0, 80);
      const runId = row && typeof row.runId === 'string' && row.runId
        ? row.runId
        : 'dispatch:' + crypto.createHash('sha256').update(identity + '\0' + index + '\0' + agentId).digest('hex');
      await deps.recordResult(agentId, runId, {
        reason: String(row && row.reason || fallbackReason || 'dispatch_result_unavailable').slice(0, 80), artifacts: []
      });
    };
    let result;
    try { result = await run.call(this, args, ctx); }
    catch (error) {
      for (let i = 0; i < asked.length; i++) await record(null, i, 'dispatch_error');
      throw error;
    }
    let rows;
    try { rows = JSON.parse(result && result.content); } catch (_) {}
    if (!Array.isArray(rows)) {
      for (let i = 0; i < asked.length; i++) await record(null, i);
    } else {
      for (let i = 0; i < Math.max(asked.length, rows.length); i++) await record(rows[i], i);
    }
    return result;
  };
}

module.exports = { wrapNativeDispatch };
