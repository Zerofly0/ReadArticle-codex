import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeReparsedDocument } from '../lib/settings.mjs';
import { buildContext, hash, validateAnswer, validateTranslation } from '../lib/reader.mjs';
import { startReader } from '../server.mjs';

const runtimeRoot = path.resolve('.reader-runtime');
const paragraph = (id, text, extra = {}) => ({ id, text, rawText: text, page: 1, kind: 'paragraph', sectionId: 'section', sentences: [{ id: `${id}-s1`, text }], translation: null, ...extra });
const document = (paragraphs, extra = {}) => ({ id: '1234567890abcdef1234', title: 'Reading revision paper', filename: 'paper.pdf', pageCount: 3, sections: [{ id: 'section', title: 'Method' }], paragraphs, assets: [], mathAssets: [], peripheralBlocks: [], ...extra });

test('unchanged paragraph translation migrates alignment IDs when reparse assigns new paragraph and sentence IDs', () => {
  const text = 'The method may improve accuracy. It does not guarantee convergence.';
  const old = paragraph('old-paragraph', text, { sentences: [{ id: 'old-s1', text: 'The method may improve accuracy.' }, { id: 'old-s2', text: 'It does not guarantee convergence.' }] });
  old.translation = validateTranslation(old, { paragraphId: old.id, text: '该方法可能提高精度，但不保证收敛。', alignments: [{ sourceIds: ['old-s1', 'old-s2'], targetText: '该方法可能提高精度，但不保证收敛。' }], notes: [] });
  const fresh = paragraph('new-paragraph', text, { sentences: [{ id: 'new-s1', text: 'The method may improve accuracy.' }, { id: 'new-s2', text: 'It does not guarantee convergence.' }] });
  const merged = mergeReparsedDocument(document([old]), document([fresh]));
  const saved = merged.paragraphs[0].translation;
  assert.ok(saved, 'the unchanged source must keep its existing translation');
  assert.deepEqual(saved.alignments[0].sourceIds, ['new-s1', 'new-s2']);
  assert.equal(saved.text, '该方法可能提高精度，但不保证收敛。');
  assert.equal(saved.sourceHash, hash(fresh.text));
  assert.equal(merged.reparse.keptTranslations, 1);
  assert.equal(merged.archivedTranslations.length, 0);
  assert.deepEqual(old.translation.alignments[0].sourceIds, ['old-s1', 'old-s2'], 'migration must not mutate the backed-up document');
});

function mathReparsePair() {
  const first = '⟦MATH_p1_1⟧', second = '⟦MATH_p1_2⟧';
  const rawText = 'Let E = x + y be the objective. The constraint is x > 0.';
  const original = paragraph('old-math', `Let ${first} be the objective. The constraint is ${second}.`, {
    rawText,
    sentences: [{ id: 'old-math-s1', text: `Let ${first} be the objective.` }, { id: 'old-math-s2', text: `The constraint is ${second}.` }],
  });
  original.translation = validateTranslation(original, {
    paragraphId: original.id,
    text: `令 ${first} 为目标。约束为 ${second}。`,
    alignments: [{ sourceIds: ['old-math-s1'], targetText: `令 ${first} 为目标。` }, { sourceIds: ['old-math-s2'], targetText: `约束为 ${second}。` }], notes: [],
  });
  const fresh = paragraph('new-math', `Let ${second} be the objective. The constraint is ${first}.`, {
    rawText,
    sentences: [{ id: 'new-math-s1', text: `Let ${second} be the objective.` }, { id: 'new-math-s2', text: `The constraint is ${first}.` }],
  });
  const oldAssets = [
    { id: 'energy-old', token: first, page: 1, rawText: 'E = x + y', sourceBox: { page: 1, x0: 100, y0: 100, x1: 165, y1: 116 }, url: '/old-energy.png' },
    { id: 'constraint-old', token: second, page: 1, rawText: 'x > 0', sourceBox: { page: 1, x0: 190, y0: 130, x1: 225, y1: 146 }, url: '/old-constraint.png' },
  ];
  const newAssets = [
    { ...oldAssets[1], id: 'constraint-new', token: first, url: '/new-constraint.png' },
    { ...oldAssets[0], id: 'energy-new', token: second, url: '/new-energy.png' },
  ];
  return { first, second, previous: document([original], { mathAssets: oldAssets }), fresh: document([fresh], { mathAssets: newAssets }) };
}

