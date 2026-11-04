import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexError, classifyCodexFailure, queueToThread, runCodex, validateStructuredResult } from '../lib/codex.mjs';

const translationSchema = {
  type: 'object', additionalProperties: false, required: ['text', 'alignments'],
  properties: {
    text: { type: 'string', minLength: 1 },
    alignments: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['sourceIds', 'targetText'],
        properties: { sourceIds: { type: 'array', minItems: 1, items: { type: 'string' } }, targetText: { type: 'string', minLength: 1 } },
      },
    },
  },
};

test('accepts a translation with multiple source sentences aligned to one Chinese fragment', () => {
  const result = { text: '这一方法在弱光条件下可能提高精度。', alignments: [{ sourceIds: ['p1-s1', 'p1-s2'], targetText: '这一方法在弱光条件下可能提高精度。' }] };
  assert.equal(validateStructuredResult(result, translationSchema), result);
});

test('does not accept a partial or malformed model response as a saved translation', () => {
  for (const result of [
    { text: '译文' },
    { text: '', alignments: [] },
    { text: '译文', alignments: [{ sourceIds: 'p1-s1', targetText: '译文' }] },
    { text: '译文', alignments: [{ sourceIds: ['p1-s1'], targetText: '译文', unsafeField: true }] },
  ]) assert.throws(() => validateStructuredResult(result, translationSchema), error => error.code === 'CODEX_INVALID_RESULT');
});

test('reports the actual Windows state-directory failure with an actionable message', () => {
  const error = classifyCodexFailure({ stderr: 'failed to initialize in-process app-server client: 拒绝访问。 (os error 5)' });
  assert.equal(error.code, 'CODEX_PERMISSION_DENIED');
  assert.match(error.message, /重新启动阅读器/);
});

test('distinguishes authentication, network, and quota failures', () => {
  assert.equal(classifyCodexFailure({ stderr: '401 Unauthorized' }).code, 'CODEX_AUTH_REQUIRED');
  assert.equal(classifyCodexFailure({ stderr: 'stream disconnected before completion' }).code, 'CODEX_CONNECTION_FAILED');
  assert.equal(classifyCodexFailure({ stderr: '429 rate limit exceeded' }).code, 'CODEX_RATE_LIMIT');
});

test('error details redact API keys and bearer credentials', () => {
  const error = new CodexError('failed', 'TEST', 'key ' + ['sk', '1234567890abcdefghijkl'].join('-') + ' Authorization: ' + ['Bearer', 'some-private-credential'].join(' '));
  assert.doesNotMatch(error.detail, /sk-123456|some-private-credential/);
});

test('protocol error messages and details redact labeled credentials before reaching jobs or logs', () => {
  const bearer = ['Bearer', 'synthetic-private-value'].join(' ');
  const error = new CodexError('RPC failed: ' + bearer + ' api_key=' + JSON.stringify('synthetic-other-value'), 'TEST', 'access_token=' + 'synthetic-access-value' + ' refresh-token=' + 'synthetic-refresh-value');
  assert.doesNotMatch(error.message + error.detail, /synthetic-(?:private|other|access|refresh)-value/);
  assert.match(error.message, /RPC failed/);
});

test('cancelled translation exits before probing or launching another Codex session', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCodex({ prompt: 'Translate', schema: translationSchema, workspace: process.cwd(), signal: controller.signal }), error => error.code === 'ABORTED');
});

test('thread queue rejects an unbound destination before any CLI invocation', async () => {
  await assert.rejects(queueToThread({ threadId: 'unbound', message: 'Explain the selection.' }), error => error.code === 'INVALID_THREAD_ID');
});
