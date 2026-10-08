import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHAT_MAX_MESSAGES, CHAT_MAX_TEXT, cleanPrompt, clearChatCache, extractAttachments, readChat, stripBrief, teamOf, toolSummary, workerChat } from '../src/server/chat.js';
import { TEAM, teamBrief } from '../src/shared/team.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function tmp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  clearChatCache();
  return dir;
}

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, s)).toISOString();
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(n), message: { role: 'user', content }, ...extra });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: at(n), message: { id, role: 'assistant', content }, ...extra });
const toolResult = (id: string) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }], { toolUseResult: { stdout: 'ok' } });
const jsonl = (...lines: unknown[]) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

function transcript(dir: string, ...lines: unknown[]) {
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, jsonl(...lines));
  return file;
}

test("a roster teammate's first prompt shows only its task", () => {
  const m = TEAM[0];
  assert.equal(stripBrief(`${teamBrief(m, true)}\n\nSort out my week`), 'Sort out my week');
  assert.equal(stripBrief(teamBrief(m, false)), null);
  // Not a brief: left as it is, even with the marker in it.
  assert.equal(stripBrief('Please print\n\nYour first task:\n\nfoo'), 'Please print\n\nYour first task:\n\nfoo');
  // A board agent's brief ends the same way (see stationBrief()).
  assert.equal(stripBrief("You're the Queue Agent in Agent Office.\n\nThe request:\n\nAdd dark mode"), 'Add dark mode');
});

test('only the first prompt of a session is treated as a brief', (t) => {
  const dir = tmp(t);
  const m = TEAM[0];
  const brief = `${teamBrief(m, true)}\n\nWhat's on today?`;
  const later = `${teamBrief(m, true)}\n\nquoted back`;
  const file = transcript(dir, user(brief), assistant('m1', [{ type: 'text', text: 'Three meetings.' }]), user(later));
  const msgs = readChat(file);
  assert.deepEqual(
    msgs.map((x) => [x.role, x.text]),
    [
      ['user', "What's on today?"],
      ['assistant', 'Three meetings.'],
      ['user', later],
    ],
  );
});

test('a brief-only first prompt is dropped, but the hello it gets is kept', (t) => {
  const dir = tmp(t);
  const file = transcript(dir, user(teamBrief(TEAM[1], false)), assistant('m1', [{ type: 'text', text: 'Hi, I can help.' }]));
  assert.deepEqual(
    readChat(file).map((x) => [x.role, x.text]),
    [['assistant', 'Hi, I can help.']],
  );
});

test('attachment notes become attachments', () => {
  const note = `\n\n📎 Sam attached 2 files (screenshots or PDFs). Open each one with your Read tool before you answer. Then, before you finish, write down what they show in this floor's shared memory (memory/: the day's log, any data files, and CURRENT.md), so every teammate on the floor knows it too:\n- D:\\office\\household\\attachments\\2026-09\\2026-09-29_120000-ab12.png\n- D:\\office\\Household Money\\attachments\\2026-09\\statement.PDF`;
  const r = extractAttachments(`What do I owe?${note}`);
  assert.equal(r.text, 'What do I owe?');
  assert.deepEqual(r.attachments, [
    { path: 'D:\\office\\household\\attachments\\2026-09\\2026-09-29_120000-ab12.png', name: '2026-09-29_120000-ab12.png', kind: 'image' },
    { path: 'D:\\office\\Household Money\\attachments\\2026-09\\statement.PDF', name: 'statement.PDF', kind: 'pdf' },
  ]);

  const inline = extractAttachments('look at (file to read, then note what it shows in memory/: /home/k/floor/attachments/2026-09/a b.jpg) this and (file to read, then note what it shows in memory/: C:\\f\\attachments\\x.pdf) that');
  assert.equal(inline.text, 'look at this and that');
  assert.deepEqual(
    inline.attachments.map((a) => [a.name, a.kind]),
    [
      ['a b.jpg', 'image'],
      ['x.pdf', 'pdf'],
    ],
  );

  // A 📎 of the human's own, with no list under it, stays.
  assert.deepEqual(extractAttachments('📎 I attached nothing, just saying'), { text: '📎 I attached nothing, just saying', attachments: [] });
});

test('a prompt that is only attachments is still a message', (t) => {
  const dir = tmp(t);
  const file = transcript(dir, user(`📎 Sam attached a file (screenshots or PDFs). Open it:\n- C:\\f\\attachments\\2026-09\\x.png`));
  const [m] = readChat(file);
  assert.equal(m.text, '');
  assert.equal(m.attachments?.[0].name, 'x.png');
});