test('math token renumbering preserves verified translations without swapping the underlying formulas', () => {
  const { first, second, previous, fresh } = mathReparsePair();
  const merged = mergeReparsedDocument(previous, fresh);
  const saved = merged.paragraphs[0].translation;
  assert.ok(saved, 'unchanged source geometry and raw math must not trigger an unnecessary retranslation');
  assert.equal(saved.text, `令 ${second} 为目标。约束为 ${first}。`);
  assert.deepEqual(saved.alignments, [
    { sourceIds: ['new-math-s1'], targetText: `令 ${second} 为目标。` },
    { sourceIds: ['new-math-s2'], targetText: `约束为 ${first}。` },
  ]);
  assert.equal(saved.sourceHash, hash(fresh.paragraphs[0].text));
  assert.equal(merged.reparse.keptTranslations, 1);
  assert.equal(merged.archivedTranslations.length, 0);
  assert.equal(previous.paragraphs[0].translation.text, `令 ${first} 为目标。约束为 ${second}。`);
});

test('unmatched formula content or location changes archive the old translation rather than guessing a token correspondence', () => {
  for (const mismatch of ['rawText', 'sourceBox', 'page']) {
    const { previous, fresh } = mathReparsePair();
    const energy = fresh.mathAssets.find(m => m.rawText === 'E = x + y');
    if (mismatch === 'rawText') energy.rawText = 'E = x - y';
    if (mismatch === 'sourceBox') energy.sourceBox = { ...energy.sourceBox, x0: 350, x1: 415 };
    if (mismatch === 'page') { energy.page = 2; energy.sourceBox = { ...energy.sourceBox, page: 2 }; }
    const merged = mergeReparsedDocument(previous, fresh);
    assert.equal(merged.paragraphs[0].translation, null, mismatch);
    assert.equal(merged.reparse.keptTranslations, 0, mismatch);
    assert.equal(merged.archivedTranslations.length, 1, mismatch);
    assert.equal(merged.archivedTranslations[0].translation.text, previous.paragraphs[0].translation.text, mismatch);
  }
});

test('same-page academic footnotes enter source evidence while publication, header, and footer material stay excluded', () => {
  const doc = document([paragraph('body', 'The method uses the normalized loss described below.')], {
    peripheralBlocks: [
      { id: 'footnote-1', page: 1, kind: 'footnote', text: '1 Normalized loss divides the error by the sample count.', sourceBoxes: [{ page: 1, x0: 50, y0: 700, x1: 500, y1: 730 }] },
      { id: 'publication-1', page: 1, kind: 'publication', text: 'Normalized loss copyright 2026 Publisher. DOI: 10.1234/example' },
      { id: 'header-1', page: 1, kind: 'header', text: 'Normalized loss journal running title' },
      { id: 'footer-1', page: 1, kind: 'footer', text: 'Normalized loss 123' },
    ],
  });
  const context = buildContext(doc, ['body']);
  assert.ok(context.evidence.some(p => p.id === 'footnote-1'));
  for (const id of ['publication-1', 'header-1', 'footer-1']) assert.ok(!context.evidence.some(p => p.id === id), id);
  const answer = validateAnswer(doc, context, {
    answer: '脚注说明按样本数量归一化。',
    citations: [{ paragraphId: 'footnote-1', quote: 'divides the error by the sample count' }, { paragraphId: 'publication-1', quote: 'copyright 2026 Publisher' }],
    uncertainty: '',
  });
  assert.deepEqual(answer.citations, [{ paragraphId: 'footnote-1', page: 1, quote: 'divides the error by the sample count' }]);
  assert.match(answer.uncertainty, /部分引用/);
});

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('reading revision test job timed out');
}


