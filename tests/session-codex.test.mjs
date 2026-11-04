import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionBridge, normalizeSessionTurn } from '../lib/session-codex.mjs';

const threadId = '12345678-1234-1234-1234-123456789012';
const turnId = '87654321-4321-4321-4321-210987654321';
const workspace = process.cwd();
const answerSchema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };

function fakeClient({ text = '已登记。', active = false, unbound = false, early = false, hold = false, fail = false, conflict = false, projects, history, onRequest } = {}) {
  const client = new EventEmitter();
  client.mode = 'durable-stdio';
  client.calls = [];
  client.closed = false;
  client.close = async () => { client.closed = true; };
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    await onRequest?.(method, params);
    if (method === 'project/list') return projects ? projects(params) : { data: [{ id: 'existing-project', roots: [{ path: workspace }] }], nextCursor: null };
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/name/set') return {};
    if (method === 'thread/read') return { thread: { id: threadId, name: '论文会话', projectId: unbound ? null : 'existing-project', status: { type: active ? 'active' : 'notLoaded' } } };
    if (method === 'thread/metadata/update') return { thread: { id: threadId, projectId: params.projectId } };
    if (method === 'thread/resume') { if (conflict) throw new Error(`thread ${threadId} already has an active writer`); return { thread: { id: threadId, status: { type: 'idle' } } }; }
    if (method === 'thread/turns/list') return typeof history === 'function' ? history(params) : history || { data: [], nextCursor: null };
    if (method === 'turn/interrupt') return {};
    if (method === 'turn/start') {
      const finish = () => {
        if (hold) return;
        client.emit('notification', 'item/completed', { threadId, turnId, item: { id: 'final-item', type: 'agentMessage', text, phase: 'final_answer' } });
        client.emit('notification', 'thread/tokenUsage/updated', { threadId, tokenUsage: { last: { inputTokens: 20, outputTokens: 6 } } });
        client.emit('notification', 'turn/completed', { threadId, turn: { id: turnId, status: fail ? 'failed' : 'completed', error: fail ? { message: 'test provider failure' } : null } });
      };
      if (early) finish(); else setImmediate(finish);
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  return client;
}

test('new persistent sessions bind the matching project and await thread-ID persistence before starting a turn', async () => {
  let threadSaved = false;
  const client = fakeClient({ onRequest: method => { if (method === 'turn/start') assert.ok(threadSaved, 'the new thread ID must already be saved'); } });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.createSession({
    workspace, title: '论文 A', prompt: '只在本轮登记的原始论文资料。', model: 'gpt-6-luna', reasoningEffort: 'low',
    onProgress: async value => { if (value.threadId && !value.turnId) { await new Promise(resolve => setTimeout(resolve, 5)); threadSaved = true; } },
  });
  const created = client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(created.ephemeral, false);
  assert.equal(created.historyMode, 'paginated');
  assert.equal(created.cwd, workspace);
  assert.equal(created.projectId, 'existing-project');
  assert.equal(created.model, 'gpt-6-luna');
  assert.equal(created.sandbox, 'read-only');
  assert.deepEqual(created.config, { web_search: 'live' });
  assert.equal(client.calls.find(c => c.method === 'thread/name/set').params.name, '论文 A');
  assert.equal(result.threadId, threadId);
  assert.equal(result.turnId, turnId);
  assert.equal(result.result, '已登记。');
  assert.equal(result.mode, 'durable-stdio');
  assert.equal(result.projectId, 'existing-project');
  assert.equal(client.closed, true);
});

test('project discovery follows pagination rather than creating a second project', async () => {
  const client = fakeClient({ projects: params => params.cursor ? { data: [{ id: 'project-page-2', roots: [{ path: workspace }] }] } : { data: [{ id: 'other', roots: [{ path: '/unrelated' }] }], nextCursor: 'next-page' } });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.createSession({ workspace, prompt: '登记。' });
  assert.equal(result.projectId, 'project-page-2');
  assert.equal(client.calls.filter(c => c.method === 'project/list').length, 2);
  assert.ok(!client.calls.some(c => c.method === 'project/create'));
});

test('continuations resume the same durable history and send only the new question with its structured format', async () => {
  const client = fakeClient({ text: '{"answer":"上一轮已登记的答案。"}' });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '请继续解释上一轮的定义。', schema: answerSchema, model: 'gpt-6.1-sol', reasoningEffort: 'low' });
  assert.equal(client.calls[0].method, 'thread/read');
  assert.equal(client.calls[1].method, 'thread/resume');
  assert.equal(client.calls[1].params.threadId, threadId);
  assert.equal(client.calls[1].params.excludeTurns, true);
  assert.deepEqual(client.calls[1].params.config, { web_search: 'live' }, 'resuming overrides any earlier thread search-disabled snapshot');
  assert.match(client.calls[1].params.developerInstructions, /-Encoding UTF8/, 'existing threads receive the UTF-8 reading guidance');
  assert.match(client.calls[1].params.developerInstructions, /encoding="utf-8"/);
  const turn = client.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.threadId, threadId);
  assert.equal(turn.input.length, 1);
  assert.equal(turn.input[0].type, 'text');
  assert.ok(turn.input[0].text.endsWith('\n\n请继续解释上一轮的定义。'));
  assert.equal(turn.model, 'gpt-6.1-sol');
  assert.equal(turn.effort, 'low');
  assert.deepEqual(turn.outputSchema, answerSchema);
  assert.deepEqual(result.result, { answer: '上一轮已登记的答案。' });
  assert.deepEqual(result.usage, { last: { inputTokens: 20, outputTokens: 6 } });
  assert.ok(!client.calls.some(c => c.method === 'thread/start'));
});

