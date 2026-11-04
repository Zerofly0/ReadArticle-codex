import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startReader } from '../server.mjs';

const runtimeRoot = path.resolve('.reader-runtime');
const probe = async () => ({ available: true, authenticated: true, queueAvailable: false });
const resources = async (doc, { documentDir }) => ({
  fingerprint: 'source-' + doc.id, summary: 'A source-only paper package.',
  manifestPath: path.join(documentDir, 'manifest.json'), sourcePath: path.join(documentDir, 'source.md'),
  paragraphsPath: path.join(documentDir, 'paragraphs.jsonl'), footnotesPath: path.join(documentDir, 'footnotes.jsonl'),
  pdfPath: path.join(documentDir, 'original.pdf'),
});
async function waitFor(predicate) {
  for (let i = 0; i < 300; i++) {
    const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('HTTP reading test timed out');
}
async function fixture(prefix, docs) {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtimeRoot, prefix));
  for (const doc of docs) {
    const dir = path.join(root, 'documents', doc.id); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(doc));
  }
  return root;
}
async function cleanup(app, root) {
  await app.close();
  const relative = path.relative(runtimeRoot, root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 2 });
}
function client(app) {
  const request = async (route, body, headers = {}) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const jobResult = id => waitFor(async () => {
    const response = await request('/api/jobs/' + id);
    return ['failed', 'completed', 'cancelled'].includes(response.body.status) ? response.body : null;
  });
  return { request, jobResult };
}

test('HTTP workflow uses one persistent paper session, caches translations and validates origins', async t => {
  const id = 'abcdef0123456789abcd';
  const doc = { id, title: 'Test source', filename: 'paper.pdf', pageCount: 1, sections: [{ id: 's', title: 'Abstract' }], paragraphs: [{ id: 'p1', page: 1, sectionId: 's', kind: 'paragraph', text: 'It may reduce error. It does not guarantee convergence.', sentences: [{ id: 's1', text: 'It may reduce error.' }, { id: 's2', text: 'It does not guarantee convergence.' }], translation: null }], assets: [] };
  const root = await fixture('http-test-', [doc]);
  let registrations = 0, translations = 0, asks = 0;
  const threadId = 'paper-session-' + id;
  const bridge = {
    createSession: async () => { registrations++; return { threadId, turnId: 'registration-1', result: '登记完成' }; },
    continueSession: async options => {
      assert.equal(options.threadId, threadId);
      options.onProgress?.({ threadId, usage: { input_tokens: 40, output_tokens: 20 } });
      if (options.schema?.properties.translations) {
        translations++;
        return { threadId, turnId: 'translation-' + translations, result: { translations: [{ paragraphId: 'p1', text: '它可能降低误差，但不保证收敛。', alignments: [{ sourceIds: ['s1', 's2'], targetText: '它可能降低误差，但不保证收敛。' }], notes: [] }] } };
      }
      asks++;
      return { threadId, turnId: 'ask-' + asks, result: '这里保留了可能性与否定。[第1页·p1]' };
    },
    readSession: async () => ({ turns: [], nextCursor: null }),
  };
  const app = await startReader({ port: 0, dataRoot: root, codexProbe: probe, sessionBridge: bridge, prepareResources: resources });
  t.after(() => cleanup(app, root));
  const { request, jobResult } = client(app);
  assert.equal((await request('/api/documents/' + id + '/progress', { paragraphId: 'p1' }, { Origin: 'https://example.com' })).status, 403);
  const queued = await request('/api/documents/' + id + '/translate', { paragraphIds: ['p1'] });
  assert.equal(queued.status, 202);
  assert.equal((await jobResult(queued.body.jobId)).status, 'completed');
  const saved = (await request('/api/documents/' + id)).body.document;
  assert.equal(saved.paragraphs[0].translation.status, 'aligned');
  assert.equal(saved.session.threadId, threadId);
  assert.equal(saved.session.status, 'ready');
  const cached = await request('/api/documents/' + id + '/translate', { paragraphIds: ['p1'] });
  assert.equal((await jobResult(cached.body.jobId)).result.cached, 1);
  assert.equal(translations, 1);
  const forced = await request('/api/documents/' + id + '/translate', { paragraphIds: ['p1'], force: true });
  assert.equal((await jobResult(forced.body.jobId)).status, 'completed');
  assert.equal(translations, 2);
  const progress = await request('/api/documents/' + id + '/progress', { paragraphId: 'p1', scrollTop: 120 });
  assert.equal(progress.status, 200);
  assert.equal((await request('/api/documents/' + id)).body.document.progress.scrollTop, 120);
  const ask = await request('/api/documents/' + id + '/ask', { paragraphId: 'p1', target: 'thread', question: 'Explain the claim.' });
  assert.equal(ask.status, 202);
  const answer = await jobResult(ask.body.jobId);
  assert.equal(answer.status, 'completed');
  assert.equal(answer.result.target, 'reader');
  assert.equal(registrations, 1);
  assert.equal(asks, 1);
});

