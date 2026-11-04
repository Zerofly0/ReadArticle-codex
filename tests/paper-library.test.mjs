import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePaperResources, buildPaperRegistrationPrompt } from '../lib/paper-library.mjs';

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'paper-resource-test-');
  const documentDir = await fs.mkdtemp(prefix);
  t.after(async () => {
    // This fixture alone owns the computed temporary directory.
    const absolute = path.resolve(documentDir);
    assert.ok(absolute.startsWith(path.resolve(prefix)));
    const unlock = async directory => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await unlock(filename); else await fs.chmod(filename, 0o666);
      }
    };
    await unlock(absolute);
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 2 });
  });
  await fs.mkdir(path.join(documentDir, 'assets'));
  // Binary stand-ins test byte-for-byte packaging, not PDF/image rendering.
  await fs.writeFile(path.join(documentDir, 'original.pdf'), Buffer.from('original-source-pdf-bytes'));
  await fs.writeFile(path.join(documentDir, 'assets', 'math-m001.png'), Buffer.from('original-equation-image'));
  await fs.writeFile(path.join(documentDir, 'assets', 'figure-1.jpg'), Buffer.from('original-figure-image'));
  const doc = {
    id: 'paper1', title: 'A Contextual Paper', filename: 'paper.pdf', pageCount: 3,
    parser: { name: 'pdfplumber-layout', version: '0.5.1' },
    sections: [{ id: 's1', title: 'Introduction', paragraphId: 'p1' }],
    paragraphs: [{ id: 'p1', page: 1, kind: 'paragraph', sectionId: 's1',
      text: 'We define ⟦MATH_m001⟧ using the previous result.', rawText: 'We define X using the previous result.',
      sourceBoxes: [{ page: 1, x0: 50, y0: 100, x1: 300, y1: 130 }],
      sentences: [{ id: 'p1-s1', text: 'We define ⟦MATH_m001⟧ using the previous result.' }],
      translation: { text: 'UNVERIFIED_TRANSLATION_SHOULD_NOT_APPEAR' }, notes: 'USER_NOTES_SHOULD_NOT_APPEAR' }],
    mathAssets: [{ id: 'm001', token: '⟦MATH_m001⟧', display: 'inline', page: 1, textHint: 'X',
      url: '/api/documents/paper1/assets/math-m001.png', sourceBox: { page: 1, x0: 90, y0: 100, x1: 100, y1: 110 } }],
    assets: [{ id: 'fig1', page: 2, caption: 'Figure 1. Source evidence.', afterParagraphId: 'p1', url: '/api/documents/paper1/assets/figure-1.jpg' }],
    peripheralBlocks: [{ id: 'fn1', kind: 'footnote', page: 1, text: 'The experiment uses a separate validation set.', sourceBoxes: [{ page: 1, x0: 50, y0: 700, x1: 300, y1: 715 }] },
      { id: 'pub1', kind: 'publication', page: 1, text: 'Publisher notice', sourceBoxes: [] }],
    history: [{ question: 'USER_HISTORY_SHOULD_NOT_APPEAR', answer: 'MODEL_ANSWER_SHOULD_NOT_APPEAR' }],
    glossary: [{ term: 'UNVERIFIED_GLOSSARY_SHOULD_NOT_APPEAR' }],
  };
  return { documentDir, doc };
}