test('known active threads are not resumed or sent another turn', async () => {
  const client = fakeClient({ active: true });
  const bridge = createSessionBridge({ connect: async () => client });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '新问题。' }), error => error.code === 'SESSION_BUSY');
  assert.deepEqual(client.calls.map(c => c.method), ['thread/read']);
  assert.equal(client.closed, true);
});

test('continuing a legacy unbound paper thread repairs its existing project assignment through the protocol', async () => {
  const client = fakeClient({ unbound: true });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '继续阅读。' });
  assert.deepEqual(client.calls.map(c => c.method), ['thread/read', 'project/list', 'thread/metadata/update', 'thread/resume', 'turn/start']);
  assert.deepEqual(client.calls.find(c => c.method === 'thread/metadata/update').params, { threadId, projectId: 'existing-project' });
  assert.equal(result.threadId, threadId);
  assert.equal(result.projectId, 'existing-project');
  assert.ok(!client.calls.some(c => ['thread/start', 'project/create'].includes(c.method)));
});

test('stored history uses metadata and paginated reads without resuming a thread', async () => {
  const client = fakeClient({ history: { data: [{ id: turnId, startedAtMs: 1700000000123, status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '问题第一行。' }, { type: 'text', text: '第二行。' }] },
    { type: 'agentMessage', phase: 'commentary', text: '内部进度。' },
    { type: 'commandExecution', command: 'not a chat message' },
    { type: 'agentMessage', phase: 'final_answer', text: '可见回答。' },
  ] }], nextCursor: 'older-turns' } });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.readSession({ threadId, workspace, cursor: 'page-cursor', limit: 200 });
  assert.deepEqual(client.calls.map(c => c.method), ['thread/read', 'thread/turns/list']);
  assert.equal(client.calls[1].params.cursor, 'page-cursor');
  assert.equal(client.calls[1].params.limit, 100);
  assert.equal(client.calls[1].params.itemsView, 'full');
  assert.equal(result.title, '论文会话');
  assert.equal(result.nextCursor, 'older-turns');
  assert.equal(result.turns[0].userText, '问题第一行。\n第二行。');
  assert.equal(result.turns[0].assistantText, '可见回答。');
  assert.equal(result.turns[0].createdAt, '2023-11-14T22:13:20.123Z');
});

test('protocol events arriving before turn/start response are retained', async () => {
  const client = fakeClient({ early: true, text: '提前到达的结果。' });
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '新问题。' });
  assert.equal(result.result, '提前到达的结果。');
});

test('cancellation interrupts only the created turn and keeps its durable thread identifier', async () => {
  const client = fakeClient({ hold: true });
  const bridge = createSessionBridge({ connect: async () => client });
  const controller = new AbortController();
  const promise = bridge.continueSession({ threadId, workspace, prompt: '新问题。', signal: controller.signal, onProgress: value => { if (value.turnId) setTimeout(() => controller.abort(), 5); } });
  await assert.rejects(promise, error => error.code === 'ABORTED');
  const interrupted = client.calls.filter(c => c.method === 'turn/interrupt');
  assert.deepEqual(interrupted.map(c => c.params), [{ threadId, turnId }]);
  assert.ok(!client.calls.some(c => ['thread/delete', 'thread/archive'].includes(c.method)));
  assert.equal(client.closed, true);
});

