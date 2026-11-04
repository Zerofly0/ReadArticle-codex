import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePython } from '../lib/config.mjs';

const child = spawn(resolvePython(), ['-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
});
child.on('error', () => { console.error('无法启动 Python 测试；请配置 READER_PYTHON 并安装 requirements.txt。'); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
