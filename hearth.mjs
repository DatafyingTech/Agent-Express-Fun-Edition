#!/usr/bin/env node
// Hearth's runner and small helpers, shared by install.ps1 (Windows) and install.sh (macOS, Linux).
//
//   node hearth.mjs [run]            start the office with the settings in .hearth/settings.env,
//                                    logging to .hearth/logs/hearth.log (what the logon task,
//                                    launchd and systemd run). --foreground logs to this console.
//   node hearth.mjs set-password     read a password from stdin and make it the sign-in password
//   node hearth.mjs password-status  print "set", "generated" or "none"
//   node hearth.mjs health [port]    exit 0 when the office answers on 127.0.0.1:<port>
//   node hearth.mjs check-login      read a password from stdin and try it against the running office
//   node hearth.mjs trust-workspace [--check|--dry-run] [--workspace <dir>]  mark the workspace trusted in ~/.claude.json
//   node hearth.mjs tailscale-info  print "<state>\t<dns name>\t<tailscale ip>" (HEARTH_TAILSCALE = the CLI)
//   node hearth.mjs serve-target <port>  print what `tailscale serve` proxies <port> to, if anything
//
// It is a Node script, not a .cmd or .sh, so one file behaves the same on every OS: Node reads paths
// with any letters in them correctly (cmd.exe reads a batch file in the console's code page and
// garbles them), and the log is appended to by the office itself, through a file handle its child
// processes inherit too.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, '.hearth');
const SETTINGS = path.join(STATE, 'settings.env');
const LOG_DIR = path.join(STATE, 'logs');
const LOG = path.join(LOG_DIR, 'hearth.log');
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';

/** .hearth/settings.env: KEY=value lines, written by the installers. Read here, never sourced. */
function readSettings() {
  const out = {};
  let text = '';
  try {
    text = readFileSync(SETTINGS, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function die(msg, code = 1) {
  console.error(`hearth: ${msg}`);
  process.exit(code);
}

/** The office's entry point, from package.json's "bin", so a renamed bin file still works. */
function entryPoint() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (!bin) die('package.json has no "bin" entry to start');
  return path.join(ROOT, bin);
}

function settingsOrDie() {
  const s = readSettings();
  if (!s.PORT || !s.WORKSPACE) die(`not installed yet (no ${SETTINGS}). Run the installer first.`);
  return s;
}

/**
 * The Claude Code command workers run. The native claude.exe, not the npm claude.cmd shim: cmd.exe
 * cuts a multi-line prompt off at its first line. A logon task, launchd and systemd also start with
 * a bare PATH that may not include ~/.local/bin, where the native installer puts it.
 */
function agentCommand(s) {
  if (s.AGENT) return s.AGENT;
  const native = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  return existsSync(native) ? native : 'claude';
}

function get(port, p, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    // A leading BOM too: Windows PowerShell's process pipes can add one.
    process.stdin.on('end', () => resolve(s.replace(/^\uFEFF/, '').replace(/\r?\n$/, '')));
  });
}

/** The office keeps its data in <workspace>/.agent-office when it's started with the workspace. */
function officeConfigPath(s) {
  return path.join(s.WORKSPACE, '.agent-office', 'config.json');
}

async function run(foreground) {
  const s = settingsOrDie();
  const port = Number(s.PORT);
  if (!existsSync(s.WORKSPACE)) die(`the workspace ${s.WORKSPACE} is missing. Run the installer again to recreate it.`);
  // Started twice (the logon task and a shortcut): the second one has nothing to do. Exiting 0 keeps
  // the task from counting it as a crash.
  if ((await get(port, '/api/health')) === 200) {
    console.log(`hearth: already running on port ${port}`);
    return 0;
  }

  // Services start with a minimal PATH; workers need git, node and claude on it.
  const extra = [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin')];
  if (!IS_WIN) extra.push('/opt/homebrew/bin', '/usr/local/bin');
  const sep = IS_WIN ? ';' : ':';
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [pathKey]: [...extra, process.env[pathKey] ?? ''].join(sep), HEARTH_EDITION: s.EDITION || 'hearth' };
  // The sign-in password lives as a hash in the office's config.json (set-password); an inherited
  // AGENT_OFFICE_PASSWORD would quietly override it.
  delete env.AGENT_OFFICE_PASSWORD;

  // Bound to this machine only: Tailscale Serve is what carries it to your phone, so nothing on
  // the local network (a coffee shop Wi-Fi) can reach it directly.
  const args = [entryPoint(), s.WORKSPACE, '--host', '127.0.0.1', '--port', String(port), '--agent', agentCommand(s)];
  if (s.AGENT_ARGS) args.push('--agent-args', s.AGENT_ARGS);
  if (s.MAX_WORKERS) args.push('--max-workers', s.MAX_WORKERS);

  let stdio = 'inherit';
  let fd;
  if (!foreground) {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`);
    } catch {
      // no log yet, or Windows still has it open somewhere: keep appending
    }
    fd = openSync(LOG, 'a');
    writeFileSync(fd, `\n==== ${new Date().toISOString()} starting on port ${port}\n`);
    stdio = ['ignore', fd, fd];
  }
  const child = spawn(process.execPath, args, { cwd: s.WORKSPACE, env, stdio, windowsHide: true });
  // A service manager stopping us (SIGTERM) or Ctrl+C (SIGINT) goes to the office, which knows what
  // to do with each: SIGTERM keeps workers running for the next start, Ctrl+C stops them too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => child.kill(sig));
    } catch {
      // not a signal on this OS
    }
  }
  return new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`hearth: could not start node: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (fd !== undefined) {
        try {
          writeFileSync(fd, `==== ${new Date().toISOString()} stopped (${signal ?? `exit ${code}`})\n`);
          closeSync(fd);
        } catch {
          // the log went away; nothing to report it to
        }
      }
      resolve(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1));
    });
  });
}

