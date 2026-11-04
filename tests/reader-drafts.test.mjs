import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, hasDraftContent, resolveDraftSelection } from '../public/reader-drafts.js';

const storage = () => ({
  data:new Map(),
  getItem(key) { return this.data.get(key) || null; },
  setItem(key, value) { this.data.set(key, value); },
});
const quote = { paragraphId:'p1', selectedText:'The original sentence.', page:2 };
const paragraph = { id:'p1', page:2, text:'The original sentence. Its context remains available.' };

test('draft questions remain isolated by paper', () => {
  const store = createDraftStore(storage());
  store.write('a', { question:'Question A', selection:quote });
  store.write('b', { question:'Question B', selection:null });
  assert.equal(store.read('a').question, 'Question A');
  assert.equal(store.read('b').question, 'Question B');
});

test('quotes and page metadata survive persistence without shared mutable references', () => {
  const backing = storage(), store = createDraftStore(backing);
  store.write('a', { question:'Explain', selection:quote });
  store.read('a').selection.selectedText = 'An accidental mutation';
  assert.deepEqual(createDraftStore(backing).read('a').selection, quote);
});

test('an accepted unchanged draft clears its composer while retaining the submitted snapshot', () => {
  const store = createDraftStore(storage());
  const draft = store.write('a', { question:'Explain', selection:quote });
  store.accept('a', draft, 'job1');
  assert.equal(hasDraftContent(store.read('a')), false);
  assert.equal(store.read('a').submission.question, 'Explain');
  assert.deepEqual(store.read('a').submission.selection, quote);
});

test('a failed accepted request restores the original question and quote', () => {
  const store = createDraftStore(storage());
  store.accept('a', store.write('a', { question:'Explain', selection:quote }), 'job1');
  assert.equal(store.settle('a', 'job1', 'failed').restored, true);
  assert.equal(store.read('a').question, 'Explain');
  assert.deepEqual(store.read('a').selection, quote);
  assert.equal(store.settle('a', 'job1', 'failed').restored, false);
});

test('edits made during submission survive both acceptance and later failure', () => {
  const store = createDraftStore(storage());
  const original = store.write('a', { question:'Original question', selection:quote });
  store.write('a', { question:'Edited while sending', selection:null });
  store.accept('a', original, 'job1');
  assert.equal(store.read('a').question, 'Edited while sending');
  assert.equal(store.settle('a', 'job1', 'failed').restored, false);
  assert.equal(store.read('a').question, 'Edited while sending');
});

test('refresh restores pending job metadata and a later failure only affects its own paper', () => {
  const backing = storage();
  let store = createDraftStore(backing);
  store.accept('a', store.write('a', { question:'Pending A', selection:quote }), 'job1');
  store.write('b', { question:'Unsent B', selection:null });
  store = createDraftStore(backing);
  assert.equal(store.read('a').submission.jobId, 'job1');
  assert.equal(store.settle('a', 'job1', 'failed').restored, true);
  assert.equal(store.read('a').question, 'Pending A');
  assert.equal(store.read('b').question, 'Unsent B');
});

test('completion removes the submission snapshot without clearing a newer follow-up', () => {
  const store = createDraftStore(storage());
  store.accept('a', store.write('a', { question:'Submitted', selection:quote }), 'job1');
  store.write('a', { question:'New follow-up', selection:null });
  store.settle('a', 'job1', 'completed');
  assert.equal(store.read('a').question, 'New follow-up');
  assert.equal(store.read('a').submission, undefined);
});

test('stopping queue-owner waiting preserves recovery text without automatically restoring it', () => {
  const store = createDraftStore(storage());
  store.accept('a', store.write('a', { question:'Submitted', selection:quote }), 'job1');
  assert.equal(store.settle('a', 'job1', 'cancelled', { restore:false }).restored, false);
  assert.equal(hasDraftContent(store.read('a')), false);
  assert.equal(store.read('a').submission.question, 'Submitted');
});

test('intentional editing and clearing is not overwritten by failure recovery', () => {
  const store = createDraftStore(storage());
  store.accept('a', store.write('a', { question:'Submitted', selection:quote }), 'job1');
  store.write('a', { question:'Changed', selection:null });
  store.write('a', { question:'', selection:null });
  assert.equal(store.settle('a', 'job1', 'failed').restored, false);
  assert.equal(hasDraftContent(store.read('a')), false);
});

