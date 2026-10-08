import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MeetingRoom, talkTiming, type MeetingWorkers } from '../src/server/meetings.js';

// Conversation replies are read the moment a seat is ready again (the office waits a few seconds).
talkTiming.replySettleMs = 0;
import { Worktrees } from '../src/server/worktrees.js';
import type { MeetingRequest, WorkerInfo } from '../src/shared/protocol.js';
import { MEETING_PATTERN_IDS, isMeetingPattern } from '../src/shared/meetings.js';
import { TEAM } from '../src/shared/team.js';

/** Three teammates from whichever roster the office runs on. */
const [ONE, TWO, THREE] = TEAM.map((m) => m.id);

function fixture(opts: { git?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-meeting-'));
  const dataDir = path.join(dir, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.agent-office/\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
  }
  const workers: WorkerInfo[] = [];
  const prompts: { id: string; text: string }[] = [];
  const typed: { id: string; data: string }[] = [];
  const toasts: string[] = [];
  const reviews: { pr: number; file: string }[] = [];
  const memories: string[] = [];
  /** Each worker's Claude Code transcript (JSONL), for conversation meetings to read replies from. */
  const transcript = (id: string) => path.join(dir, `${id}.jsonl`);
  let ids = 0;
  const manager: MeetingWorkers = {
    defaultProvider: 'claude',
    list: () => workers,
    seat(deskId, by, prompt, provider, model, effort, meeting, member, label) {
      if (workers.some((w) => w.deskId === deskId)) return 'taken';
      const worker: WorkerInfo = {
        id: `w${++ids}`, deskId, kind: 'agent', provider, model, effort, prompt, name: label ?? `Worker ${workers.length + 1}`,
        color: '#fff', status: 'starting', acked: true, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [],
        worktree: meeting.worktree, meeting: meeting.id, role: member,
      };
      workers.push(worker);
      prompts.push({ id: worker.id, text: prompt });
      return worker;
    },
    prompt(id, text) {
      prompts.push({ id, text });
      return undefined;
    },
    write(id, data) {
      typed.push({ id, data });
    },
    async kill(id) {
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      room.onWorkerGone(id);
      return {};
    },
    transcriptOf: (id) => transcript(id),
  };
  const room: MeetingRoom = new MeetingRoom(dir, dataDir, manager, opts.git ? new Worktrees(dir) : undefined, {
    update() {},
    toast: (text) => toasts.push(text),
    hiringPaused: () => undefined,
    postReview: async (pr, file) => {
      reviews.push({ pr, file });
      return `https://github.com/o/r/pull/${pr}#pullrequestreview-1`;
    },
    memory: async (input) => {
      memories.push(input);
      return `# Memory ${memories.length}\n- noted`;
    },
  });
  const cwd = () => {
    const wt = room.state().current?.worktree;
    return wt ? path.join(dir, wt.path) : dir;
  };
  /** The worker at seat `i` takes its part: it starts, writes its file (unless `skip`), and ends its turn. */
  const take = (i: number, text = 'Some notes.', skip = false) => {
    const m = room.state().current!;
    const t = m.turns.find((x) => x.seat === i);
    assert.ok(t, `seat ${i} has a part in round ${m.round}`);
    const w = workers.find((x) => x.id === m.seats[i].workerId)!;
    w.status = 'working';
    room.onWorker(w);
    if (!skip) {
      const file = path.join(cwd(), t.file);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    w.status = 'done';
    room.onWorker(w);
  };
  /** Workers who had no part yet say they're ready and end the turn. */
  const settle = () => {
    for (const w of workers) {
      if (w.status !== 'starting') continue;
      w.status = 'done';
      room.onWorker(w);
    }
  };
  /** In a conversation: the worker at seat `i` reads its prompt, works, answers with `text` and ends its turn. */
  const answer = (i: number, text: string) => {
    const m = room.state().current!;
    const w = workers.find((x) => x.id === m.seats[i].workerId)!;
    w.status = 'working';
    room.onWorker(w);
    const at = new Date().toISOString();
    appendFileSync(transcript(w.id), JSON.stringify({ type: 'user', timestamp: at, message: { content: 'the prompt' } }) + '\n');
    appendFileSync(transcript(w.id), JSON.stringify({ type: 'assistant', timestamp: at, message: { id: `m${Math.random()}`, content: [{ type: 'text', text }] } }) + '\n');
    w.status = 'done';
    room.onWorker(w);
  };
  const start = (req: Partial<MeetingRequest>) => room.start({ pattern: 'debate', prompt: 'Which cache should we use?', roles: [], ...req } as MeetingRequest, 'Ada');
  return { dir, room, workers, prompts, typed, toasts, reviews, memories, answer, take, settle, start, cwd, kill: (id: string) => manager.kill(id), close() { room.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a debate runs its rounds and ends when the chair writes the decision', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 3, output: 'docs/decision.md' }), undefined);
  let m = f.room.state().current!;
  assert.equal(m.seats.length, 3);
  assert.deepEqual(m.seats.map((s) => s.role), ['Chair', "Devil's advocate", 'Pragmatist']);
  assert.equal(f.workers.length, 3);
  assert.match(f.prompts[0].text, /Round 1 of 3, proposing/);
  assert.match(f.prompts[0].text, /Which cache should we use\?/);
  for (const i of [0, 1, 2]) f.take(i);
  m = f.room.state().current!;
  assert.equal(m.round, 2);
  assert.equal(m.turns.length, 3);
  assert.ok(m.turns.every((x) => x.state === 'sent'));
  assert.match(f.prompts.at(-1)!.text, /Round 2 of 3, critiquing/);
  for (const i of [0, 1, 2]) f.take(i);
  m = f.room.state().current!;
  assert.equal(m.round, 3);
  assert.deepEqual(m.turns.map((x) => [x.seat, x.file]), [[0, 'docs/decision.md']]);
  assert.match(f.prompts.at(-1)!.text, /writing the decision/);
  f.take(0, '# We use Redis');
  m = f.room.state().current!;
  assert.equal(m.status, 'done');
  assert.equal(readFileSync(path.join(f.dir, 'docs/decision.md'), 'utf8'), '# We use Redis');
  assert.equal(m.preview, '# We use Redis');
  // The notes are kept by the floor's other state.
  assert.ok(existsSync(path.join(f.dir, '.agent-office', 'meetings', m.id)));
});

test('the meeting stops once it runs over its token budget, and says so', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ budget: 100_000 }), undefined);
  const w = f.workers[0];
  w.status = 'working';
  w.usage = { input: 90_000, output: 20_000, cacheRead: 0, cacheWrite: 0, cost: 0.5, calls: 3 };
  f.room.onWorker(w);
  const m = f.room.state().current!;
  assert.equal(m.status, 'stopped');
  assert.match(m.reason!, /over budget: 110k of 100k tokens/);
  // Whoever was busy is told to stop.
  assert.deepEqual(f.typed, [{ id: w.id, data: '\x1b' }]);
});