test('packages only original evidence, true footnotes and immutable local assets', async t => {
  const { doc, documentDir } = await fixture(t);
  const resources = await preparePaperResources(doc, { documentDir });
  const source = await fs.readFile(resources.sourcePath, 'utf8');
  const paragraphs = await fs.readFile(resources.paragraphsPath, 'utf8');
  const manifestText = await fs.readFile(resources.manifestPath, 'utf8');
  for (const excluded of ['UNVERIFIED_TRANSLATION_SHOULD_NOT_APPEAR', 'USER_NOTES_SHOULD_NOT_APPEAR', 'USER_HISTORY_SHOULD_NOT_APPEAR', 'MODEL_ANSWER_SHOULD_NOT_APPEAR', 'UNVERIFIED_GLOSSARY_SHOULD_NOT_APPEAR']) assert.ok(![source, paragraphs, manifestText].join('\n').includes(excluded));
  assert.match(source, /⟦MATH_m001⟧/);
  assert.match(source, /The experiment uses a separate validation set\./);
  assert.match(paragraphs, /"id":"p1"/);
  assert.match(paragraphs, /"page":1/);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.counts.footnotes, 1);
  assert.equal(manifest.assets.length, 2);
  assert.ok(manifest.assets.every(asset => asset.path.startsWith(resources.resourceDir)));
  assert.equal(await fs.readFile(resources.pdfPath, 'utf8'), 'original-source-pdf-bytes');
  assert.equal(await fs.readFile(manifest.assets.find(asset => asset.kind === 'math').path, 'utf8'), 'original-equation-image');
  assert.equal(resources.extractionStatus, 'text_extracted');
  assert.match(resources.instructions, /会话压缩/);
  assert.match(resources.instructions, /manifest\.json/);
  assert.ok(!resources.instructions.includes(doc.paragraphs[0].text));
});

test('translation, question history and reading progress do not invalidate source registration', async t => {
  const { doc, documentDir } = await fixture(t);
  const first = await preparePaperResources(doc, { documentDir });
  const modified = (await fs.stat(first.sourcePath)).mtimeMs;
  const next = structuredClone(doc);
  next.paragraphs[0].translation.text = 'NEW_TRANSLATION';
  next.history.push({ question: 'NEW_USER_QUESTION' });
  next.progress = { scrollTop: 1234 };
  const second = await preparePaperResources(next, { documentDir });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(second.reused, true);
  assert.equal((await fs.stat(second.sourcePath)).mtimeMs, modified);
});

test('parser, raw source and PDF revisions get distinct immutable registration paths', async t => {
  const { doc, documentDir } = await fixture(t);
  const first = await preparePaperResources(doc, { documentDir });
  const parserChanged = structuredClone(doc);
  parserChanged.parser.version = '0.6.0';
  const second = await preparePaperResources(parserChanged, { documentDir });
  assert.notEqual(first.fingerprint, second.fingerprint);
  const textChanged = structuredClone(doc);
  textChanged.paragraphs[0].rawText = 'A corrected extraction.';
  const third = await preparePaperResources(textChanged, { documentDir });
  assert.notEqual(first.fingerprint, third.fingerprint);
  await fs.writeFile(path.join(documentDir, 'original.pdf'), Buffer.from('revised-source-pdf-bytes'));
  const fourth = await preparePaperResources(doc, { documentDir });
  assert.notEqual(first.fingerprint, fourth.fingerprint);
  assert.equal(await fs.readFile(first.pdfPath, 'utf8'), 'original-source-pdf-bytes');
});

test('registration makes the latest reordered snapshot authoritative while preserving history and the source PDF', async t => {
  const { doc, documentDir } = await fixture(t);
  doc.paragraphs.push({ id: 'p2', page: 1, kind: 'paragraph', text: 'These conditions apply to the result.',
    sentences: [{ id: 'p2-s1', text: 'These conditions apply to the result.' }] });
  const first = await preparePaperResources(doc, { documentDir });
  const corrected = structuredClone(doc);
  corrected.paragraphs.reverse();
  corrected.paragraphs[0].id = 'p-corrected';
  corrected.paragraphs[0].sentences[0].id = 'p-corrected-s1';
  const latest = await preparePaperResources(corrected, { documentDir });
  assert.notEqual(latest.fingerprint, first.fingerprint, 'corrected order and paragraph IDs create a new source snapshot');
  assert.equal(latest.sourceHash, first.sourceHash, 'a new extraction snapshot does not imply a changed PDF');
  assert.equal(await fs.readFile(first.pdfPath, 'utf8'), await fs.readFile(latest.pdfPath, 'utf8'));
  for (const resources of [first, latest]) {
    const prompt = buildPaperRegistrationPrompt(resources);
    assert.ok(prompt.includes(`资料包指纹：${resources.fingerprint}`));
    assert.ok(prompt.includes(`资源清单：${resources.manifestPath.replaceAll('\\', '/')}`));
    assert.match(prompt, /本次指纹及对应资源清单.*当前最新有效的重排资料/);
    assert.match(prompt, /若有早前登记的快照.*替代.*文字顺序、段落划分与段落 ID/);
    assert.match(prompt, /保留历史问答.*原文、段落编号与页码.*原 PDF 和本次资料包重新复核/);
    assert.match(prompt, /不把早前错排的提取文本当作论文事实/);
    assert.doesNotMatch(prompt, /原\s*PDF\s*(?:已|发生|出现|被|已经)?(?:变更|改变|修改|替换)/);
  }
  assert.ok(!latest.instructions.includes(first.fingerprint), 'the new registration must not point back to the stale snapshot');
});

