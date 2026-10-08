// Starting the `claude` CLI for a one-shot call (the recap, the meeting memory, task names) with
// child_process.spawn. On Windows, an npm install of Claude Code puts a .cmd shim on the PATH, and
// spawn can't start a .cmd without a shell (it fails with EINVAL). The shim only hands its arguments to
// the real program inside the npm package, so start that program directly instead.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Spawnable {
  command: string;
  /** Arguments that go before the call's own (a script for node to run). */
  prefix: string[];
}

/** How to spawn `claude` (a resolved path): itself, or what its Windows .cmd shim runs. */
export function spawnableClaude(claude: string): Spawnable {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(claude)) return { command: claude, prefix: [] };
  try {
    // npm's shims run "%dp0%\node_modules\…\claude.exe" (or a cli.js through node): %dp0% is the shim's folder.
    const shim = readFileSync(claude, 'utf8');
    for (const m of shim.matchAll(/"%dp0%\\([^"%]+\.(?:exe|c?js|mjs))"/gi)) {
      const target = path.join(path.dirname(claude), m[1]);
      if (!existsSync(target)) continue;
      return /\.exe$/i.test(target) ? { command: target, prefix: [] } : { command: process.execPath, prefix: [target] };
    }
  } catch {
    // unreadable: try it as it is, and the call fails quietly like any other
  }
  return { command: claude, prefix: [] };
}
