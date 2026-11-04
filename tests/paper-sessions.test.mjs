import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperSessions, historyPage, normalizeSessionAnswer, sessionAnswerPrompt } from '../lib/paper-sessions.mjs';
import { hash } from '../lib/reader.mjs';

function fixture() {
  const docs=new Map(['a','b'].map(id=>[id,{id,title:`Paper ${id}`,filename:`${id}.pdf`,paragraphs:[{id:'p-body',page:2,kind:'paragraph',text:'The method may reduce error.'}],answers:[]} ]));
  const calls=[];
  let turn=0;
  const bridge={
    async createSession(options){calls.push({type:'create',...options});const threadId=`thread-${options.title}`;await options.onProgress?.({threadId});return {threadId,turnId:`t-${++turn}`,result:'已登记。'};},
    async continueSession(options){calls.push({type:'continue',...options});return {threadId:options.threadId,turnId:`t-${++turn}`,result:'该方法可能降低误差。[第2页·p-body]'};},
    async readSession(){return {turns:[]};},
  };
  const resources=id=>({fingerprint:`source-${id}`,manifestPath:`/papers/${id}/manifest.json`,sourcePath:`/papers/${id}/source.md`,paragraphsPath:`/papers/${id}/paragraphs.jsonl`,footnotesPath:`/papers/${id}/footnotes.jsonl`,pdfPath:`/papers/${id}/original.pdf`,summary:`Paper ${id}`});
  const sessions=new PaperSessions({bridge,readDoc:async id=>structuredClone(docs.get(id)),mutateDoc:async(id,fn)=>{const d=structuredClone(docs.get(id));await fn(d);docs.set(id,d);return d;},documentDir:id=>`/papers/${id}`,prepareResources:async doc=>resources(doc.id)});
  return {docs,calls,bridge,sessions,resources};
}

test('each paper registers once, continues the same durable thread, and never shares another paper history',async()=>{
  const f=fixture();
  await f.sessions.prepare('a',{});
  await f.sessions.prepare('a',{});
  const first=await f.sessions.turn('a',{kind:'ask',prompt:'First question'});
  const second=await f.sessions.turn('a',{kind:'ask',prompt:'Follow-up only'});
  const other=await f.sessions.turn('b',{kind:'ask',prompt:'Other paper question'});
  assert.equal(f.calls.filter(c=>c.type==='create').length,2);
  assert.equal(first.threadId,second.threadId);
  assert.notEqual(first.threadId,other.threadId);
  assert.deepEqual(f.calls.filter(c=>c.type==='continue').map(c=>c.prompt),['First question','Follow-up only','Other paper question']);
  assert.equal(f.docs.get('a').session.managedTurns.length,3);
});

test('a registration failure retains its early thread ID and retries in that existing thread',async()=>{
  const f=fixture();
  f.bridge.createSession=async options=>{await options.onProgress({threadId:'retained-thread'});throw new Error('temporary failure');};
  await assert.rejects(f.sessions.prepare('a',{}),/temporary failure/);
  assert.equal(f.docs.get('a').session.threadId,'retained-thread');
  assert.equal(f.docs.get('a').session.status,'failed');
  const retry=await f.sessions.prepare('a',{});
  assert.equal(retry.session.threadId,'retained-thread');
  assert.equal(retry.session.status,'ready');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].type,'continue');
});

test('same-paper turns serialize while another paper can proceed; an aborted queued turn never runs',async()=>{
  const f=fixture();await f.sessions.prepare('a',{});await f.sessions.prepare('b',{});
  let release;const hold=new Promise(resolve=>{release=resolve;});
  const started=[];
  f.bridge.continueSession=async options=>{started.push(options.prompt);if(options.prompt==='held')await hold;return {threadId:options.threadId,turnId:options.prompt,result:'ok'};};
  const active=f.sessions.turn('a',{prompt:'held'});
  await new Promise(resolve=>setImmediate(resolve));
  const abort=new AbortController();
  const queued=f.sessions.turn('a',{prompt:'aborted',signal:abort.signal});
  const rejection=assert.rejects(queued,/已取消/);
  await f.sessions.turn('b',{prompt:'independent'});
  assert.deepEqual(started,['held','independent']);
  abort.abort();release();await active;await rejection;
  assert.ok(!started.includes('aborted'));
});