test('an overwritten math filename gets a new package while the old formula snapshot survives', async t => {
  const { doc, documentDir } = await fixture(t);
  const first = await preparePaperResources(doc, { documentDir });
  const firstManifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  const oldMath = firstManifest.assets.find(asset => asset.kind === 'math').path;
  await fs.writeFile(path.join(documentDir, 'assets', 'math-m001.png'), Buffer.from('corrected-equation-image'));
  const second = await preparePaperResources(doc, { documentDir });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(await fs.readFile(oldMath, 'utf8'), 'original-equation-image');
});

test('missing or traversal-like assets remain explicit unavailable evidence, without external reads', async t => {
  const { doc, documentDir } = await fixture(t);
  doc.mathAssets[0].url = '/api/documents/paper1/assets/..%2Fsecret.png';
  doc.assets[0].url = '/api/documents/paper1/assets/not-present.jpg';
  const resources = await preparePaperResources(doc, { documentDir });
  const manifest = JSON.parse(await fs.readFile(resources.manifestPath, 'utf8'));
  assert.equal(manifest.assets.filter(asset => asset.available).length, 0);
  assert.equal(manifest.assets[0].reason, 'invalid_local_reference');
  assert.equal(manifest.assets[1].reason, 'missing_source_asset');
  assert.equal(resources.warnings.length, 2);
  assert.ok(manifest.assets.every(asset => asset.path === null));
});

test('an image-only PDF is registered honestly with no fabricated transcription', async t => {
  const { doc, documentDir } = await fixture(t);
  doc.paragraphs = []; doc.mathAssets = []; doc.assets = []; doc.sections = [];
  const resources = await preparePaperResources(doc, { documentDir });
  assert.equal(resources.extractionStatus, 'image_only');
  assert.equal(await fs.readFile(resources.paragraphsPath, 'utf8'), '');
  assert.match(resources.summary, /没有可靠的可检索正文/);
  assert.match(buildPaperRegistrationPrompt(resources), /不伪造内容/);
  assert.equal(await fs.readFile(resources.pdfPath, 'utf8'), 'original-source-pdf-bytes');
});

test('parallel preparation is idempotent and does not leave staging folders', async t => {
  const { doc, documentDir } = await fixture(t);
  const [first, second] = await Promise.all([preparePaperResources(doc, { documentDir }), preparePaperResources(doc, { documentDir })]);
  assert.equal(first.resourceDir, second.resourceDir);
  assert.deepEqual(await fs.readdir(path.join(documentDir, 'paper-resources')), [first.fingerprint]);
});

test('existing evidence package tampering is reported instead of silently becoming source truth', async t => {
  const { doc, documentDir } = await fixture(t);
  const first = await preparePaperResources(doc, { documentDir });
  await fs.chmod(first.sourcePath, 0o666);
  await fs.writeFile(first.sourcePath, 'modified evidence');
  await assert.rejects(preparePaperResources(doc, { documentDir }), /完整性检查失败/);
});
