import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function parserNeedsUpdate(current, latest) {
  if (!latest || current === latest) return false;
  const parts = value => typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value) ? value.split('.').map(Number) : null;
  const old = parts(current), next = parts(latest);
  if (!old || !next) return true;
  for (let i = 0; i < Math.max(old.length, next.length); i++) {
    if ((old[i] || 0) !== (next[i] || 0)) return (old[i] || 0) < (next[i] || 0);
  }
  return false;
}

/** Publish new assets under immutable names before atomically replacing JSON.
 * A failed parser must never overwrite pictures referenced by the live paper.
 */
export async function reparseDocument({ id, documentDir, filename, parse, commit }) {
  const stage = await fs.mkdtemp(path.join(documentDir, '.reparse-'));
  const relative = path.relative(documentDir, stage);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('.reparse-')) throw new Error('重排临时目录无效。');
  const assetDir = path.join(stage, 'assets'), output = path.join(stage, 'document.json');
  const published = [];
  let committed = false;
  try {
    await fs.mkdir(assetDir);
    await parse({ source: path.join(documentDir, 'original.pdf'), output, id, filename, assetDir });
    const fresh = JSON.parse(await fs.readFile(output, 'utf8'));
    if (fresh.id !== id || !Array.isArray(fresh.paragraphs) || !fresh.paragraphs.length) throw new Error('重排结果不完整，原文档已保留。');
    if (Number(fresh.quality?.summary?.errorCount) > 0) throw new Error('解析结果仍有公式或图像引用缺失等完整性问题，原文件已保留，请查看原 PDF。');
    const prefix = 'r' + randomUUID().replaceAll('-', '') + '-';
    const names = new Map();
    for (const entry of await fs.readdir(assetDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(entry.name)) throw new Error('重排图片文件无效，原文档已保留。');
      names.set(entry.name, prefix + entry.name);
    }
    const urlPrefix = `/api/documents/${id}/assets/`;
    const assetUrls = [...(fresh.assets || []), ...(fresh.mathAssets || [])].map(asset => asset.url)
      .concat(fresh.paragraphs.filter(p => p.sourceImageUrl).map(p => p.sourceImageUrl));
    if (assetUrls.some(url => typeof url !== 'string' || !url.startsWith(urlPrefix))) throw new Error('重排图片引用不属于当前论文，原文件已保留。');
    const referenced = new Set();
    const rewrite = (value, key = '') => {
      if (typeof value === 'string' && ['url', 'sourceImageUrl'].includes(key) && value.startsWith(urlPrefix)) {
        const name = names.get(value.slice(urlPrefix.length));
        if (!name) throw new Error('重排图片缺失，原文档已保留。');
        referenced.add(value.slice(urlPrefix.length));
        return urlPrefix + name;
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, key)]));
      return value;
    };
    const ready = rewrite(fresh);
    const finalDir = path.join(documentDir, 'assets');
    await fs.mkdir(finalDir, { recursive: true });
    for (const [oldName, name] of names) {
      if (!referenced.has(oldName)) continue;
      const destination = path.join(finalDir, name);
      await fs.copyFile(path.join(assetDir, oldName), destination, constants.COPYFILE_EXCL);
      published.push(destination);
    }
    const result = await commit(ready);
    committed = true;
    return result;
  } finally {
    if (!committed) await Promise.all(published.map(file => fs.unlink(file).catch(() => {})));
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}
