import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['server.mjs'];
for (const dir of ['lib', 'public', 'scripts', 'tests']) {
  for (const name of (await readdir(new URL(`../${dir}/`, import.meta.url))).sort()) {
    if (/\.(mjs|js)$/.test(name)) files.push(`${dir}/${name}`);
  }
}
for (const file of files) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
    child.on('error', () => resolve(1)); child.on('close', value => resolve(value ?? 1));
  });
  if (code !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`JavaScript 语法检查通过（${files.length} 个文件）。`);
