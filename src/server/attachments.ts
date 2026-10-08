// Screenshots people attach to a message for a worker (see client/attach.ts). Each one is saved in the
// floor's own attachments/<year-month>/ folder, which is kept out of git (a bank screenshot must never
// end up in a commit), and the message tells the worker the path so it can open it with its Read tool.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const ATTACH_MAX_BYTES = 15 * 1024 * 1024;
/** Larger than an upload can be, for a file an agent put in attachments/ itself. */
const SERVE_MAX_BYTES = 40 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

/** Saves `{ dataUrl }` for the floor at `floorDir`; the saved file's full path, or why not. */
export function saveAttachment(floorDir: string, body: unknown): { path: string } | string {
  const dataUrl = typeof (body as { dataUrl?: unknown })?.dataUrl === 'string' ? (body as { dataUrl: string }).dataUrl : '';
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return 'That isn’t an image or a PDF';
  const ext = TYPES[m[1]];
  if (!ext) return 'Attach a PNG, JPEG, WebP or GIF image, or a PDF';
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return 'That image is empty';
  if (bytes.length > ATTACH_MAX_BYTES) return 'That file is too big (15 MB at most)';
  if (ext === 'pdf' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return 'That isn’t a PDF';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const stamp = `${month}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(floorDir, 'attachments', month);
  mkdirSync(dir, { recursive: true });
  keepOutOfGit(floorDir);
  const file = path.join(dir, `${stamp}-${randomBytes(2).toString('hex')}.${ext}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { path: file };
}

/** Adds attachments/ to the checkout's .git/info/exclude, once. */
function keepOutOfGit(floorDir: string) {
  const git = path.join(floorDir, '.git');
  try {
    if (!existsSync(git) || !statSync(git).isDirectory()) return;
    const info = path.join(git, 'info');
    mkdirSync(info, { recursive: true });
    const exclude = path.join(info, 'exclude');
    const now = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!now.split(/\r?\n/).some((l) => l.trim() === 'attachments/' || l.trim() === '/attachments/')) appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}attachments/\n`);
  } catch {
    // a checkout we can't write to: the file is still saved
  }
}

const SERVE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/**
 * An attached file's bytes and type, for the companion app's chat (GET /api/attach/file), or why not.
 * `p` is the path a message gave (normally absolute) or one relative to the floor's checkout; either
 * way only an image or a PDF inside the floor's attachments/ is served. Windows paths are compared as
 * Windows does (any case, either slash); ".." steps, other drives, UNC and device paths, alternate data
 * streams and links leading out of the folder are all refused.
 */
export function readAttachment(floorDir: string, p: string): { body: Buffer; type: string; name: string } | { status: number; error: string } {
  const refused = { status: 400, error: 'Not an attachment' };
  // A drive-relative path (C:x) means whatever that drive's current folder is: never what was meant.
  if (!p || p.length > 4096 || p.includes('\0') || /^[a-z]:(?![\\/])/i.test(p) || p.split(/[\\/]/).includes('..')) return refused;
  const root = path.resolve(floorDir, 'attachments');
  const file = path.resolve(floorDir, p);
  const rel = path.relative(root, file);
  // A colon after the drive letter is a stream name (a.png:hidden) or a drive-relative path (D:x).
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(':')) return refused;
  const type = SERVE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return refused;
  let real: string;
  let st: import('node:fs').Stats;
  try {
    real = realpathSync(file);
    st = statSync(real);
  } catch {
    return { status: 404, error: 'No such attachment' };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { status: 404, error: 'No such attachment' };
  }
  const realRel = path.relative(realRoot, real);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return refused;
  if (!st.isFile()) return refused;
  if (st.size > SERVE_MAX_BYTES) return { status: 413, error: 'That attachment is too big' };
  return { body: readFileSync(real), type, name: path.basename(real) };
}