test('cancelling during thread preparation cannot start a model turn afterwards', async () => {
  for (const cancelledMethod of ['thread/read', 'thread/resume']) {
    const controller = new AbortController();
    const client = fakeClient({ hold: true, onRequest: method => { if (method === cancelledMethod) controller.abort(); } });
    const bridge = createSessionBridge({ connect: async () => client });
    await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '取消前的新问题。', signal: controller.signal }), error => error.code === 'ABORTED');
    assert.ok(!client.calls.some(c => c.method === 'turn/start'), `cancel during ${cancelledMethod} must not create a billable turn`);
    assert.equal(client.closed, true);
  }
});

test('cancellation while turn/start is in flight awaits and saves its own turn ID before interrupting', async () => {
  let releaseStart;
  const startResponse = new Promise(resolve => { releaseStart = resolve; });
  let signalStart;
  const startSent = new Promise(resolve => { signalStart = resolve; });
  const controller = new AbortController();
  const saved = [];
  const client = fakeClient({ hold: true, onRequest: async method => { if (method === 'turn/start') { signalStart(); await startResponse; } } });
  const bridge = createSessionBridge({ connect: async () => client });
  const rejection = assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '在途的问题。', signal: controller.signal,
    onProgress: async value => { if (value.turnId) saved.push(value.turnId); },
  }), error => error.code === 'ABORTED');
  await startSent;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  const closedBeforeStartResponded = client.closed;
  releaseStart();
  await rejection;
  assert.equal(closedBeforeStartResponded, false, 'do not abandon a submitted start RPC before its resulting turn can be identified');
  assert.deepEqual(saved, [turnId]);
  assert.deepEqual(client.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params), [{ threadId, turnId }]);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(client.closed, true);
});

test('cancellation during turn-ID persistence cannot release the connection before the durable callback finishes', async () => {
  let releaseSave, signalSaving;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saving = new Promise(resolve => { signalSaving = resolve; });
  const controller = new AbortController();
  const client = fakeClient({ hold: true });
  const bridge = createSessionBridge({ connect: async () => client });
  let saved = false;
  const rejection = assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '保存编号期间取消。', signal: controller.signal,
    onProgress: async value => { if (value.turnId) { signalSaving(); await saveGate; saved = true; } },
  }), error => error.code === 'ABORTED');
  await saving;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  const closedBeforeSave = client.closed;
  const interruptedBeforeSave = client.calls.some(c => c.method === 'turn/interrupt');
  releaseSave();
  await rejection;
  assert.equal(closedBeforeSave, false);
  assert.equal(interruptedBeforeSave, false, 'finish persisting ownership before closing or interrupting its model turn');
  assert.equal(saved, true);
  assert.deepEqual(client.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params), [{ threadId, turnId }]);
  assert.equal(client.closed, true);
});

test('failed provider turns do not return a completed answer even when an item was received', async () => {
  const client = fakeClient({ fail: true });
  const bridge = createSessionBridge({ connect: async () => client });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '问题。' }), error => error.code === 'SESSION_TURN_FAILED');
});

test('schema results are validated before the bridge returns them', async () => {
  const client = fakeClient({ text: '{"unexpected":"not an answer"}' });
  const bridge = createSessionBridge({ connect: async () => client });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '问题。', schema: answerSchema }), error => error.code === 'CODEX_INVALID_RESULT');
});

test('invalid IDs and already-cancelled work cannot launch a session service', async () => {
  let connections = 0;
  const bridge = createSessionBridge({ connect: async () => { connections++; return fakeClient(); } });
  await assert.rejects(bridge.continueSession({ threadId: 'bad', prompt: '问题。' }), error => error.code === 'INVALID_THREAD_ID');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.createSession({ prompt: '问题。', signal: controller.signal }), error => error.code === 'ABORTED');
  assert.equal(connections, 0);
});

