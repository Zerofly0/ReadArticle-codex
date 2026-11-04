import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startReader } from '../server.mjs';
import { mergeReparsedDocument, resolveTranslationSettings } from '../lib/settings.mjs';

const runtimeRoot = path.resolve('.reader-runtime');
const translation = text => ({ text, alignments: [], status: 'aligned', sourceHash: 'previous-source' });
const paragraph = (id, text, extra = {}) => ({ id, page: 1, kind: 'paragraph', text, rawText: text, sentences: [{ id: `${id}-s1`, text }], translation: null, ...extra });
const document = (id, paragraphs, extra = {}) => ({ id, title: 'Settings test paper', filename: 'paper.pdf', pageCount: 4, sections: [], paragraphs, assets: [], ...extra });

test('reparse keeps unchanged translations and archives changed, removed, and newly excluded content', () => {
  const existingArchive = { paragraphId: 'earlier', text: 'Earlier text', translation: translation('更早的译文') };
  const previous = document('old', [
    paragraph('keep', 'The method may improve accuracy.', { translation: translation('该方法可能提高精度。') }),
    paragraph('changed', 'The original claim.', { translation: translation('旧结论。') }),
    paragraph('authors', 'A. Author, Example University', { translation: translation('作者与单位。') }),
    paragraph('equation', 'x = y', { translation: translation('x 等于 y。') }),
    paragraph('removed', 'Removed source text.', { translation: translation('已移除的原文。') }),
  ], { importedAt: '2026-10-01T01:02:03.000Z', archivedTranslations: [existingArchive], glossary: [{ term: 'method', translation: '方法' }] });
  const fresh = document('new', [
    paragraph('new-keep', 'The method may improve accuracy.'),
    paragraph('changed', 'The revised claim.'),
    paragraph('authors', 'A. Author, Example University', { kind: 'metadata' }),
    paragraph('equation', 'x = y', { kind: 'equation' }),
  ]);
  const merged = mergeReparsedDocument(previous, fresh);
  assert.deepEqual(merged.paragraphs.find(p => p.id === 'new-keep').translation, previous.paragraphs[0].translation);
  assert.equal(merged.paragraphs.find(p => p.id === 'changed').translation, null);
  assert.equal(merged.paragraphs.find(p => p.id === 'authors').translation, null);
  assert.equal(merged.paragraphs.find(p => p.id === 'equation').translation, null);
  assert.deepEqual(new Set(merged.archivedTranslations.map(a => a.paragraphId)), new Set(['earlier', 'changed', 'authors', 'equation', 'removed']));
  assert.deepEqual(merged.archivedTranslations[0], existingArchive);
  assert.equal(merged.reparse.keptTranslations, 1);
  assert.equal(merged.reparse.archivedTranslations, 4);
  assert.equal(merged.importedAt, previous.importedAt);
  assert.deepEqual(merged.glossary, previous.glossary);
});

test('reparse remaps reading position and answer citations using matching raw source text', () => {
  const raw = 'The objective minimizes E = x + y under the constraint.';
  const previous = document('same-document', [
    paragraph('old-math', raw, { page: 2, translation: translation('目标在约束下最小化该能量。') }),
    paragraph('old-following', 'This interpretation remains valid.', { page: 3 }),
  ], {
    progress: { paragraphId: 'old-math', scrollTop: 420, updatedAt: '2026-10-01T01:02:03.000Z' },
    answers: [{
      answer: '这是目标函数。', paragraphId: 'old-math', selectedText: 'E = x + y',
      citations: [{ paragraphId: 'old-math', page: 2, quote: 'The objective minimizes' }, { paragraphId: 'old-following', page: 3, quote: 'remains valid' }],
    }],
  });
  const fresh = document('same-document', [
    paragraph('new-math', 'The objective minimizes [[MATH:math-1]] under the constraint.', { rawText: raw, page: 4 }),
    paragraph('new-following', 'This interpretation remains valid.', { page: 4 }),
  ]);
  const merged = mergeReparsedDocument(previous, fresh);
  assert.equal(merged.progress.paragraphId, 'new-math');
  assert.equal(merged.progress.scrollTop, 420);
  assert.equal(merged.answers[0].paragraphId, 'new-math');
  assert.deepEqual(merged.answers[0].citations.map(c => [c.paragraphId, c.page]), [['new-math', 4], ['new-following', 4]]);
  assert.equal(merged.answers[0].selectedText, 'E = x + y');
  assert.equal(merged.paragraphs[0].translation, null, 'a changed display source needs a new alignment rather than reusing stale sentence IDs');
  assert.equal(merged.archivedTranslations[0].paragraphId, 'old-math');
});

