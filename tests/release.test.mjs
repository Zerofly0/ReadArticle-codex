import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { inspectRelease, packRelease, scanSource } from '../scripts/release.mjs';

const exec = promisify(execFile), runtime = path.resolve('.reader-runtime');
async function fixture(t) {
  await fs.mkdir(runtime, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtime, 'release-test-'));
  t.after(async () => { const rel = path.relative(runtime, root); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(root, { recursive: true, force: true }); });
  const files = ['release-files.json', 'package.json', 'LICENSE', 'README.md', 'src/main.mjs'];
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.mjs'), 'export const name = "READ";\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.6.0', license: 'PolyForm-Noncommercial-1.0.0' }));
  await fs.writeFile(path.join(root, 'README.md'), '公开源码\n');
  await fs.writeFile(path.join(root, 'LICENSE'), 'License fixture.');
  await fs.writeFile(path.join(root, 'release-files.json'), JSON.stringify({ version: 1, files }));
  return { root, files };
}

test('only explicit source files enter deterministic archives, never private data or ignored screenshots', async t => {
  const { root, files } = await fixture(t);
  for (const directory of ['.reader-data', '.reader-runtime', '.codex', 'output']) {
    await fs.mkdir(path.join(root, directory)); await fs.writeFile(path.join(root, directory, 'private.txt'), 'PRIVATE_DATA_MUST_STAY_LOCAL');
  }
  const first = await packRelease(root), second = await packRelease(root);
  assert.equal(first.directory, second.directory); assert.equal(first.archive, second.archive);
  const archive = await fs.readFile(first.archive);
  assert.ok(!archive.includes(Buffer.from('PRIVATE_DATA_MUST_STAY_LOCAL')));
  const record = JSON.parse(await fs.readFile(path.join(first.directory, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(record.files.map(file => file.path).sort(), files.sort());
  for (const file of record.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(first.directory, file.path))).digest('hex'), file.sha256);
  assert.equal((await fs.readFile(first.archive + '.sha256', 'utf8')).split(' ')[0], createHash('sha256').update(archive).digest('hex'));
  // Independent record of ZIP directory names checks contents without trusting the exporter manifest.
  const end = archive.length - 22; assert.equal(archive.readUInt32LE(end), 0x06054b50);
  let cursor = archive.readUInt32LE(end + 16); const names = [];
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const len = archive.readUInt16LE(cursor + 28); names.push(archive.subarray(cursor + 46, cursor + 46 + len).toString('utf8'));
    cursor += 46 + len + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  assert.deepEqual(names.sort(), [...files, 'release-manifest.json'].sort());
});

test('secret findings block packaging and report only rule/location, never matched values', async t => {
  const { root } = await fixture(t), token = ['sk', 'test'.repeat(12)].join('-');
  await fs.writeFile(path.join(root, 'src/main.mjs'), `export const key = "${token}";`);
  await assert.rejects(packRelease(root), error => {
    assert.equal(error.findings[0].file, 'src/main.mjs'); assert.equal(error.findings[0].line, 1);
    assert.equal(error.findings[0].rule, 'SERVICE_TOKEN'); assert.ok(!JSON.stringify(error).includes(token)); assert.ok(!error.message.includes(token)); return true;
  });
  await assert.rejects(fs.stat(path.join(root, 'release')), { code: 'ENOENT' });
  for (const secret of ['-----BEGIN ' + 'PRIVATE KEY-----', ['Bearer', 'private'.repeat(5)].join(' '), 'password=' + 'private'.repeat(5), ['C:', 'Users', '个人用户名', 'file.txt'].join('/'), '.reader-data/documents/' + '1a'.repeat(10) + '/original.pdf']) assert.ok(scanSource('file', secret).length);
});

test('LF and CRLF source checkouts yield the same release hashes without changing original files', async t => {
  const { root } = await fixture(t); const first = await inspectRelease(root);
  const filename = path.join(root, 'src/main.mjs'); const crlf = (await fs.readFile(filename, 'utf8')).replace(/\n/g, '\r\n');
  await fs.writeFile(filename, crlf); const second = await inspectRelease(root);
  assert.equal(first.digest, second.digest); assert.equal(await fs.readFile(filename, 'utf8'), crlf);
});

test('release list cannot opt runtime data, PDF, credentials, absolute paths or traversal into a bundle', async t => {
  const { root, files } = await fixture(t);
  for (const unsafe of ['.reader-data/documents/fixture.json', 'output/proof.png', '.env', 'auth.json', 'paper.pdf', '../escape.mjs', '/outside.mjs', 'C:/outside.mjs', 'src\\main.mjs']) {
    await fs.writeFile(path.join(root, 'release-files.json'), JSON.stringify({ version: 1, files: [...files, unsafe] }));
    await assert.rejects(inspectRelease(root), /发布清单无效/);
  }
});

test('source and output symlinks are refused instead of following them', async t => {
  const { root } = await fixture(t); const outside = path.join(root, 'not-for-release'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'main.mjs'), 'PRIVATE_DATA');
  await fs.rename(path.join(root, 'src'), path.join(root, 'original-src'));
  await fs.symlink(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectRelease(root), /符号链接/);
  await fs.unlink(path.join(root, 'src')); await fs.rename(path.join(root, 'original-src'), path.join(root, 'src'));
  await fs.symlink(outside, path.join(root, 'release'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packRelease(root), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), ['main.mjs']);
});

test('reusing an export rejects modified or unreviewed files and never silently deletes them', async t => {
  const { root } = await fixture(t); const result = await packRelease(root);
  const unexpected = path.join(result.directory, 'private-note.txt'); await fs.writeFile(unexpected, 'Keep me');
  await assert.rejects(packRelease(root), /未审核文件/); assert.equal(await fs.readFile(unexpected, 'utf8'), 'Keep me');
});

test('Git staging outside release list is refused; a valid generated manifest remains publishable', async t => {
  const { root } = await fixture(t); await exec('git', ['init', '--quiet'], { cwd: root });
  await exec('git', ['add', '--', '.'], { cwd: root }); await inspectRelease(root);
  const result = await packRelease(root);
  await fs.copyFile(path.join(result.directory, 'release-manifest.json'), path.join(root, 'release-manifest.json'));
  await exec('git', ['add', '--', 'release-manifest.json'], { cwd: root }); await inspectRelease(root);
  await fs.writeFile(path.join(root, 'private-note.txt'), 'This must not be published.');
  await exec('git', ['add', '--', 'private-note.txt'], { cwd: root });
  await assert.rejects(inspectRelease(root), error => { assert.deepEqual(error.findings, [{ file: 'private-note.txt', rule: 'TRACKED_OUTSIDE_RELEASE_LIST' }]); return true; });
});
