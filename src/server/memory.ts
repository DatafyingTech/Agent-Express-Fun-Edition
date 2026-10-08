// 🧠 A floor's shared memory (memory/ in its checkout: CURRENT.md, log/YYYY-MM-DD.md, data/...), as the
// companion app shows it: read, and added to with a note that the whole team sees, since every
// teammate reads memory/ (see sharedMemory in the roster's BRIEFS, shared/roster.default.ts).
// Nothing outside memory/ is read or written, and only text files are served.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { MemoryFile, MemoryResponse } from '../shared/app-api.js';

export const MEMORY_DIR = 'memory';
export const NOTE_MAX_CHARS = 4000;
export const MEMORY_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** CURRENT.md is meant to stay under 60 lines; this only stops a runaway one from filling the response. */
const CURRENT_MAX_BYTES = 256 * 1024;
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const BY_MAX = 60;

const TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  // Shown as text in the browser, not downloaded or parsed.
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
};

function readText(file: string, max: number): string {
  try {
    const st = statSync(file);
    if (!st.isFile()) return '';
    const text = readFileSync(file, 'utf8');
    return st.size > max ? text.slice(0, max) : text;
  } catch {
    return '';
  }
}

/** The files under `dir` (as "name" or "sub/name"), newest first. */
function listFiles(dir: string, recurse: boolean, keep: (name: string) => boolean): MemoryFile[] {
  const out: Omit<MemoryFile, 'path'>[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && recurse) walk(r, depth + 1);
      else if (e.isFile() && keep(e.name) && out.length < MAX_FILES) {
        try {
          const st = statSync(path.join(dir, r));
          out.push({ name: r, size: st.size, modified: st.mtimeMs });
        } catch {
          // gone already
        }
      }
    }
  };
  walk('', 0);
  const sub = path.basename(dir);
  return out.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name)).map((f) => ({ ...f, path: `${sub}/${f.name}` }));
}

/** GET /api/memory: CURRENT.md and what's in log/ and data/. A floor with no memory yet has it all empty. */
export function readMemory(floorDir: string): MemoryResponse {
  const root = path.join(floorDir, MEMORY_DIR);
  return {
    current: readText(path.join(root, 'CURRENT.md'), CURRENT_MAX_BYTES),
    logs: listFiles(path.join(root, 'log'), false, (n) => /\.md$/i.test(n)),
    data: listFiles(path.join(root, 'data'), true, () => true),
  };
}

/** Whether `file` is `root` or inside it, following links, so a symlink in memory/ can't lead out of it. */
function inside(root: string, file: string): boolean {
  try {
    const real = realpathSync(file);
    const rel = path.relative(realpathSync(root), real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Resolves `rel` (like "log/2026-09-29.md") inside `root`, or undefined when it names anything else:
 * an absolute path (C:\…, \\server\…, /…), a ".." step, a drive-relative or stream name ("C:x", "a.md:s").
 */
function resolveInside(root: string, rel: string): string | undefined {
  if (!rel || rel.length > 1024 || rel.includes('\0')) return undefined;
  const clean = rel.replace(/\\/g, '/');
  if (clean.startsWith('/') || clean.includes(':') || clean.split('/').includes('..')) return undefined;
  const file = path.resolve(root, clean);
  const r = path.relative(root, file);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return undefined;
  return file;
}

/** GET /api/memory/file: a text file inside memory/, or why not. */
export function readMemoryFile(floorDir: string, rel: string): { body: Buffer; type: string } | { status: number; error: string } {
  const root = path.resolve(floorDir, MEMORY_DIR);
  const file = resolveInside(root, rel);
  if (!file) return { status: 400, error: 'Not a memory file' };
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return { status: 400, error: 'Only text files (.md, .txt, .csv, .json) can be opened' };
  if (!existsSync(file)) return { status: 404, error: 'No such file' };
  if (!inside(root, file)) return { status: 400, error: 'Not a memory file' };
  let st: import('node:fs').Stats;
  try {
    st = statSync(file);
  } catch {
    return { status: 404, error: 'No such file' };
  }
  if (!st.isFile()) return { status: 400, error: 'Not a memory file' };
  if (st.size > MEMORY_FILE_MAX_BYTES) return { status: 413, error: 'That file is too big to show (2 MB at most)' };
  return { body: readFileSync(file), type };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A name on one line, with nothing that could start a heading of its own. */
function cleanName(by: string): string {
  return by.replace(/[\r\n\t#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, BY_MAX);
}

/**
 * POST /api/memory/note: adds a dated, timed entry from a person to today's log, so every teammate
 * on the floor reads it. The file (relative to memory/) it went into, or why not.
 */
export function appendNote(floorDir: string, body: unknown, signedIn: string, now = new Date()): { file: string } | string {
  const b = body && typeof body === 'object' ? (body as { text?: unknown; by?: unknown }) : {};
  if (typeof b.text !== 'string') return 'Write a note first';
  const text = b.text.replace(/\r\n?/g, '\n').trim();
  if (!text) return 'Write a note first';
  if (text.length > NOTE_MAX_CHARS) return `That note is too long (${NOTE_MAX_CHARS.toLocaleString('en-US')} characters at most)`;
  const by = (typeof b.by === 'string' && cleanName(b.by)) || cleanName(signedIn) || 'Someone';
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const rel = `log/${day}.md`;
  const dir = path.join(floorDir, MEMORY_DIR, 'log');
  const file = path.join(dir, `${day}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Its own paragraph, whatever the file ended with.
    const gap = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(file, `${gap}## ${pad(now.getHours())}:${pad(now.getMinutes())} · note from ${by} (via the app)\n\n${text}\n`);
  } catch {
    return 'Could not write to the memory folder';
  }
  return { file: rel };
}