test('malformed or unavailable local storage does not lose the current in-memory draft', () => {
  const backing = storage();
  backing.setItem('read-paper-draft:bad', 'invalid JSON');
  assert.equal(createDraftStore(backing).read('bad').question, '');
  const store = createDraftStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } });
  store.write('a', { question:'Keep in memory', selection:quote });
  assert.equal(store.read('a').question, 'Keep in memory');
});

test('current source quotes remain valid across harmless PDF whitespace changes', () => {
  const result = resolveDraftSelection({ ...quote, selectedText:'The original\n sentence.' }, [paragraph]);
  assert.equal(result.stale, false);
  assert.equal(result.matchedBy, 'current');
  assert.equal(result.selection.paragraphId, 'p1');
});

test('Chinese selections in the current translation or alignment stay valid for sending', () => {
  const translated = { ...paragraph, translation:{ text:'原始句子。上下文仍然可用。', alignments:[{ targetText:'原始句子。' }, { targetText:'上下文仍然可用。' }] } };
  assert.equal(resolveDraftSelection({ ...quote, selectedText:'原始句子。' }, [translated]).stale, false);
  assert.equal(resolveDraftSelection({ ...quote, selectedText:'上下文仍然可用。' }, [{ ...translated, translation:{ alignments:translated.translation.alignments } }]).stale, false);
});

test('a missing or changed ID rebinds only to one exact current source or translation match', () => {
  const selected = { ...quote, paragraphId:'old' };
  const result = resolveDraftSelection(selected, [{ ...paragraph, id:'new', page:3 }]);
  assert.deepEqual(result.selection, { ...quote, paragraphId:'new', page:3 });
  assert.equal(result.matchedBy, 'exact');
  assert.equal(selected.paragraphId, 'old');
  const chinese = resolveDraftSelection({ ...selected, selectedText:'可靠的当前译文。' }, [{ id:'new', page:4, text:'Current source.', translation:{ text:'可靠的当前译文。' } }]);
  assert.equal(chinese.stale, false);
  assert.equal(chinese.selection.paragraphId, 'new');
});

test('ambiguous exact matches preserve the quote but remove the old sending ID', () => {
  const result = resolveDraftSelection({ ...quote, paragraphId:'old' }, [{ ...paragraph, id:'new1' }, { ...paragraph, id:'new2' }]);
  assert.equal(result.stale, true);
  assert.equal(result.selection.paragraphId, undefined);
  assert.equal(result.selection.selectedText, quote.selectedText);
  assert.equal(result.selection.page, quote.page);
});

test('an unchanged ID cannot validate text that no longer belongs to the current paragraph', () => {
  const result = resolveDraftSelection(quote, [{ ...paragraph, text:'An entirely revised statement.' }]);
  assert.equal(result.stale, true);
  assert.equal(result.selection.paragraphId, undefined);
  assert.equal(result.selection.selectedText, quote.selectedText);
});

test('archived translations and metadata cannot validate a stale quote', () => {
  const result = resolveDraftSelection({ ...quote, selectedText:'旧译文内容。' }, [
    { ...paragraph, translationArchive:[{ text:'旧译文内容。' }], translation:{ text:'新的译文。' } },
    { id:'authors', kind:'metadata', text:'旧译文内容。' },
  ]);
  assert.equal(result.stale, true);
});

test('quote resolution never guesses through changed punctuation, case, or mathematics', () => {
  for (const selectedText of ['the original sentence.', 'The original sentence!', 'The equation x=y holds.']) {
    assert.equal(resolveDraftSelection({ ...quote, selectedText }, [paragraph, { id:'math', text:'The equation ⟦MATH_m001⟧ holds.' }]).stale, true);
  }
  assert.equal(resolveDraftSelection({ paragraphId:'math', selectedText:'The equation ⟦MATH_m001⟧ holds.' }, [{ id:'math', text:'The equation ⟦MATH_m001⟧ holds.' }]).stale, false);
});