/**
 * Stores the password the way the office's own config.ts does (scrypt with the office's salt), as an
 * already-claimed password: only the hash is kept, so it's never written down in plain text and the
 * office never prints it. The office reads it on its next start.
 */
async function setPassword() {
  const s = settingsOrDie();
  const pw = await readStdin();
  if (pw.length < 6) die('the password needs at least 6 characters');
  const file = officeConfigPath(s);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // first run
  }
  if (!stored.secret) stored.secret = randomBytes(32).toString('hex');
  if (!stored.salt) stored.salt = randomBytes(16).toString('hex');
  stored.verifier = scryptSync(pw, Buffer.from(stored.salt, 'hex'), 32).toString('hex');
  delete stored.password;
  stored.claimedAt = Date.now();
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  console.log('hearth: password saved');
  return 0;
}

function passwordStatus() {
  const s = settingsOrDie();
  try {
    const stored = JSON.parse(readFileSync(officeConfigPath(s), 'utf8'));
    console.log(stored.verifier ? (stored.password ? 'generated' : 'set') : 'none');
  } catch {
    console.log('none');
  }
  return 0;
}

async function checkLogin() {
  const s = settingsOrDie();
  const pw = await readStdin();
  const body = JSON.stringify({ password: pw });
  const status = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(s.PORT), path: '/api/login', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  });
  console.log(status === 200 ? 'ok' : status === 0 ? 'not running' : `rejected (${status})`);
  return status === 200 ? 0 : 1;
}

/**
 * Claude Code's own settings file. CLAUDE_CONFIG_DIR moves it; HEARTH_CLAUDE_JSON points this script
 * at another copy (for testing the installer without touching the real one).
 */