test('epoch-second and millisecond timestamps normalize to comparable ISO strings', () => {
  assert.equal(normalizeSessionTurn({ id: 'one', startedAt: 1700000000 }).createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(normalizeSessionTurn({ id: 'two', startedAtMs: 1700000000000 }).createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(normalizeSessionTurn({ id: 'three' }).createdAt, undefined);
});

test('an App-owned idle writer receives a queued request whose exact turn is tracked before accepting structured output', async () => {
  let queuedMessage = '', poll = 0, savedTurn = false;
  const ownTurn = 'cccccccc-1111-2222-3333-444444444444';
  const appTurn = { id: 'app-user-turn', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '用户在 App 中自己的问题。' }] }, { type: 'agentMessage', text: '不能错拿这个回答。', phase: 'final_answer' }] };
  const client = fakeClient({ conflict: true, history: () => {
    if (!queuedMessage) return { data: [appTurn] };
    poll++;
    if (poll > 1) assert.equal(savedTurn, true, 'the matching turn ID is persisted before its result is accepted');
    return { data: [appTurn, { id: ownTurn, status: poll === 1 ? 'inProgress' : 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: queuedMessage }] }, ...(poll === 1 ? [] : [{ type: 'agentMessage', phase: 'final_answer', text: '{"answer":"队列中的真实结果。"}' }])] }] };
  } });
  const progress = [];
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { queuedMessage = value.message; assert.equal(value.threadId, threadId); } });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '继续问答。', schema: answerSchema, model: 'gpt-6-luna', reasoningEffort: 'low', taskKind: 'ask', pollIntervalMs: 10,
    onProgress: async value => { progress.push(value); if (value.turnId) { await new Promise(resolve => setTimeout(resolve, 5)); savedTurn = true; } },
  });
  assert.match(queuedMessage, /^〔纸间任务:ask:[0-9a-f-]+〕/);
  assert.match(queuedMessage, /JSON Schema/);
  assert.equal(result.turnId, ownTurn);
  assert.deepEqual(result.result, { answer: '队列中的真实结果。' });
  assert.equal(result.mode, 'queue-owner');
  assert.equal(result.configurationSource, 'thread');
  assert.equal(result.model, null);
  assert.equal(result.reasoningEffort, null);
  assert.equal(result.webSearch, null);
  assert.equal(result.requestedWebSearch, 'live');
  assert.equal(result.searchConfigurationSource, 'thread-owner');
  assert.match(queuedMessage, /官方代码仓库/);
  assert.match(queuedMessage, /无法覆盖已有会话的工具配置/);
  assert.match(queuedMessage, /不得声称已经搜索/);
  assert.ok(progress.some(p => p.mode === 'queue-owner' && p.model === null && p.reasoningEffort === null));
  assert.ok(!client.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), 'fallback must not steal or interrupt the App writer');
});

test('an unavailable owner queue reports an actionable writer limitation without inventing a completed turn', async () => {
  const client = fakeClient({ conflict: true });
  const bridge = createSessionBridge({ connect: async () => client, queue: async () => { throw new Error('control socket unavailable'); } });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '问题。' }), error => error.code === 'SESSION_OWNED_BY_APP' && /关闭这篇论文的聊天标签/.test(error.message));
  assert.ok(!client.calls.some(c => c.method === 'turn/start'));
});

test('owner queue polling never substitutes another App turn and times out without repeating a submission', async () => {
  let queueCalls = 0;
  const client = fakeClient({ conflict: true, history: { data: [{ id: 'other', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '问题。' }] }, { type: 'agentMessage', text: '别的回答。' }] }] } });
  const bridge = createSessionBridge({ connect: async () => client, queue: async () => { queueCalls++; } });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '问题。', timeoutMs: 25, pollIntervalMs: 10 }), error => error.code === 'SESSION_QUEUE_TIMEOUT');
  assert.equal(queueCalls, 1);
});

test('cancelled queue waits retain their task-kind marker and never interrupt App work', async () => {
  const controller = new AbortController();
  let payload = '';
  const client = fakeClient({ conflict: true });
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { payload = value.message; controller.abort(); } });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '翻译。', taskKind: 'translate', signal: controller.signal }), error => error.code === 'ABORTED' && /仍可能继续完成/.test(error.message));
  assert.match(payload, /^〔纸间任务:translate:[0-9a-f-]+〕/);
  assert.ok(!client.calls.some(c => c.method === 'turn/interrupt'));
});

test('partially flushed App history may report interrupted or failed before the queued turn actually completes', async () => {
  let message = '', poll = 0, queueCalls = 0;
  const client = fakeClient({ conflict: true, history: () => {
    if (!message) return { data: [] };
    poll++;
    return { data: [{ id: turnId, status: poll === 1 ? 'interrupted' : poll === 2 ? 'failed' : 'completed', error: null,
      items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }, ...(poll < 3 ? [] : [{ type: 'agentMessage', phase: 'final_answer', text: '连接正常' }])] }] };
  } });
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { message = value.message; queueCalls++; } });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '连接测试。', pollIntervalMs: 10 });
  assert.equal(result.result, '连接正常');
  assert.equal(result.turnId, turnId);
  assert.equal(queueCalls, 1, 'a transient interrupted snapshot must not resubmit the prompt');
  assert.ok(poll >= 3);
});