test('translation presets select explicit models and do not accept arbitrary model overrides', () => {
  assert.deepEqual(resolveTranslationSettings(), { translationPreset: 'fast', model: 'gpt-6-luna', reasoningEffort: 'low', contextChars: 12000, contextItems: 12 });
  assert.equal(resolveTranslationSettings({ translationPreset: 'balanced', model: 'ignored', reasoningEffort: 'ultra' }).model, 'gpt-6.1-sol');
  assert.equal(resolveTranslationSettings({ translationPreset: 'balanced', reasoningEffort: 'ultra' }).reasoningEffort, 'low');
  assert.equal(resolveTranslationSettings({ translationPreset: 'careful' }).reasoningEffort, 'medium');
  assert.throws(() => resolveTranslationSettings({ translationPreset: 'unknown' }), error => error.status === 400);
});

async function fixture(t, options = {}) {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtimeRoot, 'settings-test-'));
  const ids = ['1234567890abcdef1234', 'abcdef1234567890abcd'];
  for (const id of ids) {
    const dir = path.join(root, 'documents', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(document(id, [paragraph('p1', 'The method may improve accuracy.')])));
  }
  if (options.history) await fs.writeFile(path.join(root, 'jobs.json'), JSON.stringify(options.history));
  const prepareResources = async (doc, { documentDir }) => ({
    fingerprint: 'source-' + doc.id, summary: 'Source-only settings test paper.',
    manifestPath: path.join(documentDir, 'manifest.json'), sourcePath: path.join(documentDir, 'source.md'),
    paragraphsPath: path.join(documentDir, 'paragraphs.jsonl'), footnotesPath: path.join(documentDir, 'footnotes.jsonl'),
    pdfPath: path.join(documentDir, 'original.pdf'),
  });
  const app = await startReader({ port: 0, dataRoot: root, codexProbe: async () => ({ available: true, authenticated: true, queueAvailable: false }), prepareResources, ...options });
  t.after(async () => {
    options.release?.();
    await app.close();
    const relative = path.relative(runtimeRoot, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup stays inside the generated test runtime directory');
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, root, ids, request };
}

async function waitFor(predicate, message = 'test condition timed out') {
  for (let i = 0; i < 200; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('settings HTTP endpoints persist a preset and reject invalid changes without losing current settings', async t => {
  const { root, request } = await fixture(t, { codexRun: async () => { throw new Error('this test must not invoke Codex'); } });
  const initial = await request('/api/settings');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.settings.translationPreset, 'fast');
  assert.equal(initial.body.execution, 'persistent-per-paper');
  assert.deepEqual(initial.body.presets.map(p => p.id), ['fast', 'balanced', 'careful']);
  const update = await request('/api/settings', { translationPreset: 'balanced' });
  assert.equal(update.status, 200);
  assert.equal(update.body.settings.model, 'gpt-6.1-sol');
  assert.equal(update.body.settings.reasoningEffort, 'low');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).translationPreset, 'balanced');
  assert.equal((await request('/api/settings', { translationPreset: 'not-a-preset' })).status, 400);
  assert.equal((await request('/api/settings')).body.settings.translationPreset, 'balanced');
});