test('tool calls are summed up in a few words', () => {
  assert.equal(toolSummary('Read', { file_path: 'D:\\office\\household\\memory\\CURRENT.md' }), 'CURRENT.md');
  assert.equal(toolSummary('Write', { file_path: '/home/k/p/src/app.ts', content: 'x' }), 'app.ts');
  assert.equal(toolSummary('Edit', { file_path: 'C:/p/README.md', old_string: 'a', new_string: 'b' }), 'README.md');
  const long = `npm test -- --reporter spec ${'x'.repeat(100)}`;
  const bash = toolSummary('Bash', { command: `  ${long}\n  && echo done` });
  assert.equal(bash.length, 60);
  assert.ok(bash.startsWith('npm test -- --reporter spec') && bash.endsWith('…'));
  assert.equal(toolSummary('Bash', { command: 'git status\ngit diff' }), 'git status git diff');
  assert.equal(toolSummary('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a/b?c=1' }), 'example.com');
  assert.equal(toolSummary('Agent', { description: 'Find the bug', prompt: '...' }), 'Find the bug');
  assert.equal(toolSummary('TodoWrite', { todos: [{}, {}] }), '2 to-dos');
  assert.equal(toolSummary('mcp__gmail__search', { query: 'invoices' }), 'invoices');
  assert.equal(toolSummary('Read', undefined), '');
  assert.equal(toolSummary('Weird', 42), '');
});

