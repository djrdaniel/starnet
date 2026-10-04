'use strict';

// Per-call native consent. This admission exists only in host memory: model
// arguments, public station requests and saved permission grants cannot mint it.
const boardMoves = new WeakMap();
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function validBoardMove(args) {
  return !!args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).every(key => ['task', 'action', 'lane'].includes(key))
    && ['task', 'action', 'lane'].every(key => has(args, key))
    && typeof args.task === 'string' && args.task.length <= 160 && !!args.task.trim()
    && !/[\x00-\x1f\x7f]/.test(args.task)
    && args.action === 'move' && ['todo', 'active', 'shipped'].includes(args.lane);
}
const boardKey = args => JSON.stringify([args.task, args.action, args.lane]);
function admittedBoardMove(args, meta) {
  return validBoardMove(args) && !!meta && typeof meta === 'object'
    && boardMoves.get(meta) === boardKey(args);
}
function makeNativeConsent({ profile, signal, prompt, callContext }) {
  return async (call, tool) => {
    if (!call || signal.aborted || !profile || profile.host_only !== true
      || !profile.tools.includes(call.name)) {
      return { allow: false, reason: 'Native operation cancelled or outside its envelope.' };
    }
    const args = call.args || {};
    if (call.name === 'task.manage' && args.action === 'move') {
      const meta = typeof callContext === 'function' && callContext();
      if (profile.id !== 'flo-operator' || !validBoardMove(args) || !meta || typeof meta !== 'object') {
        return { allow: false, reason: 'A native board move requires an exact existing task, valid lane and host call context.' };
      }
      boardMoves.set(meta, boardKey(args));
    } else if (call.name === 'task.manage' && ['remove', 'archive'].includes(args.action)) {
      if (!prompt) return { allow: false, reason: 'This destructive board action requires owner review.' };
      const decision = await prompt(call, tool);
      if (signal.aborted || decision !== 'once') return { allow: false, reason: 'Owner did not approve this exact board action.' };
      const meta = typeof callContext === 'function' && callContext();
      if (!meta || typeof meta !== 'object') return { allow: false, reason: 'Host call context is unavailable.' };
      meta.ownerConfirmed = true;
    }
    // A board lane is internal organization, not external release, revenue or
    // a permission grant. Canonical lookup/CAS still proves the actual change.
    return { allow: true, scope: tool.scope, reason: 'Owner-admitted native operation' };
  };
}
const NATIVE_TASK_DESCRIPTION = 'Change an EXISTING durable native task-board card: move between todo/active/shipped, rename, assign to a crew agent, archive/restore, or remove it. Within this owner-admitted operation, move is authorized local board organization; use shipped only for work actually completed and verified. Moving a card never publishes a store product, approves licence/price/fees, establishes revenue or changes external permissions. Do not wait for owner approval merely to organize a card. Archive/remove remain owner-consent gated. Use team.dispatch to start work.';

module.exports = { makeNativeConsent, validBoardMove, admittedBoardMove, NATIVE_TASK_DESCRIPTION };