test('a worker that ends its part without writing the file is reminded once, then the meeting stops', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2, output: 'decision.md' }), undefined);
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, '', true);
  assert.match(f.prompts.at(-1)!.text, /without writing \S*[\\/]decision\.md,/);
  assert.equal(f.room.state().current!.status, 'running');
  f.take(0, '', true);
  const m = f.room.state().current!;
  assert.equal(m.status, 'stopped');
  assert.match(m.reason!, /round limit without writing decision\.md/);
});

test('sending a worker home stops the meeting and names who left', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({}), undefined);
  await f.kill(f.room.state().current!.seats[2].workerId!);
  const m = f.room.state().current!;
  assert.equal(m.status, 'stopped');
  // A helper at the table goes by its job, so the reason doesn't say it twice.
  assert.match(m.reason!, /the Pragmatist was sent home/);
});

test('red / blue ends early when red finds nothing more', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'redblue', prompt: 'The login change', rounds: 3 }), undefined);
  f.settle();
  let m = f.room.state().current!;
  assert.deepEqual(m.seats.map((s) => s.role), ['Blue team', 'Red team']);
  f.take(1, '- src/login.ts:12 — token compared with ==');
  m = f.room.state().current!;
  assert.equal(m.step, 2);
  assert.match(f.prompts.at(-1)!.text, /Round 1 of 3, fixing\./);
  f.take(0, 'Fixed it with a constant-time compare.');
  m = f.room.state().current!;
  assert.equal(m.round, 2);
  f.take(1, 'NO FINDINGS');
  m = f.room.state().current!;
  assert.equal(m.lastRound, 2);
  assert.equal(m.turns[0].file, m.output);
  f.take(0, '# Red / blue\n\nOne finding, fixed.');
  assert.equal(f.room.state().current!.status, 'done');
});

