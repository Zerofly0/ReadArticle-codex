import { renderSafeMarkdown } from './safe-markdown.js';
import { createDraftStore, hasDraftContent, sameDraftContent, resolveDraftSelection } from './reader-drafts.js';

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    document: null, library: [], status: null, view: 'reflow',
    selected: null, menuSelection: null, pinned: [], jobs: new Map(), importing: false,
    currentParagraph: null, activeSection: null, saveTimer: null,
    observer: null, toastTimer: null, events: null, settings: null, presets: [], defaults: {}, historyTimer: null,
    fontSize: Number(localStorage.getItem('paper-reader-font') || 22),
    widthMode: localStorage.getItem('paper-reader-width') || 'full',
    chatWidth: Number(localStorage.getItem('paper-reader-chat-width') || 0), forceChatScroll: false, submittingDocuments: new Set(),
    chatHistory: null, preparingSessions: new Set(), sessionHistoryTimer: null, openToken:0,
    quality:null, qualityRequest:0, reparsingDocuments:new Set(), remoteReparses:new Set(),
  };
  const drafts = createDraftStore(localStorage);
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const docUrl = (suffix = '') => `/api/documents/${encodeURIComponent(state.document.id)}${suffix}`;
  const fileIcon = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h5"/></svg>';
  const sparkIcon = '<svg viewBox="0 0 24 24"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/></svg>';

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `请求失败（${response.status}）`);
    return body;
  }
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7500 : 4200);
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('paper-reader-theme', theme);
    $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
  }
  function setFont(size) {
    if (!Number.isFinite(size)) size = 22;
    state.fontSize = Math.min(32, Math.max(16, size));
    document.documentElement.style.setProperty('--font-size', `${state.fontSize}px`);
    document.documentElement.style.setProperty('--ui-scale', String(Math.min(1.2, Math.max(1, 1 + (state.fontSize - 22) * .018))));
    localStorage.setItem('paper-reader-font', String(state.fontSize));
  }
  function setWidthMode(mode) {
    state.widthMode = mode === 'comfortable' ? 'comfortable' : 'full';
    $('paper').classList.toggle('comfortable', state.widthMode === 'comfortable');
    $('reading-width').textContent = state.widthMode === 'comfortable' ? '舒适' : '铺满';
    $('reading-width').title = state.widthMode === 'comfortable' ? '当前舒适行宽，点击铺满阅读区' : '当前铺满阅读区，点击切换舒适行宽';
    $('reading-width').setAttribute('aria-pressed', String(state.widthMode === 'comfortable'));
    localStorage.setItem('paper-reader-width', state.widthMode);
  }
  function plainError(error) { return error?.message || String(error); }
  function paragraphs() { return state.document?.paragraphs || []; }
  function paragraphById(id) { return paragraphs().find(p => p.id === id); }
  const eligibleParagraph = (p) => !['heading', 'metadata', 'equation'].includes(p.kind);
  const canTranslate = (p) => !['metadata', 'equation'].includes(p.kind);
  function mathAsset(tokenOrId) { return (state.document?.mathAssets || []).find(asset => asset.token === tokenOrId || asset.id === tokenOrId); }
  function localImageUrl(raw) {
    try { const url = new URL(raw, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/documents/') ? url.pathname + url.search : null; }
    catch (_) { return null; }
  }
  function mathHtml(text) {
    return String(text ?? '').split(/(⟦MATH_[A-Za-z0-9_-]+⟧)/gu).map(fragment => {
      const asset = mathAsset(fragment);
      const url = asset && localImageUrl(asset.url);
      if (!asset || !url) return escape(fragment);
      const box = asset.sourceBox || {};
      const sourceHeight = Number(box.y1 ?? box.bottom) - Number(box.y0 ?? box.top);
      const sourceFontSize = Number(asset.sourceFontSize);
      const cropHeight = Number(asset.height) || sourceHeight + 1.6;
      const inlineHeight = Number.isFinite(sourceFontSize) && sourceFontSize > 0 && Number.isFinite(cropHeight)
        ? Math.min(2.4, Math.max(.85, cropHeight / sourceFontSize))
        : Number.isFinite(sourceHeight) ? Math.min(1.8, Math.max(.85, sourceHeight / 11)) : 1.15;
      const display = asset.display === 'block' ? 'display-math' : 'inline-math';
      return `<img class="${display}" src="${escape(url)}" data-math-id="${escape(asset.id)}" alt="${escape(asset.alt || '原文公式')}" title="原文公式 · 第 ${escape(asset.page || 1)} 页 · 点击放大查看" ${display === 'inline-math' ? `style="height:${inlineHeight.toFixed(2)}em"` : ''} loading="lazy">`;
    }).join('');
  }
  function elapsedLabel(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }
  function renderSettings() {
    const settings = state.settings;
    if (!settings) return;
    const select = $('translation-preset');
    select.innerHTML = state.presets.map(preset => `<option value="${escape(preset.id)}">${escape(preset.label)}</option>`).join('');
    select.value = settings.translationPreset;
    select.disabled = false;
    const preset = state.presets.find(p => p.id === settings.translationPreset);
    $('preset-description').textContent = preset?.description || '';
    const model = settings.model || preset?.model || state.defaults.model || 'Codex 当前配置';
    const effort = settings.reasoningEffort || preset?.reasoningEffort || state.defaults.reasoningEffort || '默认';
    $('effective-setting').innerHTML = `<span>新任务请求配置</span><code>${escape(model)}</code><code>推理：${escape(effort)}</code>`;
  }
  async function refreshSettings() {
    try {
      const data = await api('/api/settings');
      state.settings = data.settings;
      state.presets = data.presets || [];
      state.defaults = data.defaults || {};
      renderSettings();
    } catch (error) {
      $('translation-preset').disabled = true;
      $('preset-description').textContent = `读取翻译设置失败：${plainError(error)}`;
    }
  }
  async function savePreset() {
    const preset = $('translation-preset').value;
    $('translation-preset').disabled = true;
    try {
      const result = await post('/api/settings', { translationPreset: preset });
      if (result.settings) state.settings = result.settings;
      else await refreshSettings();
      renderSettings();
      toast('已更新翻译模式，将用于新提交的翻译任务。');
    } catch (error) { renderSettings(); toast(plainError(error), true); }
  }
  async function loadJobHistory() {
    try {
      const result = await api('/api/jobs');
      const jobs = (result.jobs || []).filter(job => job.type === 'translate').sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      $('job-history-count').textContent = `${jobs.length} 条翻译任务`;
      const labels = { queued:'等待中', running:'翻译中', completed:'已完成', failed:'未完成', cancelled:'已取消', interrupted:'已中断' };
      $('job-history-list').innerHTML = jobs.length ? jobs.map(job => {
        const doc = state.library.find(d => d.id === job.documentId);
        const known = state.jobs.get(job.id);
        const execution = { ...known, ...job };
        const fromThread = execution.executionMode === 'queue-owner' || execution.configurationSource === 'thread';
        const model = execution.model ?? '未记录';
        const effort = execution.reasoningEffort ?? '未记录';
        const modelHtml = fromThread ? '<span>沿用 Codex 对话模型/推理设置</span>' : `<code>${escape(model)}</code><code>推理：${escape(effort)}</code>`;
        const created = job.createdAt ? new Date(job.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
        const elapsed = job.elapsedMs ?? known?.elapsedMs;
        return `<article class="job-record"><div class="job-record-heading"><strong>${escape(doc?.title || doc?.filename || '论文翻译')}</strong><span class="job-status status-${escape(job.status)}">${escape(labels[job.status] || job.status)}</span></div><div class="job-record-meta"><span>${escape(created)}</span><span>耗时 ${escape(elapsedLabel(elapsed))}</span></div><div class="job-model">${modelHtml}<span>Codex 执行</span></div>${job.result?.translated != null ? `<p>完成 ${escape(job.result.translated)} 段${job.result.cached ? ` · 缓存 ${escape(job.result.cached)} 段` : ''}</p>` : ''}<p class="${job.error ? 'job-error' : ''}">${escape(job.error || job.message || '')}</p>${job.threadId ? `<details><summary>任务详情</summary><code>${escape(job.threadId)}</code></details>` : ''}</article>`;
      }).join('') : '<div class="job-history-empty">还没有翻译记录。点击论文中的“翻译本段”，任务会显示在这里。</div>';
    } catch (error) { $('job-history-list').innerHTML = `<div class="job-history-empty">${escape(plainError(error))}</div>`; }
  }
  async function showJobHistory() {
    $('status-popover').hidden = true;
    $('job-history-dialog').showModal();
    $('job-history-list').innerHTML = '<div class="job-history-empty"><span class="spinner tiny"></span> 正在读取记录…</div>';
    await loadJobHistory();
    clearInterval(state.historyTimer);
    state.historyTimer = setInterval(loadJobHistory, 4000);
  }

  async function refreshStatus() {
    try {
      state.status = await api('/api/status');
      state.remoteReparses = new Set((state.status.activeJobs || []).filter(job => job.type === 'reparse' && ['queued','running'].includes(job.status)).map(job => job.documentId));
      const c = state.status.codex || {};
      const ready = c.available && c.authenticated !== false;
      $('connection-button').classList.toggle('ready', !!ready);
      $('connection-button').classList.toggle('error', !ready);
      $('connection-label').textContent = ready ? 'Codex 已连接' : c.available ? 'Codex 待登录' : 'Codex 未就绪';
      const parser = state.status.parser || {};
      const sessionReady = state.document?.session?.status === 'ready';
      $('status-details').innerHTML = `<div class="status-line"><span>翻译与解释</span><span>${escape(c.available ? (c.authenticated === false ? '需要登录 Codex' : '本机 Codex') : '未找到 Codex')}</span></div><div class="status-line"><span>论文解析</span><span>${escape(parser.name || (parser.available ? '可用' : '未就绪'))}</span></div><div class="status-line"><span>论文对话</span><span>${state.document ? (sessionReady ? '当前论文的独立会话' : '正在准备或等待准备') : '打开论文后准备'}</span></div><div class="status-detail">${escape(c.detail || '所有模型任务由本机 Codex 执行。')} 讨论与翻译使用当前论文的独立会话。</div>`;
      $('ask-button').innerHTML = '发送 <span>↗</span>';
      (state.status.activeJobs || []).filter(job => ['translate','ask','session'].includes(job.type)).forEach(job => {
        if (!state.jobs.has(job.id)) trackJob(job.id, {
          kind:job.type, paragraphIds:[], documentId:job.documentId, message:job.message,
          question:job.question, selectedText:job.selectedText, paragraphId:job.paragraphId,
          target:'reader', createdAt:job.createdAt || new Date().toISOString(),
          status:job.status, model:job.model, reasoningEffort:job.reasoningEffort, elapsedMs:job.elapsedMs,
          executionMode:job.executionMode, configurationSource:job.configurationSource, requestedModel:job.requestedModel, requestedReasoningEffort:job.requestedReasoningEffort,
        });
      });
      updateQualityControls();
      updateComposerState();
    } catch (error) {
      $('connection-label').textContent = '服务连接中断';
      $('connection-button').classList.remove('ready');
      $('connection-button').classList.add('error');
      $('status-details').innerHTML = `<div class="status-detail">${escape(plainError(error))}。请确认本地阅读器服务正在运行。</div>`;
    }
  }
  async function loadLibrary() {
    const result = await api('/api/library');
    state.library = result.documents || [];
    renderLibrary();
  }
  function renderLibrary() {
    $('library-count').textContent = String(state.library.length);
    $('library-list').innerHTML = state.library.length ? state.library.map(doc => `<button class="library-item ${state.document?.id === doc.id ? 'active' : ''}" data-doc-id="${escape(doc.id)}" title="${escape(doc.title || doc.filename)}">${fileIcon}<span><strong>${escape(doc.title || doc.filename || '未命名论文')}</strong><small>${escape(doc.pageCount || '—')} 页${doc.translatedCount != null ? ` · 已译 ${doc.translatedCount} 段` : ''}</small></span></button>`).join('') : '<div class="sidebar-empty">导入第一篇论文，开始阅读。</div>';
  }
  async function openDocument(id, restoreProgress = true) {
    persistDraft();
    const openToken = ++state.openToken;
    let result;
    try { result = await api(`/api/documents/${encodeURIComponent(id)}`); }
    catch (error) {
      if (openToken !== state.openToken) return;
      if (state.document) refreshDocument().catch(() => {});
      throw error;
    }
    if (openToken !== state.openToken) return;
    persistDraft();
    state.document = result.document || result;
    state.quality = null;
    state.chatHistory = { documentId:id, messages:[], nextCursor:null, hasMore:false, total:0, loaded:false, loading:false, loadingOlder:false, syncError:'', fetchedAt:0 };
    state.pinned = [];
    state.menuSelection = null;
    state.currentParagraph = null;
    state.activeSection = null;
    $('selection-menu').hidden = true;
    $('insight-panel').hidden = false;
    $('chat-divider').hidden = false;
    $('workspace').classList.add('has-document');
    restoreDraft();
    state.forceChatScroll = true;
    $('welcome').hidden = true;
    $('document-shell').hidden = false;
    renderDocument();
    if ($('quality-dialog').open) renderQuality();
    renderLibrary();
    applyChatWidth();
    setView('reflow');
    localStorage.setItem('paper-reader-last-document', id);
    const url = new URL(location.href);
    url.searchParams.set('doc', id);
    history.replaceState({}, '', url);
    if (restoreProgress && state.document.progress) {
      const progress = state.document.progress;
      requestAnimationFrame(() => {
        if (openToken !== state.openToken || state.document?.id !== id) return;
        const p = progress.paragraphId && document.querySelector(`[data-paragraph-id="${CSS.escape(progress.paragraphId)}"]`);
        if (p) p.scrollIntoView({ block: 'start', behavior: 'instant' });
        else if (progress.scrollTop) $('reading-surface').scrollTop = progress.scrollTop;
      });
    } else $('reading-surface').scrollTop = 0;
    document.title = `${state.document.title || state.document.filename} · READ`;
    $('app').classList.remove('mobile-nav-open');
    updateReadingPosition();
    loadQuality({ quiet:true }).catch(() => {});
    const pendingDraft = drafts.read(id).submission;
    if (pendingDraft && !state.jobs.has(pendingDraft.jobId)) trackJob(pendingDraft.jobId, {
      kind:'ask', target:'reader', documentId:id, question:pendingDraft.question,
      ...(pendingDraft.selection || {}), createdAt:pendingDraft.createdAt || new Date().toISOString(),
    });
    if (state.document.session?.threadId || state.document.session?.status === 'ready') loadSessionHistory({ reset:true }).catch(() => {});
    ensurePaperSession().catch(() => {});
  }
  function renderDocument() {
    const doc = state.document;
    $('document-title').textContent = doc.title || doc.filename || '未命名论文';
    $('document-title').title = doc.title || doc.filename || '';
    $('document-meta').textContent = `${doc.pageCount || '—'} 页 · ${paragraphs().filter(eligibleParagraph).length} 段`;
    renderToc();
    renderPaper();
    updateTranslationCount();
    setupReadingObserver();
    renderChatMessages();
    renderPaperSession();
    updateTaskBanner();
    renderSelectedQuote();
    updateQualityControls();
  }
  function documentBusy(id = state.document?.id) {
    return state.reparsingDocuments.has(id) || state.submittingDocuments.has(id) || state.preparingSessions.has(id)
      || [...state.jobs.values()].some(job => job.documentId === id && !job.finished)
      || state.remoteReparses.has(id);
  }
  function qualityForCurrent() { return state.quality?.documentId === state.document?.id ? state.quality : null; }
  function updateQualityControls() {
    const quality = qualityForCurrent();
    const updating = state.reparsingDocuments.has(state.document?.id) || state.remoteReparses.has(state.document?.id);
    const canUpdate = Boolean(quality?.data?.parser?.updateAvailable);
    $('quality-button').textContent = updating ? '正在重新排版…' : canUpdate ? '排版检查 · 可更新' : '排版检查';
    $('quality-button').disabled = !state.document;
    $('quality-button').title = canUpdate ? '发现新解析版本，可检查并手动更新；已有译文会按原文变化保留或归档。' : '检查断段、公式与图表等排版问题';
    const busy = documentBusy() || Boolean(quality?.data?.busy);
    $('reparse-document').disabled = !state.document || !quality?.data || quality.loading || busy;
    $('refresh-quality').disabled = !state.document || quality?.loading || updating;
    $('reparse-document').textContent = updating ? '正在重新排版…' : canUpdate ? '更新并重新排版' : '重新解析排版';
    $('quality-operation').hidden = !updating;
    $('quality-busy').hidden = !busy || updating;
    $('quality-busy').textContent = quality?.data?.busyMessage || '当前论文有任务正在处理，完成后可重新排版。';
    $('translate-section').disabled = updating;
    $('retry-paper-session').disabled = updating;
  }
  function renderQuality() {
    if (!state.document) return;
    const value = qualityForCurrent();
    $('quality-document-title').textContent = state.document.title || state.document.filename || '当前论文';
    if (!value?.data) {
      $('quality-versions').textContent = '';
      $('quality-summary').textContent = value?.error || '正在检查排版质量…';
      $('quality-issues').innerHTML = '';
      updateQualityControls();
      return;
    }
    const { quality = {}, parser = {} } = value.data;
    const issues = Array.isArray(quality.issues) ? quality.issues : [];
    $('quality-versions').textContent = `当前解析 ${parser.current || '未记录'}  ·  最新版本 ${parser.latest || '未获取'}`;
    $('quality-summary').textContent = value.loading ? '正在重新检查…' : value.error ? value.error : parser.updateAvailable
      ? `有新解析版本可用。${issues.length ? `发现 ${issues.length} 项需要核对的排版提示。` : '可更新解析方式，改善图表、公式与断段识别。'}`
      : issues.length ? `当前已是最新解析版本，发现 ${issues.length} 项需要核对的排版提示。` : '当前已是最新解析版本，未发现明显排版问题。';
    const severity = { error:'需核对', warning:'注意', info:'提示', high:'需核对', medium:'注意', low:'提示' };
    const pages = [...new Set(issues.map(issue => Number.isInteger(Number(issue.page)) && Number(issue.page) >= 1 ? Number(issue.page) : 0))].sort((a,b) => a-b);
    $('quality-issues').innerHTML = pages.map(page => `<section class="quality-page"><h3>${page ? `第 ${page} 页` : '整篇检查'}</h3>${issues.map((issue,index) => ({issue,index})).filter(({issue}) => (Number.isInteger(Number(issue.page)) && Number(issue.page) >= 1 ? Number(issue.page) : 0) === page).map(({issue,index}) => {
      const location = issue.paragraphId && (paragraphById(issue.paragraphId) || state.document.peripheralBlocks?.find(p => p.id === issue.paragraphId));
      const formula = issue.assetId && state.document.mathAssets?.find(a => a.id === issue.assetId);
      const asset = issue.assetId && state.document.assets?.find(a => a.id === issue.assetId);
      const sourcePage = Number(issue.page);
      const validPage = Number.isInteger(sourcePage) && sourcePage >= 1 && sourcePage <= state.document.pageCount;
      return `<article class="quality-issue"><div><span class="quality-severity" data-severity="${escape(issue.severity || 'info')}">${escape(severity[issue.severity] || '提示')}</span><p>${escape(issue.message || issue.code || '请对照原页核对此处。')}</p></div><div class="quality-issue-actions">${location || asset || formula ? `<button class="button subtle small" data-quality-location="${index}">${formula ? '定位公式' : asset ? '定位图片' : '定位段落'} ↗</button>` : ''}${validPage ? `<button class="button subtle small" data-quality-source="${index}">查看原页 ↗</button>` : ''}</div></article>`;
    }).join('')}</section>`).join('') || '<div class="quality-empty">检查会关注段落、公式与图表边界。需要时仍可对照原始 PDF。</div>';
    updateQualityControls();
  }
  async function loadQuality({ quiet = false } = {}) {
    if (!state.document) return;
    const id = state.document.id, openToken = state.openToken, request = ++state.qualityRequest;
    const previous = qualityForCurrent();
    state.quality = { documentId:id, data:previous?.data || null, loading:true, error:'' };
    if (!quiet || $('quality-dialog').open) renderQuality();
    try {
      const result = await api(`/api/documents/${encodeURIComponent(id)}/quality`);
      if (state.document?.id !== id || state.openToken !== openToken || request !== state.qualityRequest) return;
      state.quality = { documentId:id, data:result, loading:false, error:'' };
      if (!result.busy) state.remoteReparses.delete(id);
    } catch (error) {
      if (state.document?.id !== id || state.openToken !== openToken || request !== state.qualityRequest) return;
      state.quality = { documentId:id, data:previous?.data || null, loading:false, error:`检查暂未完成：${plainError(error)}` };
    }
    renderQuality();
  }
  async function showQuality() {
    if (!state.document) return;
    renderQuality();
    $('quality-dialog').showModal();
    await loadQuality();
  }
  async function reparseDocument() {
    if (!state.document || documentBusy() || qualityForCurrent()?.data?.busy) return;
    const id = state.document.id, openToken = state.openToken;
    persistDraft();
    const scrollTop = $('reading-surface').scrollTop;
    state.reparsingDocuments.add(id);
    renderQuality();
    updateComposerState();
    let completed = false;
    try {
      const result = await post(`/api/documents/${encodeURIComponent(id)}/reparse`, {});
      completed = true;
      if (state.document?.id === id && state.openToken === openToken) {
        state.document = result.document || result;
        renderDocument();
        $('reading-surface').scrollTop = scrollTop;
        await loadQuality();
      }
      await loadLibrary();
      const reparse = result.document?.reparse;
      toast(reparse ? `排版已更新：保留 ${reparse.keptTranslations ?? 0} 段译文，归档 ${reparse.archivedTranslations ?? 0} 段；继续使用原论文对话。` : '排版已更新：未变的译文已保留，变动内容已备份；继续使用原论文对话。');
    } catch (error) {
      toast(`重新排版未完成：${plainError(error)}`, true);
      if (state.document?.id === id && state.openToken === openToken) await loadQuality();
    } finally {
      state.reparsingDocuments.delete(id);
      if (completed) state.remoteReparses.delete(id);
      updateQualityControls();
      updateComposerState();
    }
    if (completed && state.document?.id === id && state.openToken === openToken) ensurePaperSession(true).catch(() => {});
  }
  function showQualityLocation(index, originalPage = false) {
    const issue = qualityForCurrent()?.data?.quality?.issues?.[index];
    if (!issue) return;
    $('quality-dialog').close();
    if (originalPage) { showSource({ page:issue.page }); return; }
    setView('reflow');
    setMobileView('paper');
    const id = issue.paragraphId;
    const paragraph = id && document.querySelector(`[data-paragraph-id="${CSS.escape(id)}"]`);
    const peripheral = id && document.querySelector(`[data-peripheral-id="${CSS.escape(id)}"]`);
    const asset = issue.assetId && document.querySelector(`[data-asset-id="${CSS.escape(issue.assetId)}"]`)?.closest('.asset-card');
    const formula = issue.assetId && document.querySelector(`[data-math-id="${CSS.escape(issue.assetId)}"]`);
    const node = paragraph || peripheral || formula || asset;
    if (peripheral && $('peripheral-notes')) $('peripheral-notes').open = true;
    if (node) {
      node.scrollIntoView({ block:'center', behavior:'smooth' });
      node.classList.add('quality-focus');
      setTimeout(() => node.classList.remove('quality-focus'), 2200);
    } else if (issue.page) showSource({ page:issue.page });
  }
  function renderToc() {
    const sections = state.document.sections || [];
    $('toc-count').textContent = sections.length ? String(sections.length) : '';
    $('toc').innerHTML = sections.length ? sections.map(section => `<button class="toc-button ${state.activeSection === section.id ? 'active' : ''}" data-section-id="${escape(section.id)}">${escape(section.title || '正文')}</button>`).join('') : '<div class="sidebar-empty">未识别到章节，按正文顺序阅读</div>';
  }
  function sourceSentences(p) {
    return p.sentences?.length ? p.sentences : [{ id: `${p.id}-full`, text: p.text }];
  }
  function translationHtml(p) {
    if (!canTranslate(p)) return '';
    const t = p.translation;
    if (!t?.text) {
      const pending = [...state.jobs.values()].some(job => job.kind === 'translate' && job.paragraphIds.includes(p.id) && !job.finished);
      return `<div class="translation-placeholder"><button class="translate-link" data-action="translate" ${pending ? 'disabled' : ''}>${pending ? '<span class="spinner tiny"></span> Codex 正在翻译' : `${sparkIcon} 翻译本段`}</button></div>${p.translationError ? `<div class="translation-failure">${escape(p.translationError)}</div>` : ''}`;
    }
    const allIds = sourceSentences(p).map(s => s.id);
    const aligned = t.status !== 'paragraph-only' && t.alignments?.length && t.alignments.every(a => a.targetText && a.sourceIds?.length);
    const content = aligned ? t.alignments.map(a => `<span class="target-segment" data-links="${escape(a.sourceIds.join(' '))}">${mathHtml(a.targetText)}</span>`).join('') : `<span class="target-segment" data-links="${escape(allIds.join(' '))}">${mathHtml(t.text)}</span>`;
    const notes = t.notes || t.warnings || [];
    return `<div class="translation" lang="zh-CN"><div class="translation-label"><span>CODEX${aligned ? '' : ' · 段落联动'}</span><button data-action="translate" title="结合上下文重新翻译此段">重新翻译</button></div><div class="translation-text">${content}</div>${notes.length ? `<div class="translation-failure">${escape(notes.join('；'))}</div>` : ''}</div>`;
  }
  function paragraphHtml(p, index) {
    if (p.kind === 'metadata') {
      const image = p.sourceImageUrl && localImageUrl(p.sourceImageUrl);
      const content = image ? `<button class="metadata-image-button" data-action="metadata-image" title="放大查看作者与单位原貌"><img class="metadata-image" src="${escape(image)}" alt="论文作者与单位原貌" loading="lazy"></button><details class="metadata-text"><summary>查看文字 · 可选择复制</summary><div class="source-text" lang="en">${escape(p.rawText || p.text)}</div></details>` : `<div class="source-text" lang="en">${mathHtml(p.rawText || p.text)}</div>`;
      return `<section class="paragraph kind-metadata" data-paragraph-id="${escape(p.id)}" data-section-id="${escape(p.sectionId || '')}"><div class="paragraph-header"><button class="paragraph-location" data-action="source">P. ${escape(p.page || 1)} ↗</button><span class="metadata-label">${image ? '作者与单位 · 保留原貌' : '论文信息'}</span></div>${content}</section>`;
    }
    const sentenceList = sourceSentences(p);
    const allIds = sentenceList.map(s => s.id).join(' ');
    const fallback = p.translation?.status === 'paragraph-only';
    const source = sentenceList.map(s => `<span class="source-sentence" data-links="${escape(fallback ? allIds : s.id)}" data-source-id="${escape(s.id)}">${mathHtml(s.text)}</span>`).join(' ');
    return `<section class="paragraph kind-${escape(p.kind || 'paragraph')} ${p.translation?.text && canTranslate(p) ? 'paragraph-translated' : ''}" data-paragraph-id="${escape(p.id)}" data-section-id="${escape(p.sectionId || '')}"><div class="paragraph-header"><button class="paragraph-location" data-action="source" title="查看原文第 ${escape(p.page || 1)} 页">P. ${escape(p.page || 1)} ↗</button><span class="paragraph-number">${p.kind === 'equation' ? '原文公式' : String(index + 1).padStart(2,'0')}</span><div class="paragraph-actions"><button data-action="ask">${p.kind === 'equation' ? '询问公式' : '询问这段'} ↗</button></div></div><div class="source-text" lang="en">${source}</div>${translationHtml(p)}</section>`;
  }
  function renderPaper() {
    const doc = state.document;
    const warnings = doc.warnings || [];
    const warningHtml = warnings.length ? `<details class="parse-warning"><summary>阅读前提示 · ${warnings.length} 项解析说明</summary><div>${warnings.map(w => `<p>${escape(typeof w === 'string' ? w : w.message || JSON.stringify(w))}</p>`).join('')}</div></details>` : '';
    const assets = (doc.assets || []).filter(a => a.url);
    const usedAssets = new Set();
    let html = warningHtml;
    paragraphs().forEach((p, index) => {
      html += paragraphHtml(p, index);
      const next = paragraphs()[index + 1];
      {
        assets.filter(a => !usedAssets.has(a.id) && (a.afterParagraphId === p.id || ((!a.afterParagraphId || !paragraphs().some(candidate => candidate.id === a.afterParagraphId)) && Number(a.page) === Number(p.page) && (!next || next.page !== p.page)))).forEach(a => {
          usedAssets.add(a.id);
          const caption = a.caption || `第 ${a.page} 页 · 图片，可点击放大`;
          const imageLabel = (a.caption || `论文第 ${a.page} 页图片`).replace(/⟦MATH_[A-Za-z0-9_-]+⟧/gu, '原文公式');
          const imageBox = a.sourceBox || {};
          const imageWidth = Number(imageBox.x1) - Number(imageBox.x0);
          const imageHeight = Number(imageBox.y1) - Number(imageBox.y0);
          const imageStyle = Number.isFinite(imageWidth) && Number.isFinite(imageHeight) && imageWidth > 0 && imageHeight > 0
            ? ` style="aspect-ratio:${(imageWidth / imageHeight).toFixed(6)};width:100%;height:auto"` : '';
          const page = Number(a.page);
          const sourceButton = Number.isInteger(page) && page >= 1 && page <= doc.pageCount
            ? `<button class="asset-source-link" data-asset-source="${escape(a.id)}" title="对照图片所在的完整 PDF 原页">查看原页 · P. ${page} ↗</button>` : '';
          const fallbackLabel = a.cropStatus === 'page-fallback' ? '<span class="asset-source-kind">原页视图</span>' : '';
          html += `<figure class="asset-card"><button data-asset-id="${escape(a.id)}" title="放大查看"><img src="${escape(a.url)}" alt="${escape(imageLabel)}"${imageStyle} loading="lazy"></button><div class="asset-tools">${fallbackLabel}${sourceButton}</div><figcaption>${mathHtml(caption)}</figcaption></figure>`;
        });
      }
    });
    if (!paragraphs().length) html += '<div class="parse-warning">未能提取出可重排的正文。请切换到原始 PDF 查看；扫描版论文可能需要 OCR。</div>';
    const peripheral = doc.peripheralBlocks || [];
    if (peripheral.length) {
      const labels = { footnote:'脚注', publication:'出版信息', header:'页眉', footer:'页脚' };
      html += `<details class="peripheral-notes" id="peripheral-notes"><summary>脚注与出版信息 <span>${peripheral.length} 项</span></summary><div>${peripheral.map(item => `<section class="peripheral-item" data-peripheral-id="${escape(item.id)}"><div><span>${escape(labels[item.kind] || '附加信息')}</span><button data-peripheral-source="${escape(item.id)}">第 ${escape(item.page || 1)} 页 ↗</button></div><p>${mathHtml(item.text)}</p></section>`).join('')}</div></details>`;
    }
    $('paper').innerHTML = html;
    applyHighlights(state.pinned, true);
  }
  function updateTranslationCount() {
    const eligible = paragraphs().filter(eligibleParagraph);
    const translated = eligible.filter(p => p.translation?.text).length;
    $('translation-count').textContent = `已译 ${translated} / ${eligible.length} 段`;
  }
  function setupReadingObserver() {
    state.observer?.disconnect();
    state.observer = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) {
        const node = visible[0].target;
        state.currentParagraph = node.dataset.paragraphId;
        if (node.dataset.sectionId !== state.activeSection) {
          state.activeSection = node.dataset.sectionId;
          document.querySelectorAll('.toc-button').forEach(button => button.classList.toggle('active', button.dataset.sectionId === state.activeSection));
        }
        updateReadingPosition();
      }
    }, { root: $('reading-surface'), rootMargin: '0px 0px -65% 0px', threshold: 0 });
    document.querySelectorAll('.paragraph').forEach(node => state.observer.observe(node));
  }
  function updateReadingPosition() {
    const surface = $('reading-surface');
    const scrollable = surface.scrollHeight - surface.clientHeight;
    const percentage = scrollable > 0 ? Math.round(surface.scrollTop / scrollable * 100) : 0;
    $('progress-fill').style.width = `${Math.max(0, Math.min(100, percentage))}%`;
    const p = paragraphById(state.currentParagraph);
    $('reading-position').textContent = p ? `第 ${p.page || 1} / ${state.document?.pageCount || '—'} 页 · ${percentage}%` : '准备阅读';
  }
  function saveProgress() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      if (!state.document) return;
      const progress = { paragraphId: state.currentParagraph, scrollTop: $('reading-surface').scrollTop };
      state.document.progress = progress;
      post(docUrl('/progress'), progress).catch(() => {});
    }, 650);
  }
  function setView(view, page) {
    state.view = view;
    $('reading-surface').hidden = view !== 'reflow';
    $('pdf-surface').hidden = view !== 'pdf';
    $('reflow-button').classList.toggle('active', view === 'reflow');
    $('pdf-button').classList.toggle('active', view === 'pdf');
    $('reflow-button').setAttribute('aria-pressed', String(view === 'reflow'));
    $('pdf-button').setAttribute('aria-pressed', String(view === 'pdf'));
    $('translate-section').disabled = view === 'pdf';
    if (view === 'pdf' && state.document) {
      const url = `${docUrl('/file')}#page=${page || paragraphById(state.currentParagraph)?.page || 1}`;
      if ($('pdf-frame').getAttribute('src') !== url) $('pdf-frame').src = url;
    }
  }
  function showSource(p) {
    if (!p) return;
    openImage(`${docUrl(`/pages/${p.page || 1}.png`)}`, `原文第 ${p.page || 1} 页 · ${state.document.filename || ''}`);
  }
  function openImage(url, caption) {
    document.querySelector('.image-viewer')?.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'image-viewer';
    dialog.setAttribute('aria-label', '原文图像查看器');
    const header = document.createElement('header');
    header.className = 'viewer-header';
    const title = document.createElement('div');
    title.className = 'viewer-title';
    const heading = document.createElement('strong');
    heading.textContent = '原文图像';
    const hint = document.createElement('span');
    hint.textContent = '滚轮缩放 · 拖动查看';
    title.append(heading, hint);
    const controls = document.createElement('div');
    controls.className = 'viewer-controls';
    function control(label, action, description) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'viewer-button';
      button.textContent = label;
      button.title = description || label;
      button.setAttribute('aria-label', description || label);
      button.onclick = action;
      controls.append(button);
      return button;
    }
    const viewport = document.createElement('div');
    viewport.className = 'viewer-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', '可缩放图像，使用加减键缩放、0 适应窗口');
    const loading = document.createElement('div');
    loading.className = 'viewer-loading';
    loading.textContent = '正在读取原文图像…';
    const img = document.createElement('img');
    img.className = 'viewer-image';
    img.alt = caption || '原文图像';
    img.draggable = false;
    img.hidden = true;
    viewport.append(img, loading);
    const zoom = { scale: 1, fitScale: 1, x: 0, y: 0, width: 0, height: 0, fit: true };
    const clampScale = value => Math.max(.025, Math.min(8, value));
    function render() {
      const w = viewport.clientWidth, h = viewport.clientHeight;
      const imageW = zoom.width * zoom.scale, imageH = zoom.height * zoom.scale;
      zoom.x = imageW <= w ? (w - imageW) / 2 : Math.min(32, Math.max(w - imageW - 32, zoom.x));
      zoom.y = imageH <= h ? (h - imageH) / 2 : Math.min(32, Math.max(h - imageH - 32, zoom.y));
      img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
      const percentage = Math.round(zoom.scale * 100);
      percent.textContent = `${percentage}%`;
      dialog.dataset.zoom = String(percentage);
      dialog.dataset.scale = String(zoom.scale);
      dialog.dataset.fitScale = String(zoom.fitScale);
      dialog.dataset.translateX = String(zoom.x);
      dialog.dataset.translateY = String(zoom.y);
    }
    function fit() {
      if (!zoom.width) return;
      zoom.fitScale = clampScale(Math.min((viewport.clientWidth - 40) / zoom.width, (viewport.clientHeight - 40) / zoom.height, 1));
      zoom.scale = zoom.fitScale;
      zoom.fit = true;
      zoom.x = (viewport.clientWidth - zoom.width * zoom.scale) / 2;
      zoom.y = (viewport.clientHeight - zoom.height * zoom.scale) / 2;
      render();
    }
    function zoomAt(nextScale, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
      if (!zoom.width) return;
      const imageX = (x - zoom.x) / zoom.scale, imageY = (y - zoom.y) / zoom.scale;
      zoom.scale = clampScale(nextScale);
      zoom.x = x - imageX * zoom.scale;
      zoom.y = y - imageY * zoom.scale;
      zoom.fit = false;
      render();
    }
    control('−', () => zoomAt(zoom.scale / 1.25), '缩小（−）');
    const percent = document.createElement('output');
    percent.className = 'viewer-zoom-value';
    percent.textContent = '—';
    percent.setAttribute('aria-live', 'polite');
    controls.append(percent);
    control('＋', () => zoomAt(zoom.scale * 1.25), '放大（＋）');
    control('适应窗口', fit, '适应窗口（0）');
    control('100%', () => zoomAt(1), '原始像素尺寸（100%）');
    const close = control('×', () => dialog.close(), '关闭图像（Esc）');
    close.classList.add('viewer-close');
    header.append(title, controls);
    const footer = document.createElement('details');
    footer.className = 'viewer-caption';
    const summary = document.createElement('summary');
    summary.textContent = '查看原文说明';
    const text = document.createElement('p');
    text.textContent = caption || '原文图像';
    footer.append(summary, text);
    dialog.append(header, viewport, footer);
    const resize = new ResizeObserver(() => {
      if (!zoom.width) return;
      if (zoom.fit) fit(); else render();
    });
    dialog.addEventListener('close', () => { resize.disconnect(); dialog.remove(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(zoom.scale * 1.25); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomAt(zoom.scale / 1.25); }
      else if (event.key === '0') { event.preventDefault(); fit(); }
      else if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
    });
    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(zoom.scale * Math.exp(-event.deltaY * .0018), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    const pointers = new Map();
    let pan = null, pinch = null;
    const localPoint = event => { const rect = viewport.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      if (!zoom.width) return;
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, localPoint(event));
      viewport.classList.add('dragging');
      if (pointers.size === 1) pan = localPoint(event);
      if (pointers.size === 2) {
        const [a,b] = [...pointers.values()];
        const center = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
        pinch = { distance: Math.hypot(a.x-b.x, a.y-b.y), scale: zoom.scale, imageX:(center.x-zoom.x)/zoom.scale, imageY:(center.y-zoom.y)/zoom.scale };
      }
    });
    viewport.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      const point = localPoint(event);
      pointers.set(event.pointerId, point);
      if (pointers.size === 2 && pinch?.distance) {
        const [a,b] = [...pointers.values()];
        zoom.scale = clampScale(pinch.scale * Math.hypot(a.x-b.x, a.y-b.y) / pinch.distance);
        zoom.x = (a.x+b.x)/2 - pinch.imageX*zoom.scale;
        zoom.y = (a.y+b.y)/2 - pinch.imageY*zoom.scale;
        zoom.fit = false;
        render();
      } else if (pan) {
        zoom.x += point.x - pan.x;
        zoom.y += point.y - pan.y;
        zoom.fit = false;
        pan = point;
        render();
      }
    });
    const release = event => {
      pointers.delete(event.pointerId);
      pinch = null;
      pan = pointers.size === 1 ? [...pointers.values()][0] : null;
      if (!pointers.size) viewport.classList.remove('dragging');
    };
    viewport.addEventListener('pointerup', release);
    viewport.addEventListener('pointercancel', release);
    viewport.addEventListener('dblclick', event => {
      event.preventDefault();
      if (zoom.scale > zoom.fitScale * 1.3) fit();
      else { const point = localPoint(event); zoomAt(Math.max(1, zoom.fitScale * 2), point.x, point.y); }
    });
    img.onload = () => {
      zoom.width = img.naturalWidth;
      zoom.height = img.naturalHeight;
      dialog.dataset.naturalWidth = String(zoom.width);
      dialog.dataset.naturalHeight = String(zoom.height);
      img.style.width = `${zoom.width}px`;
      img.style.height = `${zoom.height}px`;
      img.hidden = false;
      loading.hidden = true;
      fit();
      viewport.focus({ preventScroll: true });
    };
    img.onerror = () => { loading.textContent = '图像加载失败，请关闭后查看原始 PDF。'; };
    document.body.append(dialog);
    dialog.showModal();
    resize.observe(viewport);
    img.src = url;
  }
  function applyHighlights(ids, pinned = false) {
    const selected = new Set(ids || []);
    document.querySelectorAll('[data-links]').forEach(node => {
      const matching = node.dataset.links.split(' ').some(id => selected.has(id));
      node.classList.toggle(pinned ? 'pinned' : 'linked-highlight', matching);
    });
  }
  function expandedLinks(node) {
    if (!node?.dataset.links) return [];
    let ids = new Set(node.dataset.links.split(' '));
    const p = node.closest('.paragraph');
    p?.querySelectorAll('.target-segment').forEach(target => {
      const links = target.dataset.links.split(' ');
      if (links.some(id => ids.has(id))) links.forEach(id => ids.add(id));
    });
    return [...ids];
  }
  async function importFile(file) {
    if (state.importing) return;
    if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return toast('请选择 PDF 文件。', true);
    if (file.size > 40 * 1024 * 1024) return toast('请先导入小于 40 MB 的 PDF 文件。', true);
    state.importing = true;
    $('import-progress').hidden = false;
    $('import-button').disabled = true;
    $('welcome-import').disabled = true;
    try {
      const result = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) }, body: file });
      const doc = result.document || result;
      await loadLibrary();
      await openDocument(doc.id, false);
      toast(`已导入 ${doc.pageCount || '—'} 页论文，可以开始阅读。`);
    } catch (error) { toast(`导入失败：${plainError(error)}`, true); }
    finally {
      state.importing = false;
      $('import-progress').hidden = true;
      $('import-button').disabled = false;
      $('welcome-import').disabled = false;
      $('file-input').value = '';
    }
  }
  async function refreshDocument() {
    if (!state.document) return;
    const id = state.document.id;
    const openToken = state.openToken;
    const result = await api(docUrl());
    if (state.document?.id !== id || state.openToken !== openToken) return;
    const scrollTop = $('reading-surface').scrollTop;
    state.document = result.document || result;
    renderDocument();
    $('reading-surface').scrollTop = scrollTop;
    await loadLibrary();
    if (state.document?.id === id && state.openToken === openToken) loadSessionHistory({ quiet:true }).catch(() => {});
  }
  function renderPaperSession() {
    const session = state.document?.session || { status:'unprepared' };
    const status = session.status || 'unprepared';
    const labels = { unprepared:'待准备', preparing:'准备中', ready:'已就绪', failed:'准备未完成' };
    $('paper-session-state').textContent = labels[status] || '待准备';
    $('paper-session-state').dataset.status = status;
    $('paper-session-title').textContent = session.title || state.document?.title || '独立的论文阅读会话';
    $('paper-session-title').title = session.title || state.document?.title || '';
    $('paper-session-explanation').textContent = status === 'ready' ? '结合论文与可靠资料核查来源' : '首次关联论文，之后继续同一个对话';
    const validId = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(session.threadId || '');
    $('open-paper-session').hidden = status !== 'ready' || !validId;
    $('copy-paper-session').hidden = status !== 'ready' || !validId;
    if (validId) $('open-paper-session').href = `codex://threads/${session.threadId}`;
    $('paper-session-notice').hidden = status === 'ready';
    $('paper-session-spinner').hidden = status !== 'preparing';
    $('retry-paper-session').hidden = !['failed','unprepared'].includes(status);
    const active = [...state.jobs.values()].find(job => job.kind === 'session' && !job.finished && job.documentId === state.document?.id);
    $('paper-session-message').textContent = status === 'preparing' ? '正在准备论文对话' : status === 'failed' ? '论文对话暂未准备完成' : '准备这篇论文的独立对话';
    $('paper-session-description').textContent = status === 'failed' ? String(session.error || '请重试准备，已有阅读记录会保留。').slice(0,600) : status === 'preparing' ? (active?.message || '首次登记本地 PDF 与阅读索引，完成后即可开始讨论。') : '登记一次本地论文资源，之后可继续同一会话；不代表永久记住全文。';
    $('session-sync-note').hidden = !state.chatHistory?.syncError;
    updateComposerState();
  }
  async function ensurePaperSession(retry = false) {
    if (!state.document) return;
    const id = state.document.id;
    if (state.reparsingDocuments.has(id) || state.remoteReparses.has(id)) return;
    const openToken = state.openToken;
    const session = state.document.session || { status:'unprepared' };
    if (session.status === 'ready' || (session.status === 'failed' && !retry) || state.preparingSessions.has(id)) return;
    state.preparingSessions.add(id);
    state.document.session = { ...session, status:'preparing', error:null };
    renderPaperSession();
    try {
      const result = await post(`/api/documents/${encodeURIComponent(id)}/session/prepare`, {});
      if (state.document?.id === id && state.openToken === openToken) {
        state.document.session = result.jobId && result.session?.status !== 'ready' ? { ...(result.session || state.document.session), status:'preparing', error:null } : result.session || state.document.session;
        renderPaperSession();
      }
      if (result.jobId && !state.jobs.has(result.jobId)) trackJob(result.jobId, { kind:'session', documentId:id });
      else if (state.document?.id === id && state.openToken === openToken && result.session?.status === 'ready') await loadSessionHistory({ quiet:false });
    } catch (error) {
      if (state.document?.id === id && state.openToken === openToken) { state.document.session = { ...state.document.session, status:'failed', error:plainError(error) }; renderPaperSession(); }
    } finally { state.preparingSessions.delete(id); updateQualityControls(); }
  }
  async function loadSessionHistory({ older = false, reset = false, quiet = false } = {}) {
    if (!state.document || !state.chatHistory) return;
    const id = state.document.id;
    const historyState = state.chatHistory;
    if (historyState.documentId !== id || historyState.loading || historyState.loadingOlder || (older && !historyState.hasMore)) return;
    if (quiet && Date.now() - historyState.fetchedAt < 1200) return;
    const oldAnchor = older ? { height:$('chat-messages').scrollHeight, top:$('chat-messages').scrollTop } : null;
    historyState[older ? 'loadingOlder' : 'loading'] = true;
    if (older) renderChatMessages();
    const query = new URLSearchParams({ limit:'30' });
    if (older && historyState.nextCursor) query.set('cursor',historyState.nextCursor);
    try {
      const result = await api(`/api/documents/${encodeURIComponent(id)}/session/history?${query}`);
      if (state.document?.id !== id || state.chatHistory !== historyState) return;
      const incoming = (result.messages || []).filter(item => item && typeof item.id === 'string' && ['user','assistant'].includes(item.role) && typeof item.text === 'string');
      if (reset || !historyState.loaded) {
        historyState.messages = incoming;
        historyState.nextCursor = result.nextCursor || null;
        historyState.hasMore = Boolean(result.hasMore);
      } else if (older) {
        const seen = new Set();
        historyState.messages = [...incoming,...historyState.messages].filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
        historyState.nextCursor = result.nextCursor || null;
        historyState.hasMore = Boolean(result.hasMore);
      } else {
        const messages = new Map(historyState.messages.map(item => [item.id,item]));
        incoming.forEach(item => messages.set(item.id,item));
        historyState.messages = [...messages.values()];
        if (!historyState.hasMore && result.hasMore && Number(result.total) > historyState.messages.length) { historyState.hasMore = true; historyState.nextCursor = result.nextCursor || null; }
      }
      historyState.total = Number(result.total) || historyState.messages.length;
      historyState.loaded = true;
      historyState.syncError = result.syncError || '';
      historyState.fetchedAt = Date.now();
      if (result.session && !(result.session.status === 'unprepared' && state.document.session?.status !== 'unprepared') && !(state.document.session?.status === 'ready' && result.session.status !== 'ready')) state.document.session = result.session;
      renderPaperSession();
    } catch (error) {
      if (state.document?.id !== id || state.chatHistory !== historyState) return;
      historyState.syncError = plainError(error);
      if (!quiet) toast(`聊天记录同步暂不可用：${plainError(error)}`, true);
    } finally {
      historyState.loading = false;
      historyState.loadingOlder = false;
      if (state.document?.id === id && state.chatHistory === historyState) { renderPaperSession(); renderChatMessages({ preserveAnchor:oldAnchor }); }
    }
  }
  async function translate(ids, force = false, remaining = 0) {
    if (!state.document || !ids.length) return;
    if (state.reparsingDocuments.has(state.document.id) || state.remoteReparses.has(state.document.id)) return toast('正在更新排版，请稍候再翻译。');
    const documentId = state.document.id;
    const pendingIds = new Set([...state.jobs.values()].filter(j => !j.finished && j.kind === 'translate').flatMap(j => j.paragraphIds));
    ids = ids.filter(id => !pendingIds.has(id));
    if (!ids.length) return toast('这段已在翻译队列中。');
    try {
      const result = await post(`/api/documents/${encodeURIComponent(documentId)}/translate`, { paragraphIds: ids, force });
      trackJob(result.jobId || result.id, { kind: 'translate', paragraphIds: ids, documentId });
      if (state.document?.id === documentId) renderPaper();
      toast(remaining ? `本次已交给 Codex ${ids.length} 段，本节剩余 ${remaining} 段可在完成后继续翻译。` : ids.length === 1 ? '已交给 Codex，译文完成后会出现在原文下方。' : `已将 ${ids.length} 段交给 Codex 翻译。`);
    } catch (error) { toast(plainError(error), true); }
  }
  async function pollJob(id) {
    const tracked = state.jobs.get(id);
    if (!tracked || tracked.finished || tracked.polling) return;
    const viewToken = state.openToken;
    tracked.polling = true;
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}`);
      tracked.message = result.message;
      tracked.status = result.status;
      tracked.model = result.model;
      tracked.reasoningEffort = result.reasoningEffort;
      tracked.executionMode = result.executionMode;
      tracked.configurationSource = result.configurationSource;
      tracked.requestedModel = result.requestedModel;
      tracked.requestedReasoningEffort = result.requestedReasoningEffort;
      tracked.elapsedMs = result.elapsedMs;
      tracked.threadId = result.threadId;
      tracked.result = result.result;
      tracked.error = result.error;
      updateTaskBanner();
      if (tracked.kind === 'ask' && state.document?.id === tracked.documentId && state.openToken === viewToken) renderChatMessages();
      if (tracked.kind === 'session' && state.document?.id === tracked.documentId && state.openToken === viewToken) renderPaperSession();
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status)) {
        tracked.finished = true;
        if (tracked.kind === 'ask') {
          const queueOwnerCancelled = result.status === 'cancelled' && (result.executionMode === 'queue-owner' || result.configurationSource === 'thread');
          const recovered = drafts.settle(tracked.documentId, id, result.status, { restore:!queueOwnerCancelled });
          if (recovered.restored && state.document?.id === tracked.documentId) {
            restoreDraft();
            toast('回答未完成，原问题和引用已恢复到草稿。');
          }
        }
        if (tracked.kind === 'translate') {
          if (state.document?.id === tracked.documentId && state.openToken === viewToken) await refreshDocument();
          if (result.status === 'completed') toast(`Codex 已完成 ${result.result?.translated ?? tracked.paragraphIds.length} 段翻译。`);
          else {
            const queuedInApp = result.executionMode === 'queue-owner' || result.configurationSource === 'thread';
            const cancelledText = queuedInApp ? (result.message || '已停止等待；已提交的 Codex 任务仍可能继续完成。') : '翻译任务已取消，已完成的译文会保留。';
            toast(result.status === 'cancelled' ? cancelledText : `翻译未完成：${result.error || result.message || '任务已取消'}`, result.status !== 'cancelled');
          }
        } else if (tracked.kind === 'session') {
          if (state.document?.id === tracked.documentId && state.openToken === viewToken) {
            await refreshDocument();
            if (state.document?.id !== tracked.documentId || state.openToken !== viewToken) return;
            if (result.status !== 'completed' && state.document.session?.status !== 'ready') state.document.session = { ...state.document.session, status:'failed', error:result.error || result.message || '准备未完成，请重试。' };
            renderPaperSession();
            if (result.status === 'completed') await loadSessionHistory({ quiet:false });
          }
        } else {
          if (state.document?.id === tracked.documentId && state.openToken === viewToken) {
            if (result.status === 'completed') { await refreshDocument(); if (state.document?.id !== tracked.documentId || state.openToken !== viewToken) return; await loadSessionHistory({ quiet:false }); }
            if (state.document?.id !== tracked.documentId || state.openToken !== viewToken) return;
            renderChatMessages();
          }
        }
        updateTaskBanner();
        if (state.document?.id === tracked.documentId && $('quality-dialog').open) loadQuality({ quiet:true }).catch(() => {});
        return;
      }
    } catch (error) {
      tracked.failures = (tracked.failures || 0) + 1;
      if (tracked.failures > 5) {
        tracked.finished = true;
        tracked.status = 'failed';
        tracked.error = `读取任务进度失败：${plainError(error)}`;
        toast(`读取任务进度失败：${plainError(error)}`, true);
        if (tracked.kind === 'ask' && state.document?.id === tracked.documentId && state.openToken === viewToken) renderChatMessages();
        if (tracked.kind === 'session' && state.document?.id === tracked.documentId && state.openToken === viewToken) { state.document.session = { ...state.document.session, status:'failed', error:tracked.error }; renderPaperSession(); }
        updateTaskBanner();
        return;
      }
    } finally { tracked.polling = false; }
    tracked.timer = setTimeout(() => pollJob(id), 1500);
  }
  function trackJob(id, details) {
    if (!id) return toast('服务没有返回任务编号，请稍后重试。', true);
    state.jobs.set(id, { createdAt: new Date().toISOString(), status:'queued', ...details, finished: false });
    updateTaskBanner();
    if (details.kind === 'ask') renderChatMessages();
    if (details.kind === 'session' && state.document?.id === details.documentId) renderPaperSession();
    pollJob(id);
  }
  function updateTaskBanner() {
    updateQualityControls();
    const task = [...state.jobs.entries()].find(([, job]) => job.kind === 'translate' && !job.finished && job.documentId === state.document?.id);
    $('task-banner').hidden = !task;
    if (!task) return;
    $('task-banner').dataset.jobId = task[0];
    const job = task[1];
    const fromThread = job.executionMode === 'queue-owner' || job.configurationSource === 'thread';
    const configuration = fromThread ? '沿用 Codex 对话模型/推理设置' : job.model ? `${job.model} / ${job.reasoningEffort ?? '未记录'}` : '';
    const execution = [configuration, job.elapsedMs != null ? elapsedLabel(job.elapsedMs) : ''].filter(Boolean).join(' · ');
    $('task-message').textContent = [job.message || '已提交，等待 Codex 翻译…', execution].filter(Boolean).join(' · ');
    $('cancel-task').disabled = false;
  }
  async function cancelTask() {
    const id = $('task-banner').dataset.jobId;
    if (!id) return;
    $('cancel-task').disabled = true;
    try {
      await post(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
      const tracked = state.jobs.get(id);
      if (tracked) { clearTimeout(tracked.timer); pollJob(id); }
    } catch (error) { toast(plainError(error), true); $('cancel-task').disabled = false; }
  }
  function answerHtml(result) {
    const body = renderSafeMarkdown(result.answer || '');
    const citations = (result.citations || []).map(c => `<button data-citation-id="${escape(c.paragraphId)}" title="${escape(c.quote || '查看原文')}">第 ${escape(c.page || paragraphById(c.paragraphId)?.page || '—')} 页 · 查看依据 ↗</button>`).join('');
    return `<div class="chat-answer-text">${body}</div>${citations ? `<div class="answer-citations">${citations}</div>` : ''}${result.uncertainty ? `<div class="answer-uncertainty">${escape(result.uncertainty)}</div>` : ''}`;
  }
  function quotedHtml(item) {
    if (!item.selectedText) return '';
    const page = paragraphById(item.paragraphId)?.page;
    return `<details class="message-quote"><summary>已引用${page ? ` · 第 ${escape(page)} 页` : ''}</summary><div>${mathHtml(item.selectedText)}</div></details>`;
  }
  function userMessageHtml(item) {
    return `<div class="chat-user"><div class="message-role">你</div><div class="chat-user-bubble">${quotedHtml(item)}<div class="chat-question-text">${escape(item.question || '请解释所选内容。')}</div></div></div>`;
  }
  function updateComposerState() {
    const pending = [...state.jobs.values()].some(job => job.kind === 'ask' && !job.finished && job.documentId === state.document?.id);
    const empty = !$('question-input').value.trim() && !state.selected;
    const status = state.document?.session?.status || 'unprepared';
    const ready = status === 'ready';
    const submitting = state.submittingDocuments.has(state.document?.id);
    const reparsing = state.reparsingDocuments.has(state.document?.id) || state.remoteReparses.has(state.document?.id);
    const invalidQuote = resolveDraftSelection(state.selected, paragraphs()).stale;
    $('ask-button').disabled = !state.document || !ready || pending || submitting || reparsing || empty || invalidQuote;
    $('question-input').disabled = !state.document;
    $('question-input').placeholder = ready ? '询问论文，也可查找官方源码、补充材料并核查来源…' : '可以先写下问题，论文对话准备完成后发送…';
    $('mobile-chat-badge').hidden = !pending && status !== 'preparing';
    $('mobile-chat-badge').textContent = status === 'preparing' ? '准备中' : '正在回答';
    $('answer-status').textContent = reparsing ? '正在更新排版，问题草稿会保留。' : submitting ? '正在提交…' : !ready ? (status === 'failed' ? '论文对话准备未完成，可重试。' : '正在准备这篇论文的独立对话…') : pending ? 'Codex 正在结合论文与相关来源分析，可继续阅读。' : invalidQuote ? '引用已与当前正文或译文不符，请重新选择或清除引用后发送。' : '可结合论文与可靠资料核查来源 · Ctrl / ⌘ + Enter 发送';
  }
  function renderChatMessages({ preserveAnchor = null } = {}) {
    const container = $('chat-messages');
    const viewToken = state.openToken;
    const documentId = state.document?.id;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 110;
    const history = state.chatHistory;
    const stored = history?.loaded ? history.messages : (state.document?.answers || []).flatMap((item,index) => [
      { ...item, id:`saved-${index}-user`, role:'user', text:item.question || '请解释所选内容。' },
      { ...item, id:`saved-${index}-assistant`, role:'assistant', text:item.answer || '' },
    ]);
    let html = history?.hasMore ? `<div class="chat-history-pager"><button class="button subtle small" data-load-history ${history.loadingOlder ? 'disabled' : ''}>${history.loadingOlder ? '正在加载…' : '加载更早消息 ↑'}</button><span>已显示 ${stored.length} / ${history.total || stored.length} 条消息</span></div>` : '';
    html += stored.map(item => `<article class="chat-message role-${escape(item.role)}" data-message-id="${escape(item.id)}">${item.role === 'user' ? userMessageHtml({ ...item, question:item.text }) : `<div class="chat-assistant"><div class="message-role"><span class="codex-mark">✳</span> Codex</div>${answerHtml({ ...item, answer:item.text })}</div>`}</article>`).join('');
    const tasks = [...state.jobs.entries()].filter(([,job]) => job.kind === 'ask' && job.documentId === state.document?.id);
    tasks.forEach(([id, job]) => {
      const waiting = !job.finished;
      const failed = job.finished && job.status !== 'completed';
      const result = typeof job.result === 'string' ? { answer:job.result } : job.result || {};
      const queuedInApp = job.executionMode === 'queue-owner' || job.configurationSource === 'thread';
      const failureText = job.status === 'cancelled' && queuedInApp ? (job.message || '已停止等待；已提交的 Codex 任务仍可能继续完成。') : (job.error || job.message || '任务未完成。');
      const recent = item => new Date(item.createdAt || 0).getTime() >= new Date(job.createdAt).getTime() - 2000;
      const savedUser = stored.some(item => item.role === 'user' && (item.jobId === id || (item.text === job.question && recent(item))));
      const savedAssistant = stored.some(item => item.role === 'assistant' && (item.jobId === id || (job.finished && result.answer && item.text === result.answer && recent(item))));
      if (savedAssistant) return;
      const cancelWaiting = waiting && (!job.target || job.target === 'reader') ? `<button class="button subtle small" data-cancel-chat-job="${escape(id)}" ${job.cancelRequested ? 'disabled' : ''}>${job.cancelRequested ? '正在停止…' : '停止等待'}</button>` : '';
      let content = waiting ? `<div class="chat-pending"><span class="spinner"></span><span>${escape(job.message || 'Codex 正在阅读上下文…')}</span>${cancelWaiting}</div>` : failed ? `<div class="chat-job-error">${escape(failureText)}<button class="button subtle small" data-retry-job="${escape(id)}">恢复问题 ↗</button></div>` : answerHtml(result);
      html += `<article class="chat-turn" data-chat-job="${escape(id)}">${savedUser ? '' : userMessageHtml(job)}<div class="chat-assistant"><div class="message-role"><span class="codex-mark">✳</span> Codex</div>${content}</div></article>`;
    });
    container.innerHTML = html || '<div class="chat-empty"><span class="codex-mark">✳</span><h2>一起读懂这篇论文</h2><p>可以选中左侧内容深入讨论，也可请 Codex 查找官方源码、补充材料并核查来源。</p><div>例如：论文方法与官方实现有什么区别？<br>这个假设的依据在哪里？</div></div>';
    if (preserveAnchor) requestAnimationFrame(() => { if (state.openToken === viewToken && state.document?.id === documentId) container.scrollTop = container.scrollHeight - preserveAnchor.height + preserveAnchor.top; });
    else if (atBottom || state.forceChatScroll) requestAnimationFrame(() => { if (state.openToken === viewToken && state.document?.id === documentId) container.scrollTop = container.scrollHeight; });
    state.forceChatScroll = false;
    updateComposerState();
  }
  function clearSelection() {
    state.selected = null;
    renderSelectedQuote();
    persistDraft();
    updateComposerState();
  }
  function renderSelectedQuote() {
    const resolved = resolveDraftSelection(state.selected, paragraphs());
    const changed = !sameDraftContent({ selection:state.selected }, { selection:resolved.selection });
    const selected = state.selected = resolved.selection;
    $('quote-draft').hidden = !selected?.selectedText;
    $('quote-draft').dataset.status = resolved.stale ? 'stale' : 'ready';
    if (!selected?.selectedText) { $('selected-source').innerHTML = ''; return; }
    const paragraph = paragraphById(selected.paragraphId);
    const page = paragraph?.page || selected.page;
    const label = resolved.stale ? '引用需重新选择或清除 · 草稿原文已保留' : '待发送引用';
    $('selected-source').innerHTML = `<small>${page ? `原文第 ${escape(page)} 页 · ` : ''}${label}</small>${mathHtml(selected.selectedText)}`;
    if (changed) persistDraft();
  }
  function persistDraft() {
    if (!state.document) return null;
    return drafts.write(state.document.id, { question:$('question-input').value, selection:state.selected });
  }
  function restoreDraft() {
    if (!state.document) return;
    const draft = drafts.read(state.document.id);
    $('question-input').value = draft.question;
    state.selected = draft.selection;
    renderSelectedQuote();
    updateComposerState();
  }
  function recoverQuestion(job) {
    if (!state.document || job.documentId !== state.document.id) return;
    const recovered = { question:job.question || '', selection:job.selectedText ? { paragraphId:job.paragraphId, selectedText:job.selectedText, page:job.page || paragraphById(job.paragraphId)?.page } : null };
    recovered.selection = resolveDraftSelection(recovered.selection, paragraphs()).selection;
    const current = persistDraft();
    if (hasDraftContent(current) && !sameDraftContent(current, recovered)) {
      toast('输入框中已有未发送的草稿，已为你保留。请先处理草稿，再恢复原问题。');
      return;
    }
    drafts.write(state.document.id, recovered);
    restoreDraft();
    setMobileView('chat');
    $('question-input').focus();
  }
  function setMobileView(view) {
    const chat = view === 'chat';
    $('workspace').classList.toggle('show-chat', chat);
    $('paper-tab').classList.toggle('active', !chat);
    $('chat-tab').classList.toggle('active', chat);
    $('paper-tab').setAttribute('aria-selected', String(!chat));
    $('chat-tab').setAttribute('aria-selected', String(chat));
  }
  function applyChatWidth(nextWidth) {
    const width = $('workspace').clientWidth;
    if (width < 600) return;
    const wanted = (nextWidth ?? state.chatWidth) || Math.round(width * .38);
    const size = Math.max(360, Math.min(Math.max(360, width - 330), wanted));
    $('workspace').style.setProperty('--chat-width', `${size}px`);
    $('chat-divider').setAttribute('aria-valuenow', String(Math.round(size)));
    $('chat-divider').setAttribute('aria-valuemax', String(Math.max(360, width - 330)));
    $('chat-divider').setAttribute('aria-valuetext', `聊天宽度 ${Math.round(size)} 像素`);
  }
  function openQuestion(paragraphId, selectedText, explain = false) {
    const p = paragraphById(paragraphId);
    if (!p) return;
    state.selected = { paragraphId, selectedText: selectedText?.trim() || p.text, page:p.page };
    $('selection-menu').hidden = true;
    renderSelectedQuote();
    if (explain && !$('question-input').value.trim()) $('question-input').value = '请结合论文上下文解释这段内容，说明关键概念、符号和论证关系。';
    persistDraft();
    setMobileView('chat');
    updateComposerState();
    $('question-input').focus();
  }
  async function ask() {
    if (!state.document || state.submittingDocuments.has(state.document.id) || state.reparsingDocuments.has(state.document.id) || state.remoteReparses.has(state.document.id)) return;
    if ([...state.jobs.values()].some(job => job.kind === 'ask' && !job.finished && job.documentId === state.document.id)) return;
    if (state.document.session?.status !== 'ready') return toast('请等待论文对话准备完成后再发送。');
    const resolved = resolveDraftSelection(state.selected, paragraphs());
    if (resolved.stale) {
      renderSelectedQuote();
      updateComposerState();
      return toast('引用已与当前正文或译文不符。原问题已保留，请重新选择或清除引用。', true);
    }
    state.selected = resolved.selection;
    const question = $('question-input').value.trim() || (state.selected ? '请结合论文上下文解释选中内容。' : '');
    if (!question) return;
    const selection = state.selected ? { ...state.selected } : {};
    const documentId = state.document.id;
    const snapshot = { ...persistDraft(), question, selection:state.selected ? { ...state.selected } : null };
    state.submittingDocuments.add(documentId);
    updateComposerState();
    updateQualityControls();
    try {
      const result = await post(`/api/documents/${encodeURIComponent(documentId)}/ask`, { ...selection, question, target:'reader' });
      const jobId = result.jobId || result.id;
      if (!jobId) throw new Error('服务未返回任务编号，问题草稿已保留。');
      drafts.accept(documentId, snapshot, jobId);
      if (state.document?.id === documentId) { restoreDraft(); state.forceChatScroll = true; }
      trackJob(jobId, { kind:'ask', target:'reader', documentId, question, ...selection });
    } catch (error) {
      toast(plainError(error), true);
    } finally { state.submittingDocuments.delete(documentId); updateComposerState(); updateQualityControls(); }
  }
  function detectSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    let node = selection.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const paragraph = node?.closest?.('.paragraph');
    if (!paragraph || !$('paper').contains(node) || paragraph.classList.contains('kind-metadata')) return;
    const text = selection.toString().trim();
    if (text.length > 12000) return toast('请选中较短的内容，Codex 会自动补充相关上下文。');
    state.menuSelection = { paragraphId: paragraph.dataset.paragraphId, selectedText: text };
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    $('selection-menu').hidden = false;
    const menuRect = $('selection-menu').getBoundingClientRect();
    $('selection-menu').style.left = `${Math.max(8, Math.min(innerWidth - menuRect.width - 8, rect.left + rect.width / 2 - menuRect.width / 2))}px`;
    $('selection-menu').style.top = `${rect.top > 60 ? rect.top - menuRect.height - 9 : rect.bottom + 9}px`;
  }
  function connectEvents() {
    if (!window.EventSource) return;
    state.events = new EventSource('/api/events');
    const onEvent = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'document-updated' && data.documentId === state.document?.id) refreshDocument().catch(() => {});
        if (data.type === 'job-updated' && data.jobId && state.jobs.has(data.jobId)) {
          const tracked = state.jobs.get(data.jobId);
          clearTimeout(tracked.timer);
          pollJob(data.jobId);
        }
      } catch (_) {}
    };
    state.events.onmessage = onEvent;
    state.events.addEventListener('document-updated', onEvent);
    state.events.addEventListener('job-updated', onEvent);
  }

  $('sidebar-toggle').onclick = () => {
    $('app').classList.toggle(innerWidth <= 980 ? 'mobile-nav-open' : 'nav-collapsed');
  };
  $('theme-toggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('font-smaller').onclick = () => setFont(state.fontSize - 1);
  $('font-larger').onclick = () => setFont(state.fontSize + 1);
  $('reading-width').onclick = () => setWidthMode(state.widthMode === 'full' ? 'comfortable' : 'full');
  $('quality-button').onclick = showQuality;
  $('close-quality').onclick = () => $('quality-dialog').close();
  $('refresh-quality').onclick = () => loadQuality();
  $('reparse-document').onclick = reparseDocument;
  $('quality-dialog').addEventListener('click', event => {
    if (event.target === $('quality-dialog')) { $('quality-dialog').close(); return; }
    const source = event.target.closest('[data-quality-source]');
    const location = event.target.closest('[data-quality-location]');
    if (source) showQualityLocation(Number(source.dataset.qualitySource), true);
    else if (location) showQualityLocation(Number(location.dataset.qualityLocation));
  });
  $('import-button').onclick = $('welcome-import').onclick = () => $('file-input').click();
  $('file-input').onchange = event => importFile(event.target.files[0]);
  $('connection-button').onclick = () => { $('status-popover').hidden = !$('status-popover').hidden; if (!$('status-popover').hidden) refreshSettings(); };
  $('refresh-status').onclick = () => Promise.allSettled([refreshStatus(), refreshSettings()]);
  $('translation-preset').onchange = savePreset;
  $('show-job-history').onclick = showJobHistory;
  $('close-job-history').onclick = () => $('job-history-dialog').close();
  $('refresh-job-history').onclick = loadJobHistory;
  $('job-history-dialog').addEventListener('close', () => { clearInterval(state.historyTimer); state.historyTimer = null; });
  $('job-history-dialog').addEventListener('click', event => { if (event.target === $('job-history-dialog')) $('job-history-dialog').close(); });
  $('cancel-task').onclick = cancelTask;
  $('reflow-button').onclick = () => setView('reflow');
  $('pdf-button').onclick = () => setView('pdf');
  $('ask-button').onclick = ask;
  $('retry-paper-session').onclick = () => ensurePaperSession(true);
  $('retry-session-sync').onclick = () => loadSessionHistory({ reset:true, quiet:false });
  $('open-paper-session').onclick = event => {
    const id = state.document?.session?.threadId;
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id || '')) { event.preventDefault(); return; }
    toast('已发起在 Codex App 打开的请求；若没有跳转，可复制会话 ID 在 App 中查找。');
  };
  $('copy-paper-session').onclick = async () => {
    const id = state.document?.session?.threadId;
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(id);
      else {
        const field = document.createElement('textarea');
        field.value = id; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('无法复制');
      }
      toast('已复制当前论文的会话 ID。');
    } catch (_) { toast(`会话 ID：${id}`); }
  };
  $('clear-selection').onclick = clearSelection;
  $('paper-tab').onclick = () => setMobileView('paper');
  $('chat-tab').onclick = () => { setMobileView('chat'); $('question-input').focus(); };
  $('question-input').addEventListener('input', () => { persistDraft(); updateComposerState(); });
  $('question-input').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('ask-button').click(); } });
  $('selection-explain').onclick = () => { if (state.menuSelection) openQuestion(state.menuSelection.paragraphId, state.menuSelection.selectedText, true); };
  $('selection-question').onclick = () => { if (state.menuSelection) openQuestion(state.menuSelection.paragraphId, state.menuSelection.selectedText); };
  $('selection-menu').addEventListener('mousedown', event => event.preventDefault());
  $('library-list').addEventListener('click', event => {
    const button = event.target.closest('[data-doc-id]');
    if (button) openDocument(button.dataset.docId).catch(error => toast(plainError(error), true));
  });
  $('toc').addEventListener('click', event => {
    const button = event.target.closest('[data-section-id]');
    if (!button) return;
    setView('reflow');
    const p = paragraphs().find(p => p.sectionId === button.dataset.sectionId);
    if (p) document.querySelector(`[data-paragraph-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('app').classList.remove('mobile-nav-open');
  });
  $('translate-section').onclick = () => {
    const section = state.activeSection || paragraphs()[0]?.sectionId;
    const ids = paragraphs().filter(p => eligibleParagraph(p) && (!section || p.sectionId === section) && !p.translation?.text).map(p => p.id);
    if (!ids.length) return toast('本节已全部翻译。');
    translate(ids.slice(0, 80), false, Math.max(0, ids.length - 80));
  };
  $('paper').addEventListener('click', event => {
    const peripheralSource = event.target.closest('[data-peripheral-source]');
    if (peripheralSource) { const item = state.document?.peripheralBlocks?.find(block => block.id === peripheralSource.dataset.peripheralSource); if (item) showSource(item); return; }
    const mathNode = event.target.closest('[data-math-id]');
    if (mathNode) { const asset = mathAsset(mathNode.dataset.mathId); if (asset) openImage(asset.url, `原文公式 · 第 ${asset.page || 1} 页${asset.alt ? ` · ${asset.alt}` : ''}`); return; }
    const assetSource = event.target.closest('[data-asset-source]');
    if (assetSource) {
      const item = state.document?.assets?.find(a => a.id === assetSource.dataset.assetSource);
      const page = Number(item?.page);
      if (Number.isInteger(page) && page >= 1 && page <= state.document.pageCount) openImage(docUrl(`/pages/${page}.png`), `原文第 ${page} 页 · 图片与版面完整对照`);
      return;
    }
    const asset = event.target.closest('[data-asset-id]');
    if (asset) { const item = state.document.assets.find(a => a.id === asset.dataset.assetId); if (item) openImage(item.url, item.caption || `第 ${item.page} 页图片`); return; }
    const action = event.target.closest('[data-action]');
    const pNode = event.target.closest('[data-paragraph-id]');
    if (!pNode) return;
    const p = paragraphById(pNode.dataset.paragraphId);
    if (action) {
      if (action.dataset.action === 'translate') translate([p.id], !!p.translation?.text);
      if (action.dataset.action === 'ask') openQuestion(p.id);
      if (action.dataset.action === 'source') showSource(p);
      if (action.dataset.action === 'metadata-image' && p.sourceImageUrl) openImage(p.sourceImageUrl, `作者与单位原貌 · 第 ${p.page || 1} 页`);
      return;
    }
    if (window.getSelection()?.toString().trim()) return;
    const linked = event.target.closest('[data-links]');
    if (linked) {
      const ids = expandedLinks(linked);
      state.pinned = ids.length === state.pinned.length && ids.every(id => state.pinned.includes(id)) ? [] : ids;
      applyHighlights(state.pinned, true);
    }
  });
  $('paper').addEventListener('pointerover', event => {
    const node = event.target.closest('[data-links]');
    if (node) applyHighlights(expandedLinks(node));
  });
  $('paper').addEventListener('pointerout', event => {
    const node = event.relatedTarget?.closest?.('[data-links]');
    applyHighlights(node ? expandedLinks(node) : []);
  });
  $('paper').addEventListener('mouseup', () => setTimeout(detectSelection, 0));
  $('paper').addEventListener('keyup', detectSelection);
  $('paper').addEventListener('error', event => {
    if (!event.target.classList?.contains('metadata-image')) return;
    event.target.closest('.metadata-image-button').hidden = true;
    const fallback = event.target.closest('.kind-metadata')?.querySelector('.metadata-text');
    if (fallback) fallback.open = true;
  }, true);
  $('chat-messages').addEventListener('click', event => {
    if (event.target.closest('[data-load-history]')) { loadSessionHistory({ older:true }); return; }
    const cancel = event.target.closest('[data-cancel-chat-job]');
    if (cancel) {
      const id = cancel.dataset.cancelChatJob;
      const job = state.jobs.get(id);
      if (!job || job.kind !== 'ask' || job.finished || job.cancelRequested || job.documentId !== state.document?.id || (job.target && job.target !== 'reader')) return;
      job.cancelRequested = true;
      cancel.disabled = true;
      cancel.textContent = '正在停止…';
      post(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}).then(result => {
        if (result.message) job.message = result.message;
        clearTimeout(job.timer);
        pollJob(id);
      }).catch(error => {
        job.cancelRequested = false;
        toast(plainError(error), true);
        if (job.documentId === state.document?.id) renderChatMessages();
      });
      return;
    }
    const retry = event.target.closest('[data-retry-job]');
    if (retry) {
      const job = state.jobs.get(retry.dataset.retryJob);
      if (!job) return;
      recoverQuestion(job);
      return;
    }
    const math = event.target.closest('[data-math-id]');
    if (math) { const asset = mathAsset(math.dataset.mathId); if (asset) openImage(asset.url, `原文公式 · 第 ${asset.page || 1} 页`); return; }
    const button = event.target.closest('[data-citation-id]');
    const p = button && (paragraphById(button.dataset.citationId) || state.document?.peripheralBlocks?.find(item => item.id === button.dataset.citationId));
    if (!p) return;
    setView('reflow');
    setMobileView('paper');
    const paragraph = paragraphById(p.id);
    if (paragraph) {
      document.querySelector(`[data-paragraph-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.pinned = sourceSentences(p).map(s => s.id);
      applyHighlights(state.pinned, true);
    } else {
      const fold = $('peripheral-notes');
      const item = document.querySelector(`[data-peripheral-id="${CSS.escape(p.id)}"]`);
      if (fold && item) { fold.open = true; item.scrollIntoView({ block:'center', behavior:'smooth' }); item.classList.add('peripheral-highlight'); setTimeout(() => item.classList.remove('peripheral-highlight'), 2500); }
      else showSource(p);
    }
  });
  $('selected-source').addEventListener('click', event => {
    const node = event.target.closest('[data-math-id]');
    const asset = node && mathAsset(node.dataset.mathId);
    if (asset) openImage(asset.url, `原文公式 · 第 ${asset.page || 1} 页`);
  });
  $('reading-surface').addEventListener('scroll', () => { updateReadingPosition(); saveProgress(); $('selection-menu').hidden = true; }, { passive: true });
  let resizingChat = false;
  $('chat-divider').addEventListener('pointerdown', event => {
    if (innerWidth <= 980) return;
    event.preventDefault();
    resizingChat = true;
    $('chat-divider').setPointerCapture(event.pointerId);
    $('workspace').classList.add('resizing-chat');
  });
  $('chat-divider').addEventListener('pointermove', event => {
    if (!resizingChat) return;
    const bounds = $('workspace').getBoundingClientRect();
    state.chatWidth = bounds.right - event.clientX;
    applyChatWidth(state.chatWidth);
  });
  const endChatResize = () => {
    if (!resizingChat) return;
    resizingChat = false;
    $('workspace').classList.remove('resizing-chat');
    state.chatWidth = Math.round($('insight-panel').getBoundingClientRect().width);
    localStorage.setItem('paper-reader-chat-width', String(state.chatWidth));
  };
  $('chat-divider').addEventListener('pointerup', endChatResize);
  $('chat-divider').addEventListener('pointercancel', endChatResize);
  $('chat-divider').addEventListener('keydown', event => {
    const current = $('insight-panel').getBoundingClientRect().width;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      state.chatWidth = current + (event.key === 'ArrowLeft' ? 24 : -24);
      applyChatWidth(state.chatWidth);
      localStorage.setItem('paper-reader-chat-width', String(state.chatWidth));
    } else if (event.key === 'Home') {
      event.preventDefault(); state.chatWidth = 0; localStorage.removeItem('paper-reader-chat-width'); applyChatWidth();
    }
  });
  window.addEventListener('resize', () => applyChatWidth());
  document.addEventListener('mousedown', event => {
    if (!$('selection-menu').contains(event.target) && !$('paper').contains(event.target)) $('selection-menu').hidden = true;
    if (!$('status-popover').contains(event.target) && !$('connection-button').contains(event.target)) $('status-popover').hidden = true;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('selection-menu').hidden = true; $('status-popover').hidden = true; state.pinned = []; applyHighlights([], true); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); $('file-input').click(); }
  });
  let dragCount = 0;
  document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragCount++; $('drop-overlay').hidden = false; } });
  document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  document.addEventListener('dragleave', event => { event.preventDefault(); dragCount = Math.max(0, dragCount - 1); if (!dragCount) $('drop-overlay').hidden = true; });
  document.addEventListener('drop', event => { event.preventDefault(); dragCount = 0; $('drop-overlay').hidden = true; if (event.dataTransfer?.files?.length) importFile(event.dataTransfer.files[0]); });
  window.addEventListener('beforeunload', () => {
    persistDraft();
    if (state.document) navigator.sendBeacon(docUrl('/progress'), new Blob([JSON.stringify({ paragraphId: state.currentParagraph, scrollTop: $('reading-surface').scrollTop })], { type: 'application/json' }));
  });

  async function init() {
    setTheme(localStorage.getItem('paper-reader-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    if (!localStorage.getItem('paper-reader-font-v2')) {
      if (state.fontSize < 22) state.fontSize = 22;
      localStorage.setItem('paper-reader-font-v2', 'true');
    }
    setFont(state.fontSize);
    setWidthMode(state.widthMode);
    await Promise.allSettled([refreshStatus(), refreshSettings(), loadLibrary()]);
    const requested = new URLSearchParams(location.search).get('doc');
    const last = requested || localStorage.getItem('paper-reader-last-document');
    if (last && state.library.some(doc => doc.id === last)) {
      try { await openDocument(last); } catch (error) { toast(plainError(error), true); }
    }
    connectEvents();
    setInterval(refreshStatus, 30000);
    state.sessionHistoryTimer = setInterval(() => { if (!document.hidden && state.document?.session?.status === 'ready') loadSessionHistory({ quiet:true }); }, 15000);
  }
  window.addEventListener('focus', () => { if (state.document?.session?.status === 'ready') loadSessionHistory({ quiet:true }); });
  init().catch(error => toast(plainError(error), true));
})();
