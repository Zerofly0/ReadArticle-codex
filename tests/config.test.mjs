import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isModelIdentifier, resolvePython } from '../lib/config.mjs';
import { createTranslationPresets, resolveTranslationSettings } from '../lib/settings.mjs';

test('model discovery uses only local validated preset overrides and preserves compatibility defaults', () => {
  const defaults = createTranslationPresets({});
  assert.equal(defaults[0].model, 'gpt-6-luna');
  const configured = createTranslationPresets({ READER_MODEL_FAST: 'account/model-alias', READER_EFFORT_FAST: 'minimal', READER_MODEL_CAREFUL: 'inherit', READER_EFFORT_CAREFUL: 'inherit' });
  assert.equal(configured[0].model, 'account/model-alias');
  assert.equal(configured[0].reasoningEffort, 'minimal');
  assert.equal(configured[2].model, null);
  assert.equal(configured[2].reasoningEffort, null);
  assert.equal(defaults[0].model, 'gpt-6-luna', 'configuring one integration must not mutate defaults');
  assert.equal(resolveTranslationSettings({ model: 'from-http', reasoningEffort: 'high' }, configured).model, 'account/model-alias');
});

test('invalid local configuration fails without echoing the configured value', () => {
  for (const env of [{ READER_MODEL_FAST: 'invalid model with whitespace' }, { READER_EFFORT_CAREFUL: 'invalid-effort' }]) {
    assert.throws(() => createTranslationPresets(env), error => /配置无效/.test(error.message) && !Object.values(env).some(value => error.message.includes(value)));
  }
  for (const value of ['--flag', 'model\noption', 'model with spaces', 'a'.repeat(201), null, 42]) assert.equal(isModelIdentifier(value), false);
  for (const value of ['gpt-example', 'provider/model.v1', 'deployment:alias_2']) assert.equal(isModelIdentifier(value), true);
});

test('Python discovery honors explicit configuration before checking current-user bundled runtime', () => {
  assert.equal(resolvePython({ env: { READER_PYTHON: 'custom-python' }, exists: () => { throw new Error('must not inspect another path'); } }), 'custom-python');
  const profile = path.resolve('synthetic-user-profile');
  const expected = path.join(profile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  assert.equal(resolvePython({ env: { USERPROFILE: profile }, platform: 'win32', exists: candidate => candidate === expected }), expected);
  assert.equal(resolvePython({ env: { HOME: profile }, platform: 'win32', exists: () => false }), 'python');
  assert.equal(resolvePython({ env: {}, platform: 'linux', exists: () => true, home: () => profile }), 'python3');
});