test('a review panel posts the combined review on the pull request', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ pattern: 'review', prompt: 'Review it' }) ?? '', /needs a pull request/);
  assert.equal(f.start({ pattern: 'review', prompt: 'Review it', pr: 42 }), undefined);
  let m = f.room.state().current!;
  assert.equal(m.output, 'reviews/pr-42.md');
  assert.equal(m.title, 'Review of PR #42');
  assert.match(f.prompts[1].text, /through your lens, Security/);
  for (const i of [0, 1, 2]) f.take(i, '- a.ts:1 — something');
  assert.match(f.prompts.at(-1)!.text, /\*\*\[Security\]\*\*/);
  f.take(0, 'Looks fine. **[Security]** a.ts:1 — something');
  await new Promise((r) => setImmediate(r));
  m = f.room.state().current!;
  assert.equal(m.status, 'done');
  assert.deepEqual(f.reviews, [{ pr: 42, file: path.join(f.dir, 'reviews/pr-42.md') }]);
  assert.equal(m.review?.url, 'https://github.com/o/r/pull/42#pullrequestreview-1');
});

test('map-reduce hands each mapper its own parts', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ pattern: 'mapreduce', parts: ['src/a.ts'] }) ?? '', /at least 2 parts/);
  assert.equal(f.start({ pattern: 'mapreduce', parts: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }), undefined);
  const mapper1 = f.prompts.find((p) => p.id === f.workers[1].id)!.text;
  const mapper2 = f.prompts.find((p) => p.id === f.workers[2].id)!.text;
  assert.match(mapper1, /- src\/a\.ts\n- src\/c\.ts/);
  assert.match(mapper2, /- src\/b\.ts\n/);
  assert.match(f.prompts[0].text, /Round 1 has no part for you/);
});

test('bad requests are turned away before anyone sits down', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ prompt: '  ' }) ?? '', /what the meeting is about/);
  assert.match(f.start({ output: '../x.md' }) ?? '', /\.\./);
  assert.match(f.start({ output: '/etc/x' }) ?? '', /relative/);
  assert.match(f.start({ output: '.agent-office/x.md' }) ?? '', /\.agent-office/);
  assert.match(f.start({ roles: Array.from({ length: 17 }, (_, i) => `r${i}`) }) ?? '', /2 to 16 workers/);
  assert.match(f.start({ pattern: 'redblue', roles: ['a', 'b', 'c'] }) ?? '', /seats 2 workers/);
  assert.equal(f.workers.length, 0);
  assert.equal(f.start({}), undefined);
  assert.match(f.start({}) ?? '', /busy/);
});