function claudeJsonPath() {
  if (process.env.HEARTH_CLAUDE_JSON) return path.resolve(process.env.HEARTH_CLAUDE_JSON);
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/** A folder the way Claude Code writes it in ~/.claude.json: C:/Users/me/Hearth on Windows. */
function claudeKey(dir) {
  const abs = path.resolve(dir);
  if (!IS_WIN) return abs;
  return abs.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`).replace(/\/+$/, '');
}

/** True when Claude Code already trusts `dir`: its own entry or any parent folder's says so. */
function isTrusted(projects, dir) {
  const norm = (p) => {
    const k = IS_WIN ? p.replace(/\\/g, '/').toLowerCase() : p;
    return k.length > 1 ? k.replace(/\/+$/, '') : k;
  };
  const want = norm(claudeKey(dir));
  return Object.entries(projects ?? {}).some(([k, v]) => {
    if (!v || v.hasTrustDialogAccepted !== true) return false;
    const have = norm(k);
    return want === have || want.startsWith(have.endsWith('/') ? have : `${have}/`);
  });
}

/**
 * Marks the workspace as trusted in ~/.claude.json, the way answering "Yes, I trust this folder" once
 * would. Claude Code asks that the first time it opens a folder, and its default answer is "No, exit":
 * the office's agents run in the workspace and in worktrees under it, with nobody there to answer,
 * so without this the first teammate you hire just quits. Every other key in the file is kept, and
 * the file is backed up first.
 *   --check    only report (exit 0 trusted, 1 not trusted)
 *   --dry-run  print the entry it would add and change nothing
 */
async function trustWorkspace(flags) {
  // --workspace <dir> works before the settings are saved (the installer's dry run).
  const at = flags.indexOf('--workspace');
  const s = at >= 0 ? { ...readSettings(), WORKSPACE: path.resolve(flags[at + 1] ?? '.') } : settingsOrDie();
  const file = claudeJsonPath();
  const key = claudeKey(s.WORKSPACE);
  const read = () => {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  };
  let j;
  try {
    j = read();
  } catch (err) {
    console.log(`skipped: ${file} could not be read as JSON (${err.message}); answer the trust question once by running claude in ${s.WORKSPACE}`);
    return 3;
  }
  if (isTrusted(j.projects, s.WORKSPACE)) {
    console.log(`trusted: ${key}`);
    return 0;
  }
  if (flags.includes('--check')) {
    console.log(`not trusted: ${key}`);
    return 1;
  }
  const entry = { ...(j.projects?.[key] ?? { allowedTools: [] }), hasTrustDialogAccepted: true };
  if (flags.includes('--dry-run')) {
    console.log(`would add to ${file} (after a backup), keeping every other key:\n  "projects": { "${key}": ${JSON.stringify(entry)} }`);
    return 0;
  }
  // Claude Code saves this file while it runs; an office that's up has agents running in the
  // workspace, which could write their copy back over ours.
  if (s.PORT && (await get(Number(s.PORT), '/api/health')) === 200) {
    console.log(`skipped: stop Hearth first (its agents use ${file}), then run this again`);
    return 4;
  }
  // Read again right before writing, so the window for another Claude Code to save in between is tiny.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      j = read();
    } catch (err) {
      console.log(`skipped: ${file} could not be read as JSON (${err.message})`);
      return 3;
    }
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(`${file}.hearth-backup-${stamp}`, readFileSync(file), { mode: 0o600 });
    }
    if (!j.projects || typeof j.projects !== 'object') j.projects = {};
    j.projects[key] = { ...(j.projects[key] ?? { allowedTools: [] }), hasTrustDialogAccepted: true };
    const tmp = `${file}.hearth-tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if (isTrusted(read().projects, s.WORKSPACE)) {
        console.log(`trusted: ${key}`);
        return 0;
      }
    } catch {
      // a Claude Code was halfway through saving; try once more
    }
  }
  console.log(`skipped: another Claude Code kept rewriting ${file}; run this again when it's idle`);
  return 3;
}

function tailscaleJson(args) {
  const cli = process.env.HEARTH_TAILSCALE || 'tailscale';
  try {
    return JSON.parse(execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }));
  } catch {
    return undefined;
  }
}

function tailscaleInfo() {
  const j = tailscaleJson(['status', '--json']);
  if (!j) {
    console.log('Unavailable\t\t');
    return 1;
  }
  const dns = (j.Self?.DNSName ?? '').replace(/\.$/, '');
  const ip = (j.Self?.TailscaleIPs ?? []).find((a) => a.includes('.')) ?? '';
  console.log(`${j.BackendState ?? 'Unknown'}\t${dns}\t${ip}`);
  return 0;
}

function serveTarget(port) {
  const j = tailscaleJson(['serve', 'status', '--json']);
  if (!j?.TCP?.[port]) return 0;
  for (const [host, web] of Object.entries(j.Web ?? {})) {
    if (host.endsWith(`:${port}`)) console.log(web?.Handlers?.['/']?.Proxy ?? '(something else)');
  }
  if (!Object.keys(j.Web ?? {}).some((h) => h.endsWith(`:${port}`))) console.log('(a TCP forwarder)');
  return 0;
}

const [cmd = 'run', ...rest] = process.argv.slice(2);
let code;
switch (cmd) {
  case 'run':
  case '--foreground':
    code = await run(cmd === '--foreground' || rest.includes('--foreground'));
    break;
  case 'set-password':
    code = await setPassword();
    break;
  case 'password-status':
    code = passwordStatus();
    break;
  case 'health': {
    const port = Number(rest[0] || readSettings().PORT);
    code = (await get(port, '/api/health')) === 200 ? 0 : 1;
    break;
  }
  case 'check-login':
    code = await checkLogin();
    break;
  case 'trust-workspace':
    code = await trustWorkspace(rest);
    break;
  case 'tailscale-info':
    code = tailscaleInfo();
    break;
  case 'serve-target':
    code = serveTarget(rest[0] || readSettings().PORT);
    break;
  default:
    die(`unknown command ${cmd}`, 2);
}
process.exit(code);
