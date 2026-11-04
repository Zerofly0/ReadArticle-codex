import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

// Values are passed as individual process arguments or protocol fields, never
// interpreted as shell commands. This also permits account-specific aliases.
export const isModelIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
export const reasoningEfforts = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Explicit interpreter > existing current-user bundled runtime > PATH.
 * Injectable discovery keeps integrations independent of the developer host. */
export function resolvePython({ env = process.env, platform = process.platform, exists = existsSync, home = os.homedir } = {}) {
  if (env.READER_PYTHON?.trim()) return env.READER_PYTHON.trim();
  const profile = env.USERPROFILE || env.HOME || home();
  const bundled = path.join(profile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  return platform === 'win32' && exists(bundled) ? bundled : platform === 'win32' ? 'python' : 'python3';
}