test('in a git project the output is committed on the meeting branch, which outlives the room being cleared', async (t) => {
  const f = fixture({ git: true }); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2, output: 'docs/decision.md', title: 'Pick a cache' }), undefined);
  const m0 = f.room.state().current!;
  assert.match(m0.worktree!.branch, /^office\/meeting-pick-a-cache-/);
  assert.ok(f.workers.every((w) => w.worktree?.path === m0.worktree!.path));
  // Every file a part names is a full path inside the meeting's worktree, never the project folder around it.
  assert.ok(f.prompts[0].text.includes(`Write it to ${path.join(f.cwd(), '.meeting', 'r1-1-chair.md')},`));
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, '# Redis\n');
  for (let i = 0; i < 50 && !f.room.state().current!.commit; i++) await new Promise((r) => setTimeout(r, 20));
  const m = f.room.state().current!;
  assert.equal(m.status, 'done');
  assert.ok(m.commit);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
  assert.equal(git('show', `${m.worktree!.branch}:docs/decision.md`), '# Redis');
  // Notes stay out of the commit.
  assert.equal(git('show', '--name-only', '--format=', m.worktree!.branch), 'docs/decision.md');
  assert.equal(f.room.clear('Ada'), undefined);
  for (let i = 0; i < 50 && existsSync(path.join(f.dir, m.worktree!.path)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.workers.length, 0);
  assert.ok(!existsSync(path.join(f.dir, m.worktree!.path)));
  assert.equal(git('rev-parse', '--abbrev-ref', m.worktree!.branch), m.worktree!.branch);
  assert.equal(f.room.state().current, null);
  assert.match(f.room.state().past[0].summary, /Debate · 2 rounds · 0 tokens · \$0\.00 · ✅ docs\/decision\.md on office\/meeting-pick-a-cache-/);
});

test('only the real meeting patterns pass, not what every object inherits', () => {
  for (const id of MEETING_PATTERN_IDS) assert.equal(isMeetingPattern(id), true);
  for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'nope', 1, null, undefined]) assert.equal(isMeetingPattern(v), false, String(v));
});

test('a meeting seats the teammates picked for each chair, and a helper where none was', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ roles: ['Chair', "Devil's advocate", 'Pragmatist'], members: [ONE, TWO, ''] }), undefined);
  const m = f.room.state().current!;
  assert.deepEqual(m.seats.map((s) => s.member), [ONE, TWO, undefined]);
  assert.deepEqual(f.workers.map((w) => w.role), [ONE, TWO, undefined]);
});

test('a chair given someone not on the roster gets a helper', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ members: ['nobody', THREE] }), undefined);
  assert.deepEqual(f.room.state().current!.seats.map((s) => s.member).slice(0, 2), [undefined, THREE]);
});

test('a follow-up goes to the head of the table, who hands parts to the teammates it names, then answers', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2, output: 'docs/decision.md' }), undefined);
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, '# Use Redis');
  let m = f.room.state().current!;
  assert.equal(m.status, 'done');
  assert.equal(f.room.followUp('   ', 'Ada'), 'Say what you want to follow up on');
  assert.equal(f.room.followUp('What about cost?', 'Ada'), undefined);
  m = f.room.state().current!;
  assert.equal(m.status, 'running');
  assert.equal(m.followup, 1);
  assert.ok(m.budget > m.tokens);
  assert.deepEqual(m.turns.map((x) => [x.seat, x.doing]), [[0, 'planning']]);
  assert.match(f.prompts.at(-1)!.text, /Follow-up 1, planning\. Ada has a follow-up for the table: “What about cost\?”/);
  // The plan names only the Pragmatist.
  f.take(0, '## Pragmatist\nPrice out Redis vs Memcached.\n');
  m = f.room.state().current!;
  assert.deepEqual(m.turns.map((x) => x.seat), [2]);
  assert.deepEqual(m.followups![0].helpers, ['Pragmatist']);
  assert.match(f.prompts.at(-1)!.text, /your part is under `## Pragmatist`/);
  f.take(2, 'Redis is $20/mo.');
  m = f.room.state().current!;
  assert.deepEqual(m.turns.map((x) => [x.seat, x.doing]), [[0, 'answering']]);
  f.take(0, 'Redis: $20 a month, worth it.');
  m = f.room.state().current!;
  assert.equal(m.status, 'done');
  assert.equal(m.followup, undefined);
  assert.equal(m.followups![0].status, 'done');
  assert.match(m.followups![0].preview!, /worth it/);
  const out = readFileSync(path.join(f.cwd(), 'docs/decision.md'), 'utf8');
  assert.match(out, /# Use Redis[\s\S]*## Follow-up 1: What about cost\?[\s\S]*brought in Pragmatist[\s\S]*worth it/);
});

