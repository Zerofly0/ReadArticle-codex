import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.test.mjs')).sort();
const child = spawn(process.execPath, ['--test', ...tests.map(name => `tests/${name}`)], { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
child.on('error', () => { console.error('无法启动 JavaScript 测试。'); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