test('history keeps more than fifty rounds and paginates stably when a new round is appended',()=>{
  const doc={answers:Array.from({length:61},(_,i)=>({id:`a${i}`,question:`q${i}`,answer:`answer${i}`}))};
  const latest=historyPage(doc,{limit:30});
  assert.equal(latest.total,122);assert.equal(latest.messages.length,30);assert.equal(latest.hasMore,true);
  assert.equal(latest.messages.at(-1).text,'answer60');
  doc.answers.push({id:'new',question:'new question',answer:'new answer'});
  const older=historyPage(doc,{cursor:latest.nextCursor,limit:30});
  assert.equal(older.messages.at(-1).text,'answer45');
  assert.ok(!older.messages.some(m=>latest.messages.some(n=>n.id===m.id)));
  assert.throws(()=>historyPage(doc,{cursor:'unknown'}),/游标/);
});

test('App history sync skips managed registration and translation turns and imports user conversations once',async()=>{
  const f=fixture();await f.sessions.prepare('a',{});
  await f.sessions.turn('a',{kind:'translation',prompt:'internal translation'});
  f.bridge.readSession=async()=>({turns:[{id:'t-1',userText:'registration data',assistantText:'registered'},{id:'t-2',userText:'internal translation',assistantText:'translation JSON'},{id:'app-question',userText:'App里追问',assistantText:'论文说可能降低误差。[第2页·p-body]',createdAt:'2026-10-29T00:00:00.000Z',status:'completed'}]});
  await f.sessions.sync('a');await f.sessions.sync('a');
  const saved=f.docs.get('a');
  assert.equal(saved.answers.length,1);assert.equal(saved.answers[0].source,'codex-app');
  assert.equal(saved.answers[0].nativeTurnId,'app-question');assert.equal(saved.answers[0].citations[0].page,2);
  f.bridge.readSession=async()=>{throw new Error('offline');};
  assert.equal((await f.sessions.sync('a')).syncError,'offline');
  assert.equal(f.docs.get('a').answers.length,1);
});

test('short follow-up prompt points at persistent source without resending document or chat history',()=>{
  const f=fixture(),doc=f.docs.get('a');doc.answers=[{question:'old question',answer:'old answer'}];
  const prompt=sessionAnswerPrompt(doc,'这个结论有什么条件？',{resources:f.resources('a')});
  assert.match(prompt,/manifest\.json/);assert.doesNotMatch(prompt,/old question|old answer|The method may reduce error/);
  const selected=sessionAnswerPrompt(doc,'解释这一句',{resources:f.resources('a'),paragraphId:'p-body',selectedText:'The method may reduce error.'});
  assert.match(selected,/选中段落 ID：p-body/);assert.match(selected,/The method may reduce error/);
});

test('a completed reader answer recovers from Codex history after a crash before local archival',async()=>{
  const f=fixture();await f.sessions.prepare('a',{});
  f.docs.get('a').session.managedTurns.push({id:'finished-ask',kind:'ask',question:'友好的原问题',jobId:'job-before-crash',paragraphId:'p-body',selectedText:'选文'});
  f.bridge.readSession=async()=>({turns:[{id:'finished-ask',userText:'Internal generated question prompt',assistantText:'答案。[第2页·p-body]',status:'completed'}]});
  await f.sessions.sync('a');await f.sessions.sync('a');
  const answers=f.docs.get('a').answers;
  assert.equal(answers.length,1);assert.equal(answers[0].question,'友好的原问题');assert.equal(answers[0].jobId,'job-before-crash');assert.equal(answers[0].source,'reader-recovered');
});

test('an internal turn added while a history read is pending cannot leak into user chat',async()=>{
  const f=fixture();await f.sessions.prepare('a',{});
  let release;const hold=new Promise(resolve=>{release=resolve;});
  f.bridge.readSession=async()=>{await hold;return {turns:[{id:'new-translation',userText:'Internal translation prompt',assistantText:'Structured translation',status:'completed'}]};};
  const syncing=f.sessions.sync('a');
  await new Promise(resolve=>setImmediate(resolve));
  f.docs.get('a').session.managedTurns.push({id:'new-translation',kind:'translation'});
  release();await syncing;
  assert.equal(f.docs.get('a').answers.length,0);
});