test('a head of the table that can answer alone skips the others; a cleared room takes no follow-up', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2 }), undefined);
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, 'Decided.');
  assert.equal(f.room.followUp('Is that final?', 'Ada'), undefined);
  f.take(0, 'ANSWER MYSELF');
  const m = f.room.state().current!;
  assert.deepEqual(m.turns.map((x) => [x.seat, x.doing]), [[0, 'answering']]);
  assert.deepEqual(m.followups![0].helpers, []);
  f.take(0, 'Yes.');
  assert.equal(f.room.state().current!.status, 'done');
  assert.equal(f.room.clear('Ada'), undefined);
  assert.match(f.room.followUp('One more?', 'Ada')!, /no meeting to follow up/);
});

test('a big table seats more than the room has chairs', (t) => {
  const f = fixture(); t.after(() => f.close());
  const roles = Array.from({ length: 12 }, (_, i) => `Seat ${i + 1}`);
  assert.match(f.start({ roles: Array.from({ length: 17 }, (_, i) => `S${i}`) }) ?? '', /2 to 16 workers/);
  assert.equal(f.start({ roles }), undefined);
  const m = f.room.state().current!;
  assert.equal(m.seats.length, 12);
  assert.deepEqual(m.seats.slice(4, 7).map((s) => s.deskId), ['meeting-5', 'meeting-6', 'meeting-7']);
});

test('files attached to a meeting are copied into its notes and named in every brief; others are left out', (t) => {
  const f = fixture(); t.after(() => f.close());
  mkdirSync(path.join(f.dir, 'attachments', '2026-10'), { recursive: true });
  const shot = path.join(f.dir, 'attachments', '2026-10', 'chart.png');
  writeFileSync(shot, 'png');
  const outside = path.join(f.dir, 'secret.txt');
  writeFileSync(outside, 'no');
  assert.equal(f.start({ attachments: [shot, outside, path.join(f.dir, 'attachments', 'nope.png')] }), undefined);
  const m = f.room.state().current!;
  assert.equal(m.attachments?.length, 1);
  assert.ok(existsSync(m.attachments![0]));
  assert.ok(m.attachments![0].startsWith(path.join(f.cwd(), m.notes)));
  assert.equal(readFileSync(m.attachments![0], 'utf8'), 'png');
  for (const w of f.workers) assert.match(f.prompts.find((p) => p.id === w.id)!.text, /📎 Ada attached a file[\s\S]*chart\.png/);
  assert.ok(!f.prompts.some((p) => p.text.includes('secret.txt')));
});

