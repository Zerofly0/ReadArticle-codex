// Per-paper drafts stay local. Revision checks protect edits made while a request is in flight.
const copy = value => JSON.parse(JSON.stringify(value));
const selectionOf = value => {
  if (!value || typeof value.selectedText !== 'string' || !value.selectedText.trim()) return null;
  return {
    selectedText: value.selectedText,
    ...(typeof value.paragraphId === 'string' && value.paragraphId ? { paragraphId:value.paragraphId } : {}),
    ...(Number.isInteger(value.page) && value.page > 0 ? { page:value.page } : {}),
  };
};
const contentOf = value => ({ question:typeof value?.question === 'string' ? value.question : '', selection:selectionOf(value?.selection) });
export const hasDraftContent = value => Boolean(value?.question?.trim() || value?.selection?.selectedText);
export const sameDraftContent = (a, b) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

// Compare only current source/current translation, never archived translations or fuzzy text.
const compactWhitespace = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
export function resolveDraftSelection(value, paragraphs = []) {
  const selection = selectionOf(value);
  if (!selection) return { selection:null, stale:false, matchedBy:null };
  const quote = compactWhitespace(selection.selectedText);
  const containsQuote = paragraph => {
    if (!paragraph || typeof paragraph.id !== 'string' || paragraph.kind === 'metadata') return false;
    const texts = [paragraph.text, paragraph.rawText, paragraph.translation?.text,
      ...(Array.isArray(paragraph.translation?.alignments) ? paragraph.translation.alignments.map(item => item?.targetText) : [])];
    return texts.some(text => compactWhitespace(text).includes(quote));
  };
  const current = paragraphs.find(paragraph => paragraph.id === selection.paragraphId);
  if (containsQuote(current)) return { selection:{ ...selection, page:current.page || selection.page }, stale:false, matchedBy:'current' };
  const matches = paragraphs.filter(containsQuote);
  if (matches.length === 1) return {
    selection:{ ...selection, paragraphId:matches[0].id, page:matches[0].page || selection.page },
    stale:false, matchedBy:'exact',
  };
  const { paragraphId:oldId, ...unbound } = selection;
  return { selection:unbound, stale:true, matchedBy:null };
}

export function createDraftStore(storage, prefix = 'read-paper-draft:') {
  const memory = new Map();
  function read(id) {
    if (memory.has(id)) return copy(memory.get(id));
    let stored;
    try { stored = JSON.parse(storage.getItem(prefix + id) || 'null'); } catch (_) {}
    const draft = { ...contentOf(stored), revision:Number.isSafeInteger(stored?.revision) ? stored.revision : 0 };
    if (stored?.submission && typeof stored.submission.jobId === 'string') {
      draft.submission = {
        ...contentOf(stored.submission), jobId:stored.submission.jobId,
        status:stored.submission.status || 'queued', createdAt:stored.submission.createdAt,
        clearedRevision:Number.isSafeInteger(stored.submission.clearedRevision) ? stored.submission.clearedRevision : null,
      };
    }
    memory.set(id, draft);
    return copy(draft);
  }
  function save(id, draft) {
    memory.set(id, copy(draft));
    try { storage.setItem(prefix + id, JSON.stringify(draft)); } catch (_) { /* Keep the in-memory draft if local storage is unavailable. */ }
    return copy(draft);
  }
  function write(id, content) {
    const draft = read(id);
    if (sameDraftContent(draft, content)) return draft;
    return save(id, { ...draft, ...contentOf(content), revision:draft.revision + 1 });
  }
  function accept(id, snapshot, jobId) {
    const draft = read(id);
    const unchanged = draft.revision === snapshot.revision;
    const next = unchanged ? { ...draft, question:'', selection:null, revision:draft.revision + 1 } : draft;
    next.submission = {
      ...contentOf(snapshot), jobId, status:'queued', createdAt:new Date().toISOString(),
      clearedRevision:unchanged ? next.revision : null,
    };
    return save(id, next);
  }
  function settle(id, jobId, status, { restore = true } = {}) {
    const draft = read(id);
    if (draft.submission?.jobId !== jobId) return { draft, restored:false };
    if (status === 'completed') {
      delete draft.submission;
      return { draft:save(id, draft), restored:false };
    }
    const restored = restore && !hasDraftContent(draft) && draft.revision === draft.submission.clearedRevision;
    draft.submission.status = status;
    if (restored) {
      Object.assign(draft, contentOf(draft.submission), { revision:draft.revision + 1 });
      draft.submission.clearedRevision = null;
    }
    return { draft:save(id, draft), restored };
  }
  return { read, write, accept, settle };
}