test('queued messages completed after cancellation recover friendly asks while internal translation remains hidden',async()=>{
  const f=fixture();await f.sessions.prepare('a',{});
  const marker='〔纸间任务:ask:12345678-1234-1234-1234-123456789012〕';
  f.docs.get('a').session.managedRequests=[{marker,kind:'ask',question:'取消等待前的问题',selectedText:'原选文',paragraphId:'p-body'}];
  f.bridge.readSession=async()=>({turns:[
    {id:'late-ask',userText:marker+'\nLong internal prompt',assistantText:'仍已完成。[第2页·p-body]',status:'completed'},
    {id:'late-translation',userText:'〔纸间任务:translate:22345678-1234-1234-1234-123456789012〕\nInternal JSON request',assistantText:'{"translations":[]}',status:'completed'},
  ]});
  await f.sessions.sync('a');
  const answers=f.docs.get('a').answers;
  assert.equal(answers.length,1);assert.equal(answers[0].question,'取消等待前的问题');assert.equal(answers[0].selectedText,'原选文');
  assert.ok(!historyPage(f.docs.get('a')).messages.some(m=>m.text.includes('纸间任务')));
});

test('plain Markdown references verify both source ID and page while excluding publication blocks',()=>{
  const doc={paragraphs:[{id:'p-body',page:2,kind:'paragraph',text:'Source'}],peripheralBlocks:[{id:'p-foot',page:2,kind:'footnote',text:'Footnote'},{id:'p-pub',page:1,kind:'publication',text:'Copyright'}]};
  const answer=normalizeSessionAnswer(doc,'结论。[第2页·p-body] 脚注。[第2页·p-foot] 错页。[第1页·p-body] 出版。[第1页·p-pub]');
  assert.deepEqual(answer.citations.map(c=>c.paragraphId),['p-body','p-foot']);
  assert.doesNotMatch(answer.answer,/第1页/);assert.match(answer.uncertainty,/部分引用/);
});

test('a completed legacy translation recovers from paginated source-matching history without a model turn or chat leak', async () => {
  const f = fixture(), paragraphId = 'p-bb709bb660da';
  const text = 'It may reduce error. It does not guarantee convergence.';
  const existing = { id: 'p-aabbccddeeff', page: 2, kind: 'paragraph', text: 'Keep this source.', sentences: [{ id: 'p-aabbccddeeff-s1', text: 'Keep this source.' }], translation: { text: '用户已保存的译文。' } };
  f.docs.get('a').paragraphs = [{ id: paragraphId, page: 2, kind: 'paragraph', text, sentences: [{ id: paragraphId + '-s1', text: 'It may reduce error.' }, { id: paragraphId + '-s2', text: 'It does not guarantee convergence.' }], translation: null }, existing];
  await f.sessions.prepare('a', {});
  f.docs.get('a').session.managedTurns.push({ id: 'completed-unarchived-translation', kind: 'translation' });
  f.docs.get('a').session.managedRequests = [{ marker: 'preserve-request-marker', kind: 'translation' }];
  const output = { translations: [{ paragraphId, text: '它可能降低误差，但不保证收敛。', alignments: [{ sourceIds: [paragraphId + '-s1', paragraphId + '-s2'], targetText: '它可能降低误差，但不保证收敛。' }], notes: [] }] };
  const readCalls = [];
  f.bridge.readSession = async options => {
    readCalls.push(options);
    return options.cursor === 'older'
      ? { turns: [{ id: 'completed-unarchived-translation', status: 'completed', assistantText: JSON.stringify(output), userText: 'Internal translation request' }], nextCursor: null }
      : { turns: [{ id: 'unrelated-turn', status: 'completed', assistantText: 'ordinary answer' }], nextCursor: 'older' };
  };
  const before = f.calls.length;
  assert.deepEqual(await f.sessions.recoverTranslations('a', [paragraphId, existing.id]), { recovered: 1, turnIds: ['completed-unarchived-translation'] });
  assert.equal(readCalls.length, 2);
  assert.equal(f.calls.length, before, 'history recovery cannot create or continue a model turn');
  const saved = f.docs.get('a');
  const translation = saved.paragraphs[0].translation;
  assert.equal(translation.text, output.translations[0].text);
  assert.equal(translation.status, 'aligned');
  assert.equal(translation.source, 'codex-history');
  assert.equal(translation.nativeTurnId, 'completed-unarchived-translation');
  assert.equal(translation.model, null);
  assert.equal(translation.reasoningEffort, null);
  assert.equal(translation.configurationSource, 'thread');
  assert.equal(saved.paragraphs[1].translation.text, '用户已保存的译文。');
  assert.equal(saved.answers.length, 0, 'internal translation JSON must never become user chat');
  assert.equal(saved.session.managedRequests[0].marker, 'preserve-request-marker');
  assert.deepEqual(await f.sessions.recoverTranslations('a', [paragraphId]), { recovered: 0, turnIds: [] });
  assert.equal(readCalls.length, 2, 'already saved results need no second history scan');
});