test('Codex workers receive explicit speed settings and queued jobs retain their creation snapshot', async t => {
  let releaseFirst;
  const holdFirst = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  let registrations = 0;
  const { ids, request } = await fixture(t, {
    release: releaseFirst,
    sessionBridge: {
      createSession: async () => {
        registrations++;
        return { threadId: `fake-paper-session-${registrations}`, turnId: `registered-${registrations}`, result: '登记完成' };
      },
      continueSession: async options => {
        assert.ok(options.schema?.properties.translations);
        calls.push({ model: options.model, reasoningEffort: options.reasoningEffort });
        const callNumber = calls.length, turnId = `settings-turn-${callNumber}`;
        await options.onProgress?.({ threadId: options.threadId, turnId, usage: { input_tokens: 50, output_tokens: 20 } });
        if (callNumber === 1) await holdFirst;
        return { threadId: options.threadId, turnId, result: { translations: [{ paragraphId: 'p1', text: '该方法可能提高精度。', alignments: [{ sourceIds: ['p1-s1'], targetText: '该方法可能提高精度。' }], notes: [] }] } };
      },
      readSession: async () => ({ turns: [], nextCursor: null }),
    },
  });
  const first = await request(`/api/documents/${ids[0]}/translate`, { paragraphIds: ['p1'] });
  assert.equal(first.status, 202);
  await waitFor(() => calls.length === 1);
  await request('/api/settings', { translationPreset: 'balanced' });
  const second = await request(`/api/documents/${ids[1]}/translate`, { paragraphIds: ['p1'] });
  assert.equal(second.status, 202);
  assert.equal((await request('/api/jobs/' + second.body.jobId)).body.status, 'queued');
  await request('/api/settings', { translationPreset: 'careful' });
  releaseFirst();
  for (const id of [first.body.jobId, second.body.jobId]) {
    const job = await waitFor(async () => {
      const result = (await request('/api/jobs/' + id)).body;
      return ['completed', 'failed'].includes(result.status) ? result : null;
    });
    assert.equal(job.status, 'completed', job.error);
  }
  assert.deepEqual(calls, [{ model: 'gpt-6-luna', reasoningEffort: 'low' }, { model: 'gpt-6.1-sol', reasoningEffort: 'low' }]);
  assert.equal(registrations, 2);
  const history = await request('/api/jobs');
  assert.equal(history.status, 200);
  assert.equal(history.body.jobs.length, 2);
  assert.equal(history.body.jobs[0].id, second.body.jobId);
  for (const [index, model] of ['gpt-6.1-sol', 'gpt-6-luna'].entries()) {
    assert.equal(history.body.jobs[index].model, model);
    assert.equal(history.body.jobs[index].reasoningEffort, 'low');
    assert.equal(history.body.jobs[index].status, 'completed');
    assert.ok(Number.isFinite(history.body.jobs[index].elapsedMs));
    assert.deepEqual(history.body.jobs[index].usage, { input_tokens: 50, output_tokens: 20 });
    assert.ok(!Object.hasOwn(history.body.jobs[index], 'controller'));
  }
  assert.equal((await request('/api/settings')).body.settings.translationPreset, 'careful');
});

test('job history survives service restart while unfinished work is reported as interrupted', async t => {
  const history = [
    { id: '11111111-1111-1111-1111-111111111111', type: 'translate', documentId: '1234567890abcdef1234', status: 'completed', model: 'gpt-6-luna', reasoningEffort: 'low', result: { translated: 1 } },
    { id: '22222222-2222-2222-2222-222222222222', type: 'translate', documentId: '1234567890abcdef1234', status: 'running' },
  ];
  const { request } = await fixture(t, { history, codexRun: async () => { throw new Error('restoring history must not invoke Codex'); } });
  const result = await request('/api/jobs');
  assert.equal(result.status, 200);
  const completed = result.body.jobs.find(j => j.id === history[0].id);
  const interrupted = result.body.jobs.find(j => j.id === history[1].id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.translated, 1);
  assert.equal(completed.model, 'gpt-6-luna');
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error, /服务已重启/);
});

