import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendNote, MEMORY_FILE_MAX_BYTES, NOTE_MAX_CHARS, readMemory, readMemoryFile } from '../src/server/memory.js';
import { readAttachment } from '../src/server/attachments.js';

const WIN = process.platform === 'win32';

function floor(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file: string, text: string | Buffer, mtime?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtime) utimesSync(file, mtime / 1000, mtime / 1000);
}

test('memory lists CURRENT.md, the logs and the data files, newest first', (t) => {
  const dir = floor(t);
  assert.deepEqual(readMemory(dir), { current: '', logs: [], data: [] });
  const mem = path.join(dir, 'memory');
  put(path.join(mem, 'CURRENT.md'), '# Now\n');
  put(path.join(mem, 'log', '2026-09-28.md'), 'old', 1_000_000_000_000);
  put(path.join(mem, 'log', '2026-09-29.md'), 'new', 1_000_000_100_000);
  put(path.join(mem, 'log', 'notes.txt'), 'not a log');
  put(path.join(mem, 'log', 'sub', '2026-01-01.md'), 'not listed: logs are flat');
  put(path.join(mem, 'data', 'transactions.csv'), 'a,b', 1_000_000_000_000);
  put(path.join(mem, 'data', '2026', 'budget.json'), '{}', 1_000_000_200_000);
  const m = readMemory(dir);
  assert.equal(m.current, '# Now\n');
  assert.deepEqual(
    m.logs.map((f) => [f.name, f.path, f.size]),
    [
      ['2026-09-29.md', 'log/2026-09-29.md', 3],
      ['2026-09-28.md', 'log/2026-09-28.md', 3],
    ],
  );
  assert.deepEqual(
    m.data.map((f) => [f.name, f.path]),
    [
      ['2026/budget.json', 'data/2026/budget.json'],
      ['transactions.csv', 'data/transactions.csv'],
    ],
  );
  assert.equal(typeof m.data[0].modified, 'number');
});

test('memory files are served as text, only from inside memory/', (t) => {
  const dir = floor(t);
  const mem = path.join(dir, 'memory');
  put(path.join(mem, 'log', '2026-09-29.md'), '## hi');
  put(path.join(mem, 'data', 'transactions.csv'), 'date,amount');
  put(path.join(mem, 'data', 'photo.png'), Buffer.from([1, 2, 3]));
  put(path.join(mem, 'data', 'big.txt'), 'x'.repeat(MEMORY_FILE_MAX_BYTES + 1));
  put(path.join(dir, 'secret.md'), 'secret');
  put(path.join(dir, '.env.md'), 'secret');

  const md = readMemoryFile(dir, 'log/2026-09-29.md');
  assert.ok('body' in md && md.body.toString() === '## hi' && md.type.startsWith('text/markdown'));
  const csv = readMemoryFile(dir, 'data\\transactions.csv');
  assert.ok('body' in csv && csv.type.startsWith('text/plain'));

  const status = (rel: string) => {
    const r = readMemoryFile(dir, rel);
    return 'status' in r ? r.status : 200;
  };
  assert.equal(status('data/photo.png'), 400);
  assert.equal(status('data/big.txt'), 413);
  assert.equal(status('log/2026-01-01.md'), 404);
  for (const bad of [
    '',
    '../secret.md',
    'log/../../secret.md',
    'log\\..\\..\\secret.md',
    '..\\.env.md',
    '/etc/passwd.md',
    path.join(dir, 'secret.md'),
    path.join(mem, 'log', '2026-09-29.md'),
    'C:\\Windows\\win.ini.txt',
    'C:secret.md',
    '\\\\server\\share\\x.md',
    '\\\\?\\C:\\x.md',
    'log/2026-09-29.md:stream.md',
    'log/\0.md',
  ]) {
    assert.equal(status(bad), 400, bad);
  }
});

test('a link inside memory/ that leads out of it is refused', (t) => {
  const dir = floor(t);
  put(path.join(dir, 'outside', 'secret.md'), 'secret');
  mkdirSync(path.join(dir, 'memory', 'data'), { recursive: true });
  try {
    symlinkSync(path.join(dir, 'outside'), path.join(dir, 'memory', 'data', 'link'), 'junction');
  } catch {
    t.skip('no links here');
    return;
  }
  const r = readMemoryFile(dir, 'data/link/secret.md');
  assert.ok('status' in r && r.status === 400);
});

