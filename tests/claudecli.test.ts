import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnableClaude } from '../src/server/claudecli.js';

test("an npm .cmd shim is started as the program it runs; anything else as it is", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  const shim = path.join(dir, 'claude.cmd');
  writeFileSync(shim, '@ECHO off\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  const run = spawnableClaude(shim);
  if (process.platform === 'win32') assert.deepEqual(run, { command: exe, prefix: [] });
  else assert.deepEqual(run, { command: shim, prefix: [] });
  assert.deepEqual(spawnableClaude('/usr/local/bin/claude'), { command: '/usr/local/bin/claude', prefix: [] });
  // A shim pointing at a script runs it with node.
  const js = path.join(dir, 'node_modules', 'x', 'cli.js');
  mkdirSync(path.dirname(js), { recursive: true });
  writeFileSync(js, '');
  const jsShim = path.join(dir, 'x.cmd');
  writeFileSync(jsShim, '"%dp0%\\node_modules\\x\\cli.js" %*\r\n');
  if (process.platform === 'win32') assert.deepEqual(spawnableClaude(jsShim), { command: process.execPath, prefix: [js] });
});