const prepareResources = async (doc, { documentDir }) => ({
  fingerprint: 'source-' + doc.id, summary: 'Source evidence for ' + doc.title,
  manifestPath: path.join(documentDir, 'manifest.json'), sourcePath: path.join(documentDir, 'source.md'),
  paragraphsPath: path.join(documentDir, 'paragraphs.jsonl'), footnotesPath: path.join(documentDir, 'footnotes.jsonl'),
  pdfPath: path.join(documentDir, 'original.pdf'),
});
const codexProbe = async () => ({ available: true, authenticated: true, queueAvailable: false });
async function cleanupReader(app, root) {
  await app.close();
  const relative = path.relative(runtimeRoot, root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 2 });
}
function requestClient(app) {
  const request = async (route, body) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const completedJob = id => waitFor(async () => {
    const job = (await request('/api/jobs/' + id)).body;
    return ['failed', 'completed', 'cancelled'].includes(job.status) ? job : null;
  });
  return { request, completedJob };
}

test('each paper initializes once and continues its own thread without replaying four-turn prompts; all history is archived and paginated', async t => {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtimeRoot, 'reading-session-'));
  const id = '1234567890abcdef1234', otherId = 'abcdef1234567890abcd';
  const paragraphs = [
    paragraph('authors', 'Example University, A. Author', { kind: 'metadata' }),
    paragraph('heading', 'Method', { kind: 'heading' }),
    paragraph('body-1', 'The method minimizes the reconstruction error.'),
    paragraph('body-2', 'It may improve robustness under low-light conditions.', { page: 2 }),
  ];
  const archived = Array.from({ length: 150 }, (_, i) => ({
    id: 'archive-' + String(i).padStart(3, '0'), question: 'ARCHIVED_QUESTION_' + i,
    answer: 'ARCHIVED_ANSWER_' + i, createdAt: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
    citations: [], selectedText: '', paragraphId: null,
  }));
  for (const docId of [id, otherId]) {
    const dir = path.join(root, 'documents', docId); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(document(structuredClone(paragraphs), {
      id: docId, progress: { paragraphId: 'body-2', scrollTop: 250 }, answers: docId === id ? archived : [],
    })));
  }
  const registrations = [], calls = [], nativeTurns = new Map(), reads = [];
  const bridge = {
    createSession: async options => {
      const docId = [id, otherId].find(value => options.prompt.includes(value));
      assert.ok(docId, 'registration must identify its own evidence package');
      const threadId = 'paper-thread-' + docId;
      registrations.push({ docId, threadId, prompt: options.prompt });
      nativeTurns.set(threadId, []);
      await options.onProgress?.({ threadId });
      return { threadId, turnId: 'registered-' + docId, result: '登记完成' };
    },
    continueSession: async options => {
      const memory = nativeTurns.get(options.threadId);
      assert.ok(memory, 'continueSession must use an already registered paper thread');
      const entry = { threadId: options.threadId, prompt: options.prompt, model: options.model, reasoningEffort: options.reasoningEffort };
      calls.push(entry); memory.push(entry);
      options.onProgress?.({ threadId: options.threadId, usage: { input_tokens: 50, output_tokens: 20 } });
      return { threadId: options.threadId, turnId: 'answer-' + calls.length, result: '本轮根据论文解释可能性。[第2页·body-2]' };
    },
    readSession: async options => {
      reads.push(options);
      if (options.threadId !== 'paper-thread-' + id) return { turns: [], nextCursor: null };
      return options.cursor === 'native-page-2'
        ? { turns: [{ id: 'external-2', userText: '从Codex继续追问', assistantText: '外部继续回答。[第1页·body-1]', status: 'completed', createdAt: '2026-10-30T02:00:00Z' }], nextCursor: null }
        : { turns: [{ id: 'registered-' + id, userText: 'registration', assistantText: '登记完成', status: 'completed' }, { id: 'external-1', userText: '从Codex打开后的问题', assistantText: '外部回答。[第2页·body-2]', status: 'completed', createdAt: '2026-10-30T01:00:00Z' }], nextCursor: 'native-page-2' };
    },
  };
  const app = await startReader({ port: 0, dataRoot: root, codexProbe, sessionBridge: bridge, prepareResources });
  t.after(() => cleanupReader(app, root));
  const { request, completedJob } = requestClient(app);
  const ask = async (docId, question, extra = {}) => {
    const queued = await request('/api/documents/' + docId + '/ask', { question, target: 'reader', ...extra });
    assert.equal(queued.status, 202, queued.body.error);
    const job = await completedJob(queued.body.jobId);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.model, 'gpt-6-luna'); assert.equal(job.reasoningEffort, 'low');
    assert.ok(Number.isFinite(job.elapsedMs) && job.elapsedMs >= 0);
    return job;
  };
  await ask(id, '请解释这里的鲁棒性。');
  await ask(id, '这里的 It 指代什么？');
  await ask(id, '解释选中句。', { paragraphId: 'body-2', selectedText: 'It may improve robustness' });
  await ask(otherId, '请先概括另一篇论文。', { target: 'thread' });
  assert.equal(registrations.length, 2);
  assert.notEqual(registrations[0].threadId, registrations[1].threadId);
  assert.deepEqual(calls.map(call => call.threadId), ['paper-thread-' + id, 'paper-thread-' + id, 'paper-thread-' + id, 'paper-thread-' + otherId]);
  assert.equal(nativeTurns.get('paper-thread-' + id).length, 3);
  assert.match(calls[0].prompt, /用户未选择段落/);
  assert.match(calls[2].prompt, /选中段落 ID：body-2/);
  assert.match(calls[2].prompt, /It may improve robustness/);
  assert.ok(!calls[1].prompt.includes('请解释这里的鲁棒性。'), 'the prior user turn belongs to the native session, not a rebuilt prompt');
  assert.ok(calls.every(call => !call.prompt.includes('ARCHIVED_QUESTION_') && !call.prompt.includes('近期阅读器问答')));
  assert.ok(registrations.every(registration => registration.prompt.includes('manifest.json') && !registration.prompt.includes(paragraphs[2].text)));
  let saved = (await request('/api/documents/' + id)).body.document;
  assert.equal(saved.answers.length, 153, 'archive size must exceed the previous answer caps');
  assert.equal(saved.answers[150].paragraphId, null);
  assert.equal(saved.answers[150].selectedText, '');
  assert.equal(saved.answers[152].paragraphId, 'body-2');
  assert.equal(saved.answers[152].selectedText, 'It may improve robustness');
  assert.equal(saved.session.threadId, 'paper-thread-' + id);
  assert.equal((await request('/api/documents/' + otherId)).body.document.session.threadId, 'paper-thread-' + otherId);

  const all = [];
  let cursor, firstPage = true;
  do {
    const query = '?limit=40' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const page = await request('/api/documents/' + id + '/session/history' + query);
    assert.equal(page.status, 200, page.body.error);
    assert.equal(page.body.total, 310, 'two external Codex turns are synchronized exactly once');
    assert.ok(page.body.messages.length <= 40);
    if (firstPage) { assert.equal(page.body.hasMore, true); firstPage = false; }
    all.unshift(...page.body.messages);
    cursor = page.body.nextCursor;
    if (!page.body.hasMore) break;
  } while (cursor);
  assert.equal(all.length, 310);
  assert.equal(new Set(all.map(message => message.id)).size, 310, 'pagination must not duplicate or omit archived messages');
  assert.ok(all.some(message => message.text === 'ARCHIVED_QUESTION_0'));
  assert.ok(all.some(message => message.text === '从Codex继续追问'));
  saved = (await request('/api/documents/' + id)).body.document;
  assert.equal(saved.answers.length, 155);
  assert.ok(reads.some(read => read.cursor === 'native-page-2'));
  assert.equal(registrations.length, 2, 'history reads must not reinitialize Codex');
});