test('translation recovery rejects stale source hashes, math loss, foreign sentence IDs and noncompleted turns', async () => {
  const f = fixture();
  const make = (id, text) => ({ id, text, page: 2, kind: 'paragraph', sentences: [{ id: id + '-s1', text }], translation: null });
  const paragraphs = [make('valid', 'Let ⟦MATH_m001⟧ be the objective.'), make('changed', 'This is the revised source.'), make('math-loss', 'Let ⟦MATH_m002⟧ be the constraint.'), make('wrong-sentence', 'The method may improve accuracy.')];
  f.docs.get('a').paragraphs = paragraphs;
  await f.sessions.prepare('a', {});
  const sourceHashes = Object.fromEntries(paragraphs.map(p => [p.id, hash(p.text)]));
  sourceHashes.changed = hash('This was the old source.');
  // A stale legacy field must not override the exact text-hash requirement.
  f.docs.get('a').paragraphs[1].sourceHash = sourceHashes.changed;
  f.docs.get('a').session.managedTurns.push({ id: 'candidate-result', kind: 'translation', paragraphIds: paragraphs.map(p => p.id), sourceHashes }, { id: 'interrupted-result', kind: 'translation', paragraphIds: ['changed'], sourceHashes: { changed: hash(paragraphs[1].text) } });
  const candidate = (id, text, sourceId = id + '-s1') => ({ paragraphId: id, text, alignments: [{ sourceIds: [sourceId], targetText: text }], notes: [] });
  let reads = 0;
  f.bridge.readSession = async () => {
    reads++;
    return { turns: [
      { id: 'candidate-result', status: 'completed', assistantText: JSON.stringify({ translations: [candidate('valid', '令 ⟦MATH_m001⟧ 为目标。'), candidate('changed', '旧译文不应该恢复。'), candidate('math-loss', '约束没有保留原式。'), candidate('wrong-sentence', '该方法可能提高精度。', 'another-paper-s1')] }) },
      { id: 'interrupted-result', status: 'interrupted', assistantText: JSON.stringify({ translations: [candidate('changed', '未完成的译文。')] }) },
      { id: 'foreign-unmanaged-result', status: 'completed', assistantText: JSON.stringify({ translations: [candidate('changed', '未登记来源的译文。')] }) },
    ], nextCursor: null };
  };
  assert.deepEqual(await f.sessions.recoverTranslations('a', paragraphs.map(p => p.id)), { recovered: 1, turnIds: ['candidate-result'] });
  assert.equal(f.docs.get('a').paragraphs[0].translation.text, '令 ⟦MATH_m001⟧ 为目标。');
  assert.ok(f.docs.get('a').paragraphs.slice(1).every(p => p.translation === null));
  f.docs.get('a').session.fingerprint = 'stale-registration';
  assert.deepEqual(await f.sessions.recoverTranslations('a', ['changed']), { recovered: 0, turnIds: [] });
  assert.equal(reads, 1, 'a different source package cannot reuse prior translation turns');
});

