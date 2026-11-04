/** Source-only export. Never enumerates private runtime data or copies Git history. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST = 'release-files.json';
const reserved = /(?:^|\/)(?:\.git|\.reader-data|\.reader-runtime|\.codex|\.agents|\.aws|paper-resources|output|tmp|release|node_modules|__pycache__|\.venv|venv)(?:\/|$)/i;
const allowedExtensions = /\.(?:mjs|js|py|md|txt|json|css|html|svg|cmd|yml)$/;

function permittedPath(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') &&
    !path.posix.isAbsolute(name) && !/^[a-z]:/i.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..') && !reserved.test(name) &&
    (['LICENSE', '.gitignore', '.gitattributes', '.env.example'].includes(name) || allowedExtensions.test(name)) &&
    !/(?:^|\/)(?:auth|credentials|settings|jobs|document(?:-backup[^/]*)?)\.json$/i.test(name) &&
    (!name.split('/').some(part => part.startsWith('.')) || name === '.env.example' || name === '.gitignore' || name === '.gitattributes' || name.startsWith('.github/'));
}

/** Findings contain locations/rule names only, never credential values. */
export function scanSource(name, text) {
  const findings = [];
  const rules = [
    ['PRIVATE_KEY', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['SERVICE_TOKEN', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
    ['BEARER_TOKEN', /\bBearer\s+[A-Za-z0-9_.~+/-]{12,}/i],
    ['LOCAL_USER_PATH', /(?:[A-Za-z]:[\\/]|\/)(?:Users|home)[\\/](?!example[\\/]|user[\\/]|runner[\\/])[^\\/\s"'<>`$]+[\\/]/i],
    ['PRIVATE_PAPER_PATH', /\.reader-data[\\/]documents[\\/][a-f0-9]{20}\b/i],
    ['CREDENTIAL_ASSIGNMENT', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}(?:["']|\s|$)/i],
  ];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    for (const [rule, pattern] of rules) if (pattern.test(line)) findings.push({ file: name, line: index + 1, rule });
  }
  return findings;
}

async function readSource(root, name) {
  let current = path.resolve(root);
  for (const part of name.split('/')) {
    current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`拒绝发布符号链接：${name}`);
  }
  const entry = await fs.stat(current);
  if (!entry.isFile() || entry.size > 4 * 1024 * 1024) throw new Error(`发布源文件类型或大小不正确：${name}`);
  return fs.readFile(current);
}

// Match Git attributes across Windows/Linux; do not modify the working source.
function canonicalSource(name, data) {
  if (data.includes(0)) throw new Error(`发布清单含二进制内容：${name}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n?/g, '\n'); }
  catch { throw new Error(`发布源文件必须是 UTF-8 文本：${name}`); }
  return Buffer.from(name.endsWith('.cmd') ? text.replace(/\n/g, '\r\n') : text);
}

async function trackedFiles(root) {
  try { await fs.lstat(path.join(root, '.git')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-files', '-z'], { cwd: root, shell: false, windowsHide: true });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => reject(new Error('无法检查 Git 已跟踪文件。')));
    child.on('close', code => code === 0 ? resolve(output.split('\0').filter(Boolean)) : reject(new Error('无法检查 Git 已跟踪文件。')));
  });
}

export async function inspectRelease(root = ROOT, { checkTracked = true } = {}) {
  const manifestBytes = await readSource(root, MANIFEST);
  const config = JSON.parse(manifestBytes.toString('utf8'));
  if (config.version !== 1 || !Array.isArray(config.files) || !config.files.includes(MANIFEST) || new Set(config.files).size !== config.files.length || config.files.some(name => !permittedPath(name))) {
    throw new Error('发布清单无效：只允许显式列出的源代码、文档和安全样例。');
  }
  const entries = []; const findings = [];
  for (const name of [...config.files].sort()) {
    const data = canonicalSource(name, name === MANIFEST ? manifestBytes : await readSource(root, name));
    findings.push(...scanSource(name, data.toString('utf8')));
    entries.push({ name, data });
  }
  if (findings.length) {
    const error = new Error('发布检查未通过。仅报告位置，不显示匹配内容。'); error.findings = findings; throw error;
  }
  const pkg = JSON.parse(entries.find(entry => entry.name === 'package.json')?.data.toString('utf8') || '{}');
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(pkg.version || '') || pkg.license !== 'PolyForm-Noncommercial-1.0.0') throw new Error('发布版本或非商业许可证字段无效。');
  const files = entries.map(({ name, data }) => ({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
  const record = Buffer.from(JSON.stringify({ format: 'read-source-release-v1', version: pkg.version, license: pkg.license, files }, null, 2) + '\n');
  if (checkTracked) {
    for (const name of await trackedFiles(root)) {
      if (config.files.includes(name)) continue;
      if (name === 'release-manifest.json' && canonicalSource(name, await readSource(root, name)).equals(record)) continue;
      findings.push({ file: name, rule: 'TRACKED_OUTSIDE_RELEASE_LIST' });
    }
    if (findings.length) { const error = new Error('Git 已跟踪白名单之外的文件；请检查后取消跟踪，不会自动删除文件。'); error.findings = findings; throw error; }
  }
  const digest = createHash('sha256').update(record).digest('hex');
  return { entries, record, digest, version: pkg.version };
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

/** Deterministic, uncompressed ZIP32 with UTF-8 names and no external tools. */
function zipSource(entries) {
  const local = [], directory = []; let offset = 0, centralSize = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8'), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); centralSize += central.length + filename.length; offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

async function writeOnce(filename, data) {
  try { await fs.writeFile(filename, data, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (!(await fs.readFile(filename)).equals(data)) throw new Error('已有发布文件与此次内容不一致；请另行保存旧发布产物。'); }
}

export async function packRelease(root = ROOT) {
  const release = await inspectRelease(root);
  const targetRoot = path.join(root, 'release'); await fs.mkdir(targetRoot, { recursive: true });
  if ((await fs.lstat(targetRoot)).isSymbolicLink()) throw new Error('发布输出目录不能是符号链接。');
  const name = `READ-${release.version}-source-${release.digest.slice(0, 12)}`;
  const dest = path.join(targetRoot, name), staging = await fs.mkdtemp(path.join(targetRoot, '.build-'));
  const entries = [...release.entries, { name: 'release-manifest.json', data: release.record }];
  try {
    for (const entry of entries) {
      const filename = path.join(staging, entry.name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, entry.data, { flag: 'wx' });
    }
    try { await fs.rename(staging, dest); }
    catch (e) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code)) throw e;
      if ((await fs.lstat(dest)).isSymbolicLink()) throw new Error('已有发布目录不能是符号链接。');
      const names = [];
      async function list(dir, prefix = '') { for (const item of await fs.readdir(dir, { withFileTypes: true })) { if (item.isSymbolicLink()) throw new Error('已有发布目录包含符号链接。'); const relative = prefix + item.name; if (item.isDirectory()) await list(path.join(dir, item.name), relative + '/'); else names.push(relative); } }
      await list(dest);
      if (names.sort().join('\n') !== entries.map(entry => entry.name).sort().join('\n')) throw new Error('已有发布目录包含未审核文件，请使用新目录。');
      for (const entry of entries) if (!(await readSource(dest, entry.name)).equals(entry.data)) throw new Error('已有发布目录内容被改动，请使用新目录。');
    }
    const archive = path.join(targetRoot, name + '.zip'), zip = zipSource(entries);
    await writeOnce(archive, zip);
    await writeOnce(archive + '.sha256', Buffer.from(createHash('sha256').update(zip).digest('hex') + '  ' + name + '.zip\n'));
    return { directory: dest, archive, files: entries.length };
  } finally {
    const relative = path.relative(targetRoot, staging);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(staging).startsWith('.build-')) await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).length !== 1 || !['--check', '--pack'].includes(process.argv[2])) throw new Error('用法：node scripts/release.mjs --check | --pack');
    if (process.argv[2] === '--pack') {
      const result = await packRelease(); console.log(`发布包已生成（${result.files} 个文件）：\n${result.directory}\n${result.archive}`);
    } else { const result = await inspectRelease(); console.log(`发布检查通过：${result.entries.length} 个白名单源文件；未包含运行数据。`); }
  } catch (e) {
    console.error(e.message);
    for (const finding of e.findings || []) console.error(`${finding.file}${finding.line ? ':' + finding.line : ''} [${finding.rule}]`);
    process.exitCode = 1;
  }
}
