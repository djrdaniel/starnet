'use strict';

// A host-owned admission boundary, outside every worker's filesystem jail.
// Saved native timer intent and permission grants are deliberately untouched.
const { makeDomainStore } = require('./domain-store.js');

function makeFloOperation(deps) {
  const store = makeDomainStore({ fs: deps.fs, path: deps.path,
    file: deps.path.join(deps.workspaces, '_flo.operation.json'), writeDurable: deps.writeDurable,
    version: 1, defaults: () => ({ mode: 'native' }),
    normalize: value => {
      if (!value || !['native', 'flo-managed'].includes(value.mode)) throw new Error('Invalid Flo operation policy');
      return { mode: value.mode };
    } });
  let state = store.load();
  const protectedMode = () => state.value.mode === 'flo-managed'
    || !['ok', 'recovered', 'absent'].includes(state.status);
  return {
    snapshot() { return { mode: protectedMode() ? 'flo-managed' : 'native',
      native_unscoped_autonomous_allowed: !protectedMode(), policy_status: state.status }; },
    enable() {
      // Fail closed even if persisting the policy fails midway through setup.
      state = { value: { mode: 'flo-managed' }, status: 'unproven' };
      const result = store.save({ mode: 'flo-managed' });
      state = { value: result.value, status: 'ok' };
      return this.snapshot();
    },
    assertAdmission(options, resolvedFloProfile) {
      if (!protectedMode() || ((options.surface || 'autonomous') === 'interactive' && !options.internal && !options.parentRunId) || resolvedFloProfile) return;
      throw Object.assign(new Error('Flo manages this station. Flo must explicitly admit an individually named worker job.'),
        { code: 'FLO_MANAGED_ADMISSION_REQUIRED' });
    }
  };
}

module.exports = { makeFloOperation };