test('an explicit persisted owner error is reported without waiting for the whole queue timeout', async () => {
  let message = '';
  const client = fakeClient({ conflict: true, history: () => ({ data: message ? [{ id: turnId, status: 'failed', error: { message: 'provider quota exceeded' }, items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }] }] : [] }) });
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { message = value.message; } });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '连接测试。', timeoutMs: 1000 }), error => error.code === 'SESSION_TURN_FAILED' && /quota exceeded/.test(error.message));
});

test('stable interrupted snapshots with synthetic completion metadata remain unconfirmed until the total timeout', async () => {
  let message = '', queueCalls = 0;
  const client = fakeClient({ conflict: true, history: () => ({ data: message ? [{ id: turnId, status: 'interrupted', completedAt: 1700000000, durationMs: 12000, error: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }] }] : [] }) });
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { message = value.message; queueCalls++; } });
  await assert.rejects(bridge.continueSession({ threadId, workspace, prompt: '连接测试。', timeoutMs: 35, pollIntervalMs: 10, terminalGraceMs: 0 }), error => error.code === 'SESSION_QUEUE_TIMEOUT');
  assert.equal(queueCalls, 1);
  assert.ok(!client.calls.some(c => c.method === 'turn/interrupt'));
});

test('registration and translation keep hosted search available for later questions but constrain the current task to local evidence', async () => {
  const registration = fakeClient();
  const registrationBridge = createSessionBridge({ connect: async () => registration });
  await registrationBridge.createSession({ workspace, prompt: '登记本地论文。', taskKind: 'registration' });
  assert.deepEqual(registration.calls.find(c => c.method === 'thread/start').params.config, { web_search: 'live' });
  assert.match(registration.calls.find(c => c.method === 'turn/start').params.input[0].text, /本轮仅登记.*不进行外部检索/);
  const translation = fakeClient();
  const translationBridge = createSessionBridge({ connect: async () => translation });
  await translationBridge.continueSession({ threadId, workspace, prompt: '翻译这段本地原文。', taskKind: 'translation' });
  const resumed = translation.calls.find(c => c.method === 'thread/resume').params;
  assert.deepEqual(resumed.config, { web_search: 'live' });
  assert.match(resumed.developerInstructions, /论文问答任务可以/);
  assert.match(translation.calls.find(c => c.method === 'turn/start').params.input[0].text, /本轮仅翻译指定原文.*不进行外部检索/);
  for (const client of [registration, translation]) {
    const turn = client.calls.find(c => c.method === 'turn/start').params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
    assert.equal(turn.approvalPolicy, 'never');
    assert.ok(!client.calls.some(c => /^config\/(value\/write|batchWrite)$/.test(c.method)), 'thread overrides never write the global config');
  }
});

test('question instructions prioritize primary external evidence without claiming unsupported browsing or broad network permissions', async () => {
  const client = fakeClient();
  const bridge = createSessionBridge({ connect: async () => client });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '请核对作者的官方实现。', taskKind: 'ask' });
  const instructions = client.calls.find(c => c.method === 'thread/resume').params.developerInstructions;
  for (const phrase of ['官方代码仓库', '补充材料', '代码版本', '论文原文', '外部证据', '辅助解释', '实际检索', 'Markdown 链接', '不可信', '不得声称已经搜索']) assert.ok(instructions.includes(phrase), phrase);
  assert.equal(result.webSearch, 'live');
  assert.equal(result.searchConfigurationSource, 'thread-config');
  assert.deepEqual(client.calls.find(c => c.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly' });
});

test('queued translation preserves its local-only instruction and does not pretend owner search settings were applied', async () => {
  let payload = '';
  const client = fakeClient({ conflict: true, history: () => ({ data: payload ? [{ id: turnId, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: payload }] }, { type: 'agentMessage', phase: 'final_answer', text: '译文。' }] }] : [] }) });
  const bridge = createSessionBridge({ connect: async () => client, queue: async value => { payload = value.message; } });
  const result = await bridge.continueSession({ threadId, workspace, prompt: '只译原文。', taskKind: 'translate' });
  assert.match(payload, /^〔纸间任务:translate:/);
  assert.match(payload, /不进行外部检索，不用外部事实补写/);
  assert.match(payload, /不能声称新工具配置已经生效/);
  assert.equal(result.webSearch, null);
  assert.equal(result.searchConfigurationSource, 'thread-owner');
});