test('same-paper questions wait for its active turn while another paper can answer independently', async t => {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtimeRoot, 'reader-session-priority-'));
  const id = '1234567890abcdef1234', otherId = 'abcdef1234567890abcd';
  for (const docId of [id, otherId]) {
    const dir = path.join(root, 'documents', docId); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(document([paragraph('p1', 'The method may improve accuracy.')], { id: docId, answers: [] })));
  }
  let releaseTranslation, releaseQuestion;
  const holdTranslation = new Promise(resolve => { releaseTranslation = resolve; });
  const holdQuestion = new Promise(resolve => { releaseQuestion = resolve; });
  const order = [], registrations = [];
  let questionCalls = 0;
  const bridge = {
    createSession: async options => {
      const docId = [id, otherId].find(value => options.prompt.includes(value));
      assert.ok(docId);
      const threadId = 'paper-thread-' + docId; registrations.push(threadId);
      return { threadId, turnId: 'registered-' + threadId, result: '登记完成' };
    },
    continueSession: async options => {
      if (options.schema?.properties.translations) {
        order.push('translation-start');
        await holdTranslation;
        order.push('translation-end');
        return { threadId: options.threadId, turnId: 'translation-1', result: { translations: [{ paragraphId: 'p1', text: '该方法可能提高精度。', alignments: [{ sourceIds: ['p1-s1'], targetText: '该方法可能提高精度。' }], notes: [] }] } };
      }
      if (options.threadId === 'paper-thread-' + otherId) {
        order.push('other-paper-ask');
        return { threadId: options.threadId, turnId: 'other-answer', result: '另一篇论文的回答。[第1页·p1]' };
      }
      questionCalls++; order.push('same-paper-ask');
      await holdQuestion;
      return { threadId: options.threadId, turnId: 'answer-1', result: '这里的 may 表示可能性。[第1页·p1]' };
    },
    readSession: async () => ({ turns: [], nextCursor: null }),
  };
  const app = await startReader({ port: 0, dataRoot: root, codexProbe, sessionBridge: bridge, prepareResources });
  t.after(async () => { releaseQuestion(); releaseTranslation(); await cleanupReader(app, root); });
  const { request, completedJob } = requestClient(app);
  const translation = await request('/api/documents/' + id + '/translate', { paragraphIds: ['p1'] });
  assert.equal(translation.status, 202);
  await waitFor(() => order.includes('translation-start'));
  const question = '这里的 may 表示什么？';
  const asking = await request('/api/documents/' + id + '/ask', { paragraphId: 'p1', question, target: 'reader' });
  assert.equal(asking.status, 202);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(questionCalls, 0, 'an active persistent turn cannot be bypassed by a same-paper question');
  const other = await request('/api/documents/' + otherId + '/ask', { paragraphId: 'p1', question: '另一个问题' });
  assert.equal((await completedJob(other.body.jobId)).status, 'completed');
  assert.deepEqual(order, ['translation-start', 'other-paper-ask']);
  const overlapping = await request('/api/documents/' + id + '/ask', { paragraphId: 'p1', question: '另一条同时的问题。' });
  assert.equal(overlapping.status, 409);
  releaseTranslation();
  await waitFor(() => questionCalls === 1);
  assert.deepEqual(order, ['translation-start', 'other-paper-ask', 'translation-end', 'same-paper-ask']);
  releaseQuestion();
  const finished = await completedJob(asking.body.jobId);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.question, question);
  assert.equal((await completedJob(translation.body.jobId)).status, 'completed');
  const saved = (await request('/api/documents/' + id)).body.document;
  assert.equal(saved.answers.length, 1);
  assert.equal(saved.answers[0].question, question);
  assert.equal(new Set(registrations).size, 2);
  assert.equal(registrations.length, 2);
});