test('a conversation: everyone answers the opening question, then a message to one seat catches it up first', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'talk', prompt: 'Launch on the 14th or the 21st?', roles: ['Planner', 'Engineer', 'Critic'] }), undefined);
  let m = f.room.state().current!;
  assert.equal(m.pattern, 'talk');
  assert.equal(m.thread!.length, 1);
  assert.deepEqual(m.replying!.map((r) => [r.seat, r.state]), [[0, 'sent'], [1, 'sent'], [2, 'sent']]);
  assert.match(f.prompts[0].text, /conversation meeting/);
  assert.match(f.prompts[0].text, /For you to answer, from Ada \(asked of everyone at the table\):\n\nLaunch on the 14th or the 21st\?/);
  assert.match(f.prompts[0].text, /memory\.md/);
  assert.ok(existsSync(path.join(f.cwd(), m.notes, 'memory.md')));
  f.answer(0, 'The 14th.');
  f.answer(1, 'Code is ready by the 12th.');
  m = f.room.state().current!;
  assert.equal(m.thread!.length, 3);
  assert.equal(f.memories.length, 0, 'the memory waits until everyone has answered');
  f.answer(2, 'The 21st, after the beta.');
  m = f.room.state().current!;
  assert.deepEqual(m.thread!.map((x) => x.from), ['you', 0, 1, 2]);
  assert.equal(m.replying!.length, 0);
  assert.equal(f.memories.length, 1);
  assert.match(f.memories[0], /The 14th[\s\S]*after the beta/);
  await new Promise((r) => setImmediate(r));
  m = f.room.state().current!;
  assert.equal(m.memory, '# Memory 1\n- noted');
  assert.equal(readFileSync(path.join(f.cwd(), m.notes, 'memory.md'), 'utf8'), '# Memory 1\n- noted');
  // Just the Critic: told what it missed (the others' answers), then asked.
  const before = f.prompts.length;
  assert.equal(f.room.say('Critic, what would change your mind?', [2], 'Ada'), undefined);
  m = f.room.state().current!;
  assert.deepEqual(m.replying!.map((r) => [r.seat, r.state]), [[2, 'sent']]);
  const ask = f.prompts.slice(before).at(-1)!;
  assert.equal(ask.id, m.seats[2].workerId);
  assert.match(ask.text, /Since you last spoke[\s\S]*The 14th[\s\S]*ready by the 12th/);
  assert.match(ask.text, /For you to answer, from Ada:\n\nCritic, what would change your mind\?/);
  f.answer(2, 'A green beta.');
  m = f.room.state().current!;
  assert.equal(m.thread!.at(-1)!.text, 'A green beta.');
  assert.equal(m.thread!.at(-1)!.re, m.thread!.at(-2)!.id);
  assert.match(readFileSync(path.join(f.cwd(), m.notes, 'thread.md'), 'utf8'), /Ada → Critic[\s\S]*A green beta/);
  assert.match(f.room.say('', undefined, 'Ada') ?? '', /Say something/);
});

test('ending a conversation writes it up; saying something opens it again', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'talk', prompt: 'Plan the week', roles: ['Planner', 'Helper'], output: 'docs/week.md' }), undefined);
  f.answer(0, 'Monday: invoices.');
  f.answer(1, 'Tuesday: calls.');
  await new Promise((r) => setImmediate(r));
  assert.equal(f.room.stop('Ada'), undefined);
  let m = f.room.state().current!;
  assert.equal(m.status, 'done');
  const out = readFileSync(path.join(f.cwd(), 'docs/week.md'), 'utf8');
  assert.match(out, /# Plan the week[\s\S]*# Memory 1[\s\S]*## The conversation[\s\S]*Monday: invoices\.[\s\S]*Tuesday: calls\./);
  assert.equal(f.room.say('One more thing: Friday?', [1], 'Ada'), undefined);
  m = f.room.state().current!;
  assert.equal(m.status, 'running');
  assert.deepEqual(m.replying!.map((r) => r.seat), [1]);
});

test('a seat that ends its turn without answering is asked once more, then the table moves on', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'talk', prompt: 'Hi', roles: ['A', 'B'] }), undefined);
  const m0 = f.room.state().current!;
  const w = f.workers.find((x) => x.id === m0.seats[1].workerId)!;
  w.status = 'working';
  f.room.onWorker(w);
  w.status = 'done';
  f.room.onWorker(w);
  assert.match(f.prompts.at(-1)!.text, /without answering/);
  w.status = 'working';
  f.room.onWorker(w);
  w.status = 'done';
  f.room.onWorker(w);
  const m = f.room.state().current!;
  assert.match(m.thread!.at(-1)!.text, /didn't answer/);
  assert.ok(m.thread!.at(-1)!.system);
});
