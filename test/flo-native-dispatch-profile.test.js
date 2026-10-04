'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../sidecar/flo-capability-profile.js');

test('Native dispatch refuses every enabled or malformed background value before admitting budget or work', () => {
  let budgetAdmissions = 0;
  const guard = profiles.makeGuard(profiles.resolve('flo-operator'), { take() { budgetAdmissions++; return true; } });
  for (const background of [true, 'true', 'false', 1, {}, [], null, 0, '']) {
    const result = guard.start('team.dispatch', { workers: [{ agentId: 'maker', prompt: 'Save a file' }], background });
    assert.equal(result.ok, false);
    assert.equal(result.summary, 'capability-profile-foreground-required');
    assert.match(result.content, /parallel:true/);
  }
  assert.equal(budgetAdmissions, 0);
  assert.equal(guard.receipt().tool_calls, 0);
  assert.equal(guard.receipt().denied_calls, 9);
});

test('Native foreground and parallel dispatch still use the normal shared pass allowance', () => {
  let budgetAdmissions = 0;
  const guard = profiles.makeGuard(profiles.resolve('flo-operator'), { take() { budgetAdmissions++; return true; } });
  for (const args of [{}, { background: false }, { background: false, parallel: true }, { parallel: true }]) {
    assert.equal(guard.start('team.dispatch', args).ok, true);
  }
  assert.equal(budgetAdmissions, 4);
  assert.equal(guard.receipt().tool_calls, 4);
});

test('The foreground restriction does not alter legacy profile or unprofiled dispatch semantics', () => {
  assert.equal(profiles.makeGuard(profiles.resolve(undefined)), null);
  const legacy = { id: 'legacy-test-envelope', tools: ['team.dispatch'], max_tool_calls: 3 };
  const guard = profiles.makeGuard(legacy);
  assert.equal(guard.start('team.dispatch', { background: true }).ok, true);
  assert.equal(guard.start('team.dispatch', { background: 'true' }).ok, true);
  assert.equal(guard.receipt().tool_calls, 2);
});

test('A recruited native worker still cannot gain dispatch through a foreground option', () => {
  const guard = profiles.makeGuard(profiles.resolve('flo-operator-worker'));
  assert.equal(guard.start('team.dispatch', { background: false, parallel: true }).ok, false);
  assert.equal(guard.receipt().tool_calls, 0);
});