test('same-paper questions wait for the active translation turn and run between translation batches', async t => {
  const id = '0123456789abcdef0123';
  const paragraphs = Array.from({ length: 4 }, (_, i) => ({ id: 'p' + (i + 1), page: 1, kind: 'paragraph', text: 'Test sentence ' + (i + 1) + '.', sentences: [{ id: 's' + (i + 1), text: 'Test sentence ' + (i + 1) + '.' }], translation: null }));
  const root = await fixture('priority-test-', [{ id, title: 'Paper', filename: 'paper.pdf', pageCount: 1, paragraphs, sections: [], assets: [] }]);
  let releaseTranslation, releaseQuestion;
  const holdTranslation = new Promise(resolve => { releaseTranslation = resolve; });
  const holdQuestion = new Promise(resolve => { releaseQuestion = resolve; });
  const order = [];
  let batches = 0, registrations = 0;
  const threadId = 'single-paper-thread';
  const bridge = {
    createSession: async () => { registrations++; return { threadId, turnId: 'registered', result: '登记完成' }; },
    continueSession: async options => {
      assert.equal(options.threadId, threadId);
      if (options.schema?.properties.translations) {
        batches++; order.push('translation-' + batches);
        if (batches === 1) await holdTranslation;
        const selected = JSON.parse(options.prompt.split('selected：').at(-1));
        return { threadId, turnId: 'translated-' + batches, result: { translations: selected.map(p => ({ paragraphId: p.id, text: '测试句 ' + p.id.slice(1) + '。', alignments: [{ sourceIds: p.sentences.map(s => s.id), targetText: '测试句 ' + p.id.slice(1) + '。' }], notes: [] })) } };
      }
      order.push('ask');
      await holdQuestion;
      return { threadId, turnId: 'answered', result: '解释测试句。[第1页·p1]' };
    },
    readSession: async () => ({ turns: [], nextCursor: null }),
  };
  const app = await startReader({ port: 0, dataRoot: root, codexProbe: probe, sessionBridge: bridge, prepareResources: resources });
  t.after(async () => { releaseTranslation(); releaseQuestion(); await cleanup(app, root); });
  const { request, jobResult } = client(app);
  const translation = await request('/api/documents/' + id + '/translate', { paragraphIds: paragraphs.map(p => p.id) });
  assert.equal(translation.status, 202);
  await waitFor(() => batches === 1);
  const question = await request('/api/documents/' + id + '/ask', { paragraphId: 'p1', target: 'thread', question: 'Explain it.' });
  assert.equal(question.status, 202);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(order, ['translation-1'], 'a persistent thread must not receive overlapping turns');
  assert.equal((await request('/api/documents/' + id + '/ask', { paragraphId: 'p1', question: 'Concurrent duplicate' })).status, 409);
  releaseTranslation();
  await waitFor(() => order.includes('ask'));
  assert.deepEqual(order, ['translation-1', 'ask']);
  assert.equal((await request('/api/jobs/' + translation.body.jobId)).body.status, 'running');
  releaseQuestion();
  assert.equal((await jobResult(question.body.jobId)).status, 'completed');
  assert.equal((await jobResult(translation.body.jobId)).status, 'completed');
  assert.deepEqual(order, ['translation-1', 'ask', 'translation-2']);
  assert.equal(registrations, 1);
});

