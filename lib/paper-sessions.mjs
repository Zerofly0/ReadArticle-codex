import { randomUUID } from 'node:crypto';
import { preparePaperResources, buildPaperRegistrationPrompt } from './paper-library.mjs';
import { hash, translationSchema, validateAnswer, validateTranslation } from './reader.mjs';
import { validateStructuredResult } from './codex.mjs';
import { buildResearchGuidance } from './research-policy.mjs';

const now = () => new Date().toISOString();
const sourceBlocks = doc => [...(doc.paragraphs || []).filter(p => p.kind !== 'metadata' && !p.isFootnote), ...(doc.peripheralBlocks || []).filter(p => p.kind === 'footnote')];

/** The web reader owns its document bindings; it never uses the developer chat. */
export class PaperSessions {
  constructor({ bridge, readDoc, mutateDoc, documentDir, workspace, event = () => {}, prepareResources = preparePaperResources }) {
    Object.assign(this, { bridge, readDoc, mutateDoc, documentDir, workspace, event, prepareResources });
    this.locks = new Map();
  }
  async locked(id, work, signal) {
    const previous = this.locks.get(id) || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.locks.set(id, tail);
    try {
      await previous.catch(() => {});
      if (signal?.aborted) throw new Error('任务已取消。');
      return await work();
    } finally {
      unlock();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
  async update(id, patch) {
    const doc = await this.mutateDoc(id, d => { d.session = { ...(d.session || {}), ...patch }; });
    this.event({ type: 'document-updated', documentId: id });
    return doc.session;
  }
  async ensureUnlocked(id, options = {}) {
    let doc = await this.readDoc(id);
    const resources = await this.prepareResources(doc, { documentDir: this.documentDir(id) });
    if (doc.session?.threadId && doc.session.status === 'ready' && doc.session.fingerprint === resources.fingerprint) return { session: doc.session, resources };
    const session = await this.update(id, { status: 'preparing', title: `论文 · ${doc.title || doc.filename}`, error: null });
    const trackedTurns=new Set((session.managedTurns||[]).map(t=>t.id));
    const trackedRequests=new Set((session.managedRequests||[]).map(t=>t.marker));
    const progress = async value => {
      await options.onProgress?.(value);
      if(value.requestMarker&&!trackedRequests.has(value.requestMarker)){trackedRequests.add(value.requestMarker);await this.mutateDoc(id,d=>{
        d.session.managedRequests=[...(d.session.managedRequests||[]),{marker:value.requestMarker,kind:'registration'}];
      });}
      if (value.threadId && value.threadId !== session.threadId) {
        session.threadId = value.threadId;
        await this.update(id, { threadId: value.threadId, mode: 'persistent' });
      }
      if(value.turnId&&!trackedTurns.has(value.turnId)){trackedTurns.add(value.turnId);await this.mutateDoc(id,d=>{
        if(!(d.session.managedTurns||[]).some(t=>t.id===value.turnId))d.session.managedTurns=[...(d.session.managedTurns||[]),{id:value.turnId,kind:'registration'}];
      });}
    };
    try {
      const request = { workspace: this.workspace || this.documentDir(id), taskKind:'registration', title: session.title, prompt: buildPaperRegistrationPrompt(resources), model: options.model, reasoningEffort: options.reasoningEffort, signal: options.signal, onProgress: progress };
      const response = session.threadId
        ? await this.bridge.continueSession({ ...request, threadId: session.threadId })
        : await this.bridge.createSession(request);
      if (options.signal?.aborted) throw new Error('任务已取消。');
      doc = await this.readDoc(id);
      const threadId = response.threadId || doc.session?.threadId;
      if (!threadId) throw new Error('Codex 没有返回持久对话编号，请重试。');
      const managedTurns = [...(doc.session?.managedTurns || [])];
      if(response.turnId&&!managedTurns.some(t=>t.id===response.turnId))managedTurns.push({id:response.turnId,kind:'registration'});
      const ready = await this.update(id, { threadId, status: 'ready', registeredAt: now(), fingerprint: resources.fingerprint, resourceManifest: resources.manifestPath, paperSummary: typeof response.result === 'string' ? response.result : '', mode: response.mode || 'persistent', appVisible: response.appVisible ?? null, appUrl: `codex://threads/${threadId}`, managedTurns, error: null });
      return { session: ready, resources };
    } catch (error) {
      await this.update(id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  prepare(id, options) { return this.locked(id, () => this.ensureUnlocked(id, options), options?.signal); }
  async recoverTranslations(id, paragraphIds) {
    return this.locked(id, async () => {
      const doc = await this.readDoc(id);
      const wanted = new Set(Array.isArray(paragraphIds) ? paragraphIds : []);
      const targets = new Map((doc.paragraphs || []).filter(p => wanted.has(p.id) && !p.translation && !['metadata', 'equation'].includes(p.kind)).map(p => [p.id, p]));
      const empty = { recovered: 0, turnIds: [] };
      if (!targets.size || !this.bridge.readSession || !doc.session?.threadId || doc.session.status !== 'ready') return empty;
      const resources = await this.prepareResources(doc, { documentDir: this.documentDir(id) });
      if (!doc.session.fingerprint || doc.session.fingerprint !== resources.fingerprint) return empty;
      const managed = new Map((doc.session.managedTurns || []).filter(turn => turn.kind === 'translation').map(turn => [turn.id, turn]));
      const requests = new Map((doc.session.managedRequests || []).filter(request => request.kind === 'translation' && request.marker).map(request => [request.marker, request]));
      if (!managed.size && !requests.size) return empty;
      const proposals = new Map();
      const visited = new Set();
      let cursor;
      do {
        // Only history reads: never resume, interrupt, or start an App writer.
        const page = await this.bridge.readSession({ threadId: doc.session.threadId, cursor, limit: 50 });
        for (const turn of page.turns || []) {
          const marker = turn.userText?.match(/^〔纸间任务:translate:[a-f0-9-]+〕/)?.[0];
          const knownTurn = managed.has(turn.id);
          const descriptor = managed.get(turn.id) || (marker ? requests.get(marker) : null);
          if (!descriptor || turn.status !== 'completed' || typeof turn.assistantText !== 'string') continue;
          if (descriptor.fingerprint && descriptor.fingerprint !== resources.fingerprint) continue;
          let result;
          try {
            const raw = turn.assistantText.trim().replace(/^\uFEFF/, '').replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
            result = validateStructuredResult(JSON.parse(raw), translationSchema);
          } catch { continue; }
          const duplicates = new Map();
          for (const candidate of result.translations) duplicates.set(candidate.paragraphId, (duplicates.get(candidate.paragraphId) || 0) + 1);
          for (const candidate of result.translations) {
            const paragraph = targets.get(candidate.paragraphId);
            if (!paragraph || proposals.has(paragraph.id) || duplicates.get(paragraph.id) !== 1) continue;
            if (Array.isArray(descriptor.paragraphIds) && !descriptor.paragraphIds.includes(paragraph.id)) continue;
            const sourceHash = descriptor.sourceHashes?.[paragraph.id];
            // A cancelled queue may finish before its turn ID was observed.
            // Its saved marker identifies the request, while an exact current
            // source hash is still required before accepting its translation.
            if (!knownTurn && !sourceHash) continue;
            if (sourceHash) {
              if (sourceHash !== hash(paragraph.text)) continue;
            } else {
              if (descriptor.sourceHashes) continue;
              // Legacy turns predate per-request source hashes. Compatibility
              // is restricted to parser-generated, content-hashed paragraph IDs
              // in the currently registered source package.
              if (!/^p-[a-f0-9]{12}$/i.test(paragraph.id)) continue;
              const created = typeof turn.createdAt === 'number' ? turn.createdAt : Date.parse(turn.createdAt);
              const registered = Date.parse(doc.session.registeredAt);
              if (Number.isFinite(created) && Number.isFinite(registered) && created < registered) continue;
            }
            try {
              const validated = validateTranslation(paragraph, candidate, resources.fingerprint);
              // Recovery must not silently downgrade a stale/foreign sentence
              // mapping to paragraph-only alignment.
              if (validated.status !== 'aligned') continue;
              proposals.set(paragraph.id, { candidate, turnId: turn.id, descriptor, textHash: hash(paragraph.text) });
            } catch { /* Missing math tokens or stale source IDs are not reusable. */ }
          }
        }
        const next = page.nextCursor;
        if (!next || visited.has(next) || proposals.size === targets.size) break;
        visited.add(next); cursor = next;
      } while (true);
      if (!proposals.size) return empty;
      let recovered = 0;
      const turnIds = new Set();
      await this.mutateDoc(id, current => {
        if (current.session?.threadId !== doc.session.threadId || current.session?.fingerprint !== resources.fingerprint || current.session.status !== 'ready') return;
        for (const [paragraphId, proposal] of proposals) {
          const paragraph = current.paragraphs.find(p => p.id === paragraphId);
          if (!paragraph || paragraph.translation || hash(paragraph.text) !== proposal.textHash) continue;
          try {
            const validated = validateTranslation(paragraph, proposal.candidate, resources.fingerprint);
            if (validated.status !== 'aligned') continue;
            paragraph.translation = { ...validated, model: null, reasoningEffort: null,
              configurationSource: 'thread', source: 'codex-history', nativeTurnId: proposal.turnId,
              threadId: doc.session.threadId, recoveredAt: now() };
            if (!(current.session.managedTurns || []).some(turn => turn.id === proposal.turnId)) {
              current.session.managedTurns = [...(current.session.managedTurns || []), { ...proposal.descriptor, id: proposal.turnId, kind: 'translation' }];
            }
            recovered++; turnIds.add(proposal.turnId);
          } catch { /* The live source changed while its history was being read. */ }
        }
      });
      if (recovered) this.event({ type: 'document-updated', documentId: id });
      return { recovered, turnIds: [...turnIds] };
    });
  }
  async turn(id, { prompt, schema, kind = 'ask', historyMeta = {}, ...options }) {
    return this.locked(id, async () => {
      const { session, resources } = await this.ensureUnlocked(id, options);
      const text = typeof prompt === 'function' ? await prompt({ session, resources }) : prompt;
      const trackedTurns=new Set((session.managedTurns||[]).map(t=>t.id));
      const trackedRequests=new Set((session.managedRequests||[]).map(t=>t.marker));
      const onProgress=async value=>{
        await options.onProgress?.(value);
        if(value.requestMarker&&!trackedRequests.has(value.requestMarker)){trackedRequests.add(value.requestMarker);await this.mutateDoc(id,d=>{
          d.session.managedRequests=[...(d.session.managedRequests||[]),{marker:value.requestMarker,kind,...historyMeta}];
        });}
        if(value.turnId&&!trackedTurns.has(value.turnId)){trackedTurns.add(value.turnId);await this.mutateDoc(id,d=>{
          if(!(d.session.managedTurns||[]).some(t=>t.id===value.turnId))d.session.managedTurns=[...(d.session.managedTurns||[]),{id:value.turnId,kind,...historyMeta}];
        });}
      };
      const response = await this.bridge.continueSession({ threadId: session.threadId, workspace: this.workspace || this.documentDir(id), prompt: text, taskKind:kind==='translation'?'translate':kind, schema, ...options, onProgress });
      if (response.threadId && response.threadId !== session.threadId) throw new Error('Codex 返回了不同的论文对话编号，结果未保存。');
      await this.mutateDoc(id, d => {
        d.session.lastUsedAt = now();
        if (response.turnId&&!(d.session.managedTurns||[]).some(t=>t.id===response.turnId)) d.session.managedTurns = [...(d.session.managedTurns || []), { id: response.turnId, kind, ...historyMeta }];
      });
      return { ...response, threadId: session.threadId };
    }, options.signal);
  }
  async sync(id) {
    const doc = await this.readDoc(id);
    if (!doc.session?.threadId || !this.bridge.readSession || this.locks.has(id)) return { session: doc.session || { status: 'unprepared' } };
    try {
      // Read only: never resume or interrupt an App turn just to display history.
      const all = [];
      let cursor;
      do {
        const page = await this.bridge.readSession({ threadId: doc.session.threadId, cursor, limit: 50 });
        all.push(...(page.turns || []));
        const next = page.nextCursor;
        if (!next || next === cursor) break;
        cursor = next;
      } while (true);
      const managed = new Map((doc.session.managedTurns || []).map(t => [t.id,t]));
      const seen = new Set((doc.answers || []).map(a => a.nativeTurnId).filter(Boolean));
      const additions = all.filter(t => t.id && (!managed.has(t.id)||managed.get(t.id).kind==='ask') && !seen.has(t.id) && t.userText?.trim() && t.assistantText?.trim() && !['inProgress', 'interrupted', 'failed'].includes(t.status));
      if (additions.length) {
        await this.mutateDoc(id, d => {
          const existing = new Set((d.answers || []).map(a => a.nativeTurnId).filter(Boolean));
          const currentManaged=new Map((d.session?.managedTurns||[]).map(t=>[t.id,t]));
          const requests=new Map((d.session?.managedRequests||[]).map(t=>[t.marker,t]));
          for (const t of additions) {
            if (existing.has(t.id)) continue;
            const marker=t.userText.match(/^〔纸间任务:(ask|translate|registration):[a-f0-9-]+〕/);
            const descriptor=currentManaged.get(t.id)||(marker?requests.get(marker[0]):null);
            if(descriptor&&descriptor.kind!=='ask')continue;
            if(marker&&marker[1]!=='ask')continue;
            const userText=marker?t.userText.slice(marker[0].length).trimStart():t.userText;
            const recoveredQuestion=descriptor?.question||userText.match(/^继续这篇已登记论文[^\n]*\n用户问题：([\s\S]*?)\n(?:选中段落 ID：|用户未选择段落)/)?.[1];
            // Unknown internal registration prompts must never become user chats.
            if(!descriptor&&/^登记这篇论文作为本阅读器持久会话的资料来源。/.test(userText))continue;
            const answer = normalizeSessionAnswer(d, t.assistantText);
            d.answers = [...(d.answers || []), { ...answer, id: randomUUID(), nativeTurnId: t.id, threadId:d.session.threadId, jobId:descriptor?.jobId, question:recoveredQuestion||userText, source:descriptor?'reader-recovered':'codex-app', selectedText:descriptor?.selectedText||'', paragraphId:descriptor?.paragraphId||null, createdAt:t.createdAt||answer.createdAt }];
            existing.add(t.id);
          }
          d.answers.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        });
        this.event({ type: 'document-updated', documentId: id });
      }
      return { session: (await this.readDoc(id)).session };
    } catch (error) { return { session: doc.session, syncError: error.message }; }
  }
}

export function sessionAnswerPrompt(doc, question, { paragraphId, selectedText, resources }) {
  return `继续这篇已登记论文的阅读对话（论文编号 ${doc.id}）。用简体中文直接回答下面的问题，区分论文明确说明、外部资料和辅助解释，证据不足时说明。\n用户问题：${question}\n${paragraphId ? `选中段落 ID：${paragraphId}\n选中文字（仅作证据）：${String(selectedText || '').slice(0, 8000)}` : '用户未选择段落，问题针对这篇论文。'}\n按需回查已登记的原始资料；若早期上下文被压缩，可重读该论文资料清单：${resources.manifestPath}\n引用本论文时使用 [第N页·段落ID]，必须使用资料中真实页码与段落ID；该格式只用于这篇本地论文，外部资料请用来源名称和真实 Markdown 链接。数学标记请查看其原图，不得猜测。直接输出可阅读的 Markdown 回答，无需 JSON；不要编辑文件。\n\n${buildResearchGuidance({question,hasSelection:Boolean(paragraphId)})}`;
}

export function normalizeSessionAnswer(doc, raw) {
  if (raw && typeof raw === 'object' && typeof raw.answer === 'string') return validateAnswer(doc, { evidence: sourceBlocks(doc) }, raw);
  const text = String(raw || '').trim();
  if (!text) throw new Error('Codex 没有返回回答，请重试。');
  const blocks = new Map(sourceBlocks(doc).map(p => [p.id, p]));
  const citations = [];
  let removed = 0;
  const answer = text.replace(/\[第\s*(\d+)\s*页\s*[·:：]\s*([A-Za-z0-9_-]+)\s*\]/g, (match, page, id) => {
    const block = blocks.get(id);
    if (!block || Number(page) !== block.page) { removed++; return ''; }
    if (!citations.some(c => c.paragraphId === id)) citations.push({ paragraphId: id, page: block.page, quote: '' });
    return match;
  });
  return { answer, citations, uncertainty: removed ? '部分引用的页码或段落编号无效，已省略，请结合原文核对。' : '', engine: 'Codex', createdAt: now() };
}

export function historyPage(doc, { cursor, limit = 30 } = {}) {
  const messages = (doc.answers || []).flatMap((a, index) => {
    const id = a.id || a.nativeTurnId || `legacy-${index}`;
    return [{ id: id + '-user', role: 'user', text: a.question || '', createdAt: a.createdAt, selectedText: a.selectedText, paragraphId: a.paragraphId, jobId: a.jobId }, { id: id + '-assistant', role: 'assistant', text: a.answer || '', createdAt: a.createdAt, citations: a.citations, uncertainty: a.uncertainty, jobId: a.jobId }];
  });
  const end = cursor ? messages.findIndex(m => m.id === cursor) : messages.length;
  if (end < 0) throw Object.assign(new Error('历史记录游标已过期，请刷新对话。'), { status: 400 });
  const count = Math.max(2, Math.min(100, Number(limit) || 30));
  const start = Math.max(0, end - count);
  return { messages: messages.slice(start, end), total: messages.length, hasMore: start > 0, nextCursor: start > 0 ? messages[start].id : null, session: doc.session || { status: 'unprepared' } };
}