test("one reply per turn, with the turn's tools, and nothing that isn't said", (t) => {
  const dir = tmp(t);
  const file = transcript(
    dir,
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', content: "This floor's shared memory right now (x)" } },
    user('Fix the build', { promptSource: 'typed' }),
    assistant('m1', [{ type: 'thinking', thinking: 'hmm' }]),
    assistant('m1', [{ type: 'text', text: 'Looking.' }]),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\p\\package.json' } }]),
    toolResult('t1'),
    assistant('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } }]),
    toolResult('t2'),
    // Logged twice (once per block, then again): said once.
    assistant('m3', [{ type: 'text', text: 'Fixed it.' }]),
    assistant('m3', [{ type: 'text', text: 'Fixed it.' }]),
    { type: 'system', subtype: 'turn_duration' },
    { type: 'cost-state', totalCostUSD: 1 },
    user('<command-name>/model</command-name>'),
    user('<local-command-stdout>Set model</local-command-stdout>'),
    user('Caveat: The messages below were generated by the user while running local commands.', { isMeta: true }),
    user('[Request interrupted by user]'),
    user('Summary of the earlier conversation', { isCompactSummary: true }),
    user('a subagent prompt', { isSidechain: true }),
    assistant('s1', [{ type: 'text', text: 'subagent words' }], { isSidechain: true }),
    user([{ type: 'text', text: 'Thanks!<system-reminder>hidden context</system-reminder>' }]),
    user('<task-notification>\n<task-id>1</task-id></task-notification>', { origin: { kind: 'task-notification' } }),
    assistant('m4', [{ type: 'text', text: 'The agent finished.' }]),
    user([{ type: 'image', source: { type: 'base64', data: 'AAAA' } }], { origin: { kind: 'human' } }),
  );
  const msgs = readChat(file);
  assert.deepEqual(
    msgs.map((m) => [m.role, m.text]),
    [
      ['user', 'Fix the build'],
      ['assistant', 'Looking.\n\nFixed it.'],
      ['user', 'Thanks!'],
      ['assistant', 'The agent finished.'],
      ['user', '(a pasted picture)'],
    ],
  );
  assert.deepEqual(msgs[1].tools, [
    { name: 'Read', summary: 'package.json' },
    { name: 'Bash', summary: 'npm run build' },
  ]);
  // The reply is timed by its latest words, and keeps the id of its first.
  assert.ok(msgs[1].at > msgs[0].at);
  assert.match(msgs[1].id, /^a\d+$/);
  assert.equal(cleanPrompt('  \r\n'), null);
});

test('a half-written last line, junk and unknown records are skipped, and read once finished', (t) => {
  const dir = tmp(t);
  const file = transcript(dir, user('Hello'), 'not json at all', '{"type":', 42, null, { type: 'assistant', message: 'odd' }, { type: 'user' }, assistant('m1', [null, { type: 'text' }, { type: 'text', text: 'Hi' }]));
  const tail = JSON.stringify(user('Second question'));
  appendFileSync(file, tail.slice(0, 20));
  assert.deepEqual(
    readChat(file).map((m) => m.text),
    ['Hello', 'Hi'],
  );
  appendFileSync(file, `${tail.slice(20)}\n`);
  assert.deepEqual(
    readChat(file).map((m) => m.text),
    ['Hello', 'Hi', 'Second question'],
  );
});

test('a reply still being written grows in place, and a rewritten file is read afresh', (t) => {
  const dir = tmp(t);
  const file = transcript(dir, user('Go'), assistant('m1', [{ type: 'text', text: 'Step one.' }]));
  const before = readChat(file);
  appendFileSync(file, jsonl(assistant('m1', [{ type: 'tool_use', id: 'x', name: 'Glob', input: { pattern: '**/*.ts' } }]), assistant('m2', [{ type: 'text', text: 'Step two.' }])));
  const after = readChat(file);
  assert.equal(after.length, 2);
  assert.equal(after[1].id, before[1].id);
  assert.equal(after[1].text, 'Step one.\n\nStep two.');
  assert.deepEqual(after[1].tools, [{ name: 'Glob', summary: '**/*.ts' }]);
  // What was handed out earlier isn't changed under the caller.
  assert.equal(before[1].text, 'Step one.');

  writeFileSync(file, jsonl(user('New start')));
  assert.deepEqual(
    readChat(file).map((m) => m.text),
    ['New start'],
  );
});

test('no transcript yet is an empty chat, and long chats are capped', (t) => {
  const dir = tmp(t);
  assert.deepEqual(readChat(undefined), []);
  assert.deepEqual(readChat(path.join(dir, 'missing.jsonl')), []);

  const lines: unknown[] = [];
  for (let i = 0; i < 400; i++) lines.push(user(`q${i}`), assistant(`m${i}`, [{ type: 'text', text: `a${i}` }]));
  lines.push(user('x'.repeat(CHAT_MAX_TEXT + 500)));
  const msgs = readChat(transcript(dir, ...lines));
  assert.equal(msgs.length, CHAT_MAX_MESSAGES);
  assert.equal(msgs.at(-2)!.text, 'a399');
  assert.equal(msgs.at(-1)!.text.length, CHAT_MAX_TEXT);
  assert.ok(msgs.at(-1)!.text.endsWith('…'));
});

test('workerChat and teamOf say who the workers are', (t) => {
  const dir = tmp(t);
  const member = TEAM[0];
  const info = { id: 'w1', name: member.name, role: member.id, color: '#ffb703', status: 'needs_input', acked: false, waitingSince: 5, activity: 'Read CURRENT.md', kind: 'agent', viewers: [] } as unknown as WorkerInfo;
  const file = transcript(dir, user('Hi'));
  const r = workerChat(info, file);
  assert.deepEqual({ ...r.worker, lastMessageAt: typeof r.worker.lastMessageAt }, {
    id: 'w1',
    name: member.name,
    role: member.id,
    emoji: member.emoji,
    color: '#ffb703',
    status: 'needs_input',
    acked: false,
    waitingSince: 5,
    activity: 'Read CURRENT.md',
    kind: 'agent',
    lastMessageAt: 'number',
  });
  assert.equal(r.messages.length, 1);

  const shell = { id: 'w2', name: 'Shell', color: '#fff', status: 'idle', acked: true, kind: 'shell', parked: true, meeting: 'm1' } as unknown as WorkerInfo;
  assert.deepEqual(workerChat(shell, undefined), { worker: { id: 'w2', name: 'Shell', color: '#fff', status: 'idle', acked: true, kind: 'shell', parked: true, meeting: 'm1' }, messages: [] });

  const transcripts: Record<string, string> = { w1: file };
  const team = teamOf([
    { id: 'home', def: { name: 'Our Home' }, workers: { list: () => [info, shell], transcriptOf: (id: string) => transcripts[id] } },
    { id: 'empty', def: { name: 'Empty' }, workers: { list: () => [], transcriptOf: () => undefined } },
  ]);
  assert.deepEqual(
    team.floors.map((f) => [f.id, f.name, f.workers.map((w) => [w.id, w.lastMessageAt !== undefined])]),
    [
      ['home', 'Our Home', [['w1', true], ['w2', false]]],
      ['empty', 'Empty', []],
    ],
  );
});