test('translation completed after cancellation before turn-ID discovery recovers from its durable request marker without resubmission', async () => {
  const f = fixture();
  const paragraphId = 'p-aabbccddeeff', text = 'This conclusion requires the stated conditions.';
  f.docs.get('a').paragraphs = [{ id: paragraphId, page: 2, kind: 'paragraph', text,
    sentences: [{ id: paragraphId + '-s1', text }], translation: null }];
  await f.sessions.prepare('a', {});
  const marker = '〔纸间任务:translate:12345678-1234-1234-1234-123456789012〕';
  f.docs.get('a').session.managedRequests = [{ marker, kind: 'translation', paragraphIds: [paragraphId], sourceHashes: { [paragraphId]: hash(text) }, jobId: 'cancelled-before-observation' }];
  const candidate = { paragraphId, text: '该结论要求满足所述条件。', alignments: [{ sourceIds: [paragraphId + '-s1'], targetText: '该结论要求满足所述条件。' }], notes: [] };
  let reads = 0;
  f.bridge.readSession = async () => { reads++; return { turns: [{ id: 'late-marker-translation', status: 'completed', userText: marker + '\nInternal translation request', assistantText: JSON.stringify({ translations: [candidate] }) }] }; };
  const before = f.calls.length;
  const options = { bridge: f.bridge, readDoc: f.sessions.readDoc, mutateDoc: f.sessions.mutateDoc, documentDir: f.sessions.documentDir, prepareResources: f.sessions.prepareResources };
  const restarted = new PaperSessions(options);
  assert.deepEqual(await restarted.recoverTranslations('a', [paragraphId]), { recovered: 1, turnIds: ['late-marker-translation'] });
  assert.equal(f.calls.length, before, 'recovery after a restart may only read history, never submit a new model task');
  assert.equal(f.docs.get('a').paragraphs[0].translation.text, candidate.text);
  assert.equal(f.docs.get('a').paragraphs[0].translation.nativeTurnId, 'late-marker-translation');
  assert.equal(f.docs.get('a').session.threadId, 'thread-论文 · Paper a');
  assert.ok(f.docs.get('a').session.managedTurns.some(turn => turn.id === 'late-marker-translation' && turn.kind === 'translation' && turn.jobId === 'cancelled-before-observation'));
  await restarted.sync('a');
  assert.equal(f.docs.get('a').answers.length, 0, 'late internal JSON must stay out of user chat');
  assert.deepEqual(await restarted.recoverTranslations('a', [paragraphId]), { recovered: 0, turnIds: [] });
  assert.equal(reads, 2, 'an already restored translation needs no repeated recovery scan');
});

test('request-marker recovery requires its saved current source hash and cannot adopt foreign, stale or incomplete queued results', async () => {
  const f = fixture();
  const make = (id, text) => ({ id, text, page: 2, kind: 'paragraph', sentences: [{ id: id + '-s1', text }], translation: null });
  const paragraphs = ['stale', 'no-hash', 'foreign', 'unfinished'].map(id => make(id, 'Current source for ' + id + '.'));
  f.docs.get('a').paragraphs = paragraphs;
  await f.sessions.prepare('a', {});
  const marker = index => `〔纸间任务:translate:${String(index).padStart(8, '0')}-1234-1234-1234-123456789012〕`;
  f.docs.get('a').session.managedRequests = [
    { marker: marker(1), kind: 'translation', paragraphIds: ['stale'], sourceHashes: { stale: hash('Old source.') } },
    { marker: marker(2), kind: 'translation', paragraphIds: ['no-hash'] },
    { marker: marker(4), kind: 'translation', paragraphIds: ['unfinished'], sourceHashes: { unfinished: hash(paragraphs[3].text) } },
  ];
  f.bridge.readSession = async () => ({ turns: paragraphs.map((p, index) => ({ id: 'late-' + p.id, status: p.id === 'unfinished' ? 'interrupted' : 'completed',
    userText: marker(index + 1) + '\nInternal translation', assistantText: JSON.stringify({ translations: [{ paragraphId: p.id, text: '不能恢复。', alignments: [{ sourceIds: [p.id + '-s1'], targetText: '不能恢复。' }], notes: [] }] }),
  })) });
  const before = f.calls.length;
  assert.deepEqual(await f.sessions.recoverTranslations('a', paragraphs.map(p => p.id)), { recovered: 0, turnIds: [] });
  assert.ok(f.docs.get('a').paragraphs.every(p => p.translation === null));
  assert.equal(f.calls.length, before);
});