for (const searchState of [
  { name: 'live search configured on the thread', mode: 'durable-stdio', webSearch: 'live', searchConfigurationSource: 'thread-config' },
  { name: 'App-owned queue with unknown actual search capability', mode: 'queue-owner', webSearch: null, searchConfigurationSource: 'thread-owner' },
]) {
  test('existing paper research preserves source links and reports ' + searchState.name, async t => {
    await fs.mkdir(runtimeRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(runtimeRoot, 'reader-research-'));
    const id = '1234567890abcdef1234', threadId = 'aaaaaaaa-bbbb-cccc-dddd-123456789012';
    const dir = path.join(root, 'documents', id); await fs.mkdir(dir, { recursive: true });
    const fullPaperSentinel = 'FULL_PAPER_CONTENT_MUST_NOT_BE_REPLAYED_';
    const doc = document([
      paragraph('p-source', 'The method uses the published implementation.', { page: 2 }),
      paragraph('p-long', fullPaperSentinel.repeat(1000), { page: 3 }),
    ], { id, answers: [{ id: 'old-answer', question: 'OLD_PRIVATE_QUESTION', answer: 'OLD_PRIVATE_ANSWER' }], session: { status: 'ready', threadId, fingerprint: 'source-' + id, managedTurns: [] } });
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(doc));
    const markdown = '论文的实现描述见 [第2页·p-source]。外部细节参见 [作者源码（commit abc123）](https://github.com/example-author/project/blob/abc123/src/denoise.py#L30)。这段源码说明仅作为补充解释。';
    const calls = [];
    const bridge = {
      createSession: async () => { throw new Error('research must continue the existing paper thread without reregistering it'); },
      continueSession: async options => {
        calls.push(options);
        assert.equal(options.threadId, threadId);
        assert.equal(options.schema, undefined, 'research answers remain normal readable Markdown');
        await options.onProgress?.({ threadId, turnId: 'research-answer', mode: searchState.mode, webSearch: searchState.webSearch, requestedWebSearch: 'live', searchConfigurationSource: searchState.searchConfigurationSource });
        return { threadId, turnId: 'research-answer', result: markdown };
      },
      readSession: async () => ({ turns: [], nextCursor: null }),
    };
    const app = await startReader({ port: 0, dataRoot: root, codexProbe, sessionBridge: bridge, prepareResources });
    t.after(() => cleanupReader(app, root));
    const { request, completedJob } = requestClient(app);
    const queued = await request('/api/documents/' + id + '/ask', { question: '请查官方源码与补充材料，解释对应实现。', paragraphId: 'p-source', selectedText: 'the published implementation' });
    assert.equal(queued.status, 202, queued.body.error);
    const job = await completedJob(queued.body.jobId);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(calls.length, 1);
    const prompt = calls[0].prompt;
    assert.match(prompt, /主动使用.*网页搜索.*打开工具/);
    assert.match(prompt, /核对仓库与作者\/论文项目页的关联/);
    assert.match(prompt, /commit\/tag/);
    assert.doesNotMatch(prompt, /不要编辑文件或联网/);
    assert.ok(!prompt.includes(fullPaperSentinel));
    assert.ok(!prompt.includes('OLD_PRIVATE_QUESTION') && !prompt.includes('OLD_PRIVATE_ANSWER'));
    assert.equal(job.result.answer, markdown, 'external Markdown source links must survive local citation validation');
    assert.equal(job.researchPolicyVersion, 'research-v1');
    assert.equal(job.webSearch, searchState.webSearch, 'unknown App-owner search must remain null, not falsely enabled');
    assert.equal(job.requestedWebSearch, 'live');
    assert.equal(job.searchConfigurationSource, searchState.searchConfigurationSource);
    assert.equal(job.executionMode, searchState.mode);
    const saved = (await request('/api/documents/' + id)).body.document;
    assert.equal(saved.session.threadId, threadId);
    assert.equal(saved.answers.length, 2);
    assert.equal(saved.answers[1].answer, markdown);
    assert.deepEqual(saved.answers[1].citations, [{ paragraphId: 'p-source', page: 2, quote: '' }]);
    assert.equal(saved.answers[1].researchPolicyVersion, 'research-v1');
    const historyJob = (await request('/api/jobs')).body.jobs.find(item => item.id === job.id);
    assert.equal(historyJob.webSearch, searchState.webSearch);
    assert.equal(historyJob.requestedWebSearch, 'live');
    assert.equal(historyJob.searchConfigurationSource, searchState.searchConfigurationSource);
  });
}