test('App-owned queued translations preserve requested settings without claiming an unverified actual model', async t => {
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let captured;
  const { root, ids, request } = await fixture(t, {
    sessionBridge: {
      createSession: async () => { throw new Error('an App-owned paper thread must not be recreated'); },
      continueSession: async options => {
        captured = { model: options.model, reasoningEffort: options.reasoningEffort };
        assert.equal(options.threadId, threadId);
        assert.ok(options.schema?.properties.translations);
        await options.onProgress?.({ threadId, turnId: 'queued-app-turn', mode: 'queue-owner', configurationSource: 'thread', model: null, reasoningEffort: null });
        return { threadId, turnId: 'queued-app-turn', mode: 'queue-owner', result: { translations: [{ paragraphId: 'p1', text: '该方法可能提高精度。', alignments: [{ sourceIds: ['p1-s1'], targetText: '该方法可能提高精度。' }], notes: [] }] } };
      },
      readSession: async () => ({ turns: [], nextCursor: null }),
    },
  });
  const docFile = path.join(root, 'documents', ids[0], 'document.json');
  const source = JSON.parse(await fs.readFile(docFile, 'utf8'));
  source.session = { status: 'ready', threadId, fingerprint: 'source-' + ids[0], managedTurns: [] };
  await fs.writeFile(docFile, JSON.stringify(source));
  const queued = await request(`/api/documents/${ids[0]}/translate`, { paragraphIds: ['p1'] });
  assert.equal(queued.status, 202);
  const job = await waitFor(async () => {
    const result = (await request('/api/jobs/' + queued.body.jobId)).body;
    return ['completed', 'failed'].includes(result.status) ? result : null;
  });
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(captured, { model: 'gpt-6-luna', reasoningEffort: 'low' });
  assert.equal(job.requestedModel, 'gpt-6-luna');
  assert.equal(job.requestedReasoningEffort, 'low');
  assert.equal(job.model, null, 'an App-owned queue cannot prove which model the owner actually used');
  assert.equal(job.reasoningEffort, null);
  assert.equal(job.executionMode, 'queue-owner');
  assert.equal(job.configurationSource, 'thread');
  const saved = (await request('/api/documents/' + ids[0])).body.document;
  assert.equal(saved.paragraphs[0].translation.text, '该方法可能提高精度。');
  assert.equal(saved.paragraphs[0].translation.model, null, 'saved translations must not be falsely labelled Luna');
  assert.equal(saved.paragraphs[0].translation.reasoningEffort, null);
  assert.equal(saved.paragraphs[0].translation.configurationSource, 'thread');
  const history = (await request('/api/jobs')).body.jobs.find(item => item.id === job.id);
  assert.equal(history.requestedModel, 'gpt-6-luna');
  assert.equal(history.model, null);
  assert.equal(history.executionMode, 'queue-owner');
});

test('cancelling an App-owned queue reports stopped waiting without claiming the submitted turn was retracted', async t => {
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
  let submitted = false, stopObserved = false;
  const { root, ids, request } = await fixture(t, {
    sessionBridge: {
      createSession: async () => { throw new Error('the existing App-owned paper thread must be reused'); },
      continueSession: async options => {
        await options.onProgress?.({ threadId, turnId: 'held-app-turn', mode: 'queue-owner', configurationSource: 'thread', model: null, reasoningEffort: null });
        return new Promise((resolve, reject) => {
          const stop = () => { stopObserved = true; options.signal.removeEventListener('abort', stop); reject(Object.assign(new Error('停止等待已提交的会话任务。'), { code: 'ABORTED' })); };
          options.signal.addEventListener('abort', stop, { once: true });
          submitted = true;
          if (options.signal.aborted) stop();
        });
      },
      readSession: async () => ({ turns: [], nextCursor: null }),
    },
  });
  const docFile = path.join(root, 'documents', ids[0], 'document.json');
  const source = JSON.parse(await fs.readFile(docFile, 'utf8'));
  source.session = { status: 'ready', threadId, fingerprint: 'source-' + ids[0], managedTurns: [] };
  await fs.writeFile(docFile, JSON.stringify(source));
  const queued = await request(`/api/documents/${ids[0]}/translate`, { paragraphIds: ['p1'] });
  assert.equal(queued.status, 202);
  await waitFor(() => submitted);
  const running = (await request('/api/jobs/' + queued.body.jobId)).body;
  assert.equal(running.executionMode, 'queue-owner');
  const cancelled = await request('/api/jobs/' + queued.body.jobId + '/cancel', {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.match(cancelled.body.message, /停止等待/);
  assert.match(cancelled.body.message, /仍可能继续完成/);
  assert.doesNotMatch(cancelled.body.message, /已撤回|已中断.*Codex|Codex.*已取消/);
  await waitFor(() => stopObserved);
  const saved = (await request('/api/documents/' + ids[0])).body.document;
  assert.equal(saved.paragraphs[0].translation, null, 'no unfinished or unverified queued result is saved');
  assert.equal((await request('/api/jobs/' + queued.body.jobId)).body.status, 'cancelled');
});