test('a note is appended to the day’s log, dated and signed', (t) => {
  const dir = floor(t);
  const when = new Date(2026, 8, 29, 9, 5);
  assert.deepEqual(appendNote(dir, { text: '  We moved the budget review to Friday.\r\n' }, 'Alex', when), { file: 'log/2026-09-29.md' });
  assert.deepEqual(appendNote(dir, { text: 'Second one', by: 'Sam\n## fake heading' }, 'Alex', new Date(2026, 8, 29, 14, 30)), { file: 'log/2026-09-29.md' });
  const log = readFileSync(path.join(dir, 'memory', 'log', '2026-09-29.md'), 'utf8');
  assert.equal(log, '## 09:05 · note from Alex (via the app)\n\nWe moved the budget review to Friday.\n\n## 14:30 · note from Sam fake heading (via the app)\n\nSecond one\n');

  // After a teammate's entry with no newline at the end, it still starts a paragraph of its own.
  const other = path.join(dir, 'memory', 'log', '2026-09-30.md');
  put(other, '## 08:00 · Budget Analyst\n\nPaid rent.');
  appendNote(dir, { text: 'ok' }, '', new Date(2026, 8, 30, 8, 1));
  assert.equal(readFileSync(other, 'utf8'), '## 08:00 · Budget Analyst\n\nPaid rent.\n\n## 08:01 · note from Someone (via the app)\n\nok\n');
});

test('an empty, missing or too long note is refused', (t) => {
  const dir = floor(t);
  assert.equal(typeof appendNote(dir, { text: '   ' }, 'Sam'), 'string');
  assert.equal(typeof appendNote(dir, {}, 'Sam'), 'string');
  assert.equal(typeof appendNote(dir, null, 'Sam'), 'string');
  assert.equal(typeof appendNote(dir, { text: 42 }, 'Sam'), 'string');
  assert.equal(typeof appendNote(dir, { text: 'x'.repeat(NOTE_MAX_CHARS + 1) }, 'Sam'), 'string');
  assert.equal(typeof appendNote(dir, { text: 'x'.repeat(NOTE_MAX_CHARS) }, 'Sam'), 'object');
});

test('attachments are served only from the floor’s attachments/ folder', (t) => {
  const dir = floor(t);
  const png = path.join(dir, 'attachments', '2026-09', '2026-09-29_120000-ab12.png');
  put(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  put(path.join(dir, 'attachments', '2026-09', 'statement.pdf'), '%PDF-1.4');
  put(path.join(dir, 'attachments', 'notes.txt'), 'text');
  put(path.join(dir, 'secret.png'), 'secret');
  put(path.join(dir, 'memory', 'x.png'), 'secret');

  const ok = readAttachment(dir, png);
  assert.ok('body' in ok && ok.type === 'image/png' && ok.name === '2026-09-29_120000-ab12.png');
  const rel = readAttachment(dir, 'attachments/2026-09/statement.pdf');
  assert.ok('body' in rel && rel.type === 'application/pdf');
  if (WIN) {
    // A backslash is a folder separator only on Windows (elsewhere it's part of a file's name).
    assert.ok('body' in readAttachment(dir, 'attachments\\2026-09\\statement.pdf'));
    // Windows paths are any case, with either slash.
    assert.ok('body' in readAttachment(dir, png.toUpperCase().replace(/\.PNG$/, '.png')));
    assert.ok('body' in readAttachment(dir, png.replace(/\\/g, '/')));
  }

  const status = (p: string) => {
    const r = readAttachment(dir, p);
    return 'status' in r ? r.status : 200;
  };
  assert.equal(status('attachments/2026-09/missing.png'), 404);
  for (const bad of [
    '',
    'attachments/notes.txt',
    'secret.png',
    path.join(dir, 'secret.png'),
    path.join(dir, 'memory', 'x.png'),
    'attachments/../secret.png',
    'attachments\\..\\secret.png',
    '..\\..\\secret.png',
    `${path.join(dir, 'attachments')}\\..\\secret.png`,
    `${path.join(dir, 'attachments')}-evil\\x.png`,
    'C:\\Windows\\System32\\x.png',
    'D:\\floor\\attachments\\x.png',
    'C:attachments\\x.png',
    '\\\\server\\share\\attachments\\x.png',
    '\\\\?\\C:\\attachments\\x.png',
    '\\\\.\\pipe\\x.png',
    '/etc/attachments/x.png',
    `${png}:hidden.png`,
    'attachments/x\0.png',
    'attachments',
  ]) {
    assert.equal(status(bad), 400, bad);
  }
});

test('a link inside attachments/ that leads out of it is refused', (t) => {
  const dir = floor(t);
  put(path.join(dir, 'outside', 'secret.png'), 'secret');
  mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  try {
    symlinkSync(path.join(dir, 'outside'), path.join(dir, 'attachments', 'link'), 'junction');
  } catch {
    t.skip('no links here');
    return;
  }
  const r = readAttachment(dir, 'attachments/link/secret.png');
  assert.ok('status' in r && r.status === 400);
});
