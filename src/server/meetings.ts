import { TEAM_BY_ID } from '../shared/team.js';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { MEETING_ALL_SEATS } from '../shared/layout.js';
import { MAX_MEETING_BUDGET, MEETING_NOTES_DIR, MEETING_PATTERNS, TOKENS_PER_SEAT, isMeetingPattern, meetingRecord, outputProblem, slugify } from '../shared/meetings.js';
import { CLAUDE_MODEL_IDS, fmtTokens, isAgentEffort, isAgentProvider, tokensOf, type AgentEffort, type AgentProvider, type Meeting, type MeetingMessage, type MeetingRecord, type MeetingReply, type MeetingRequest, type MeetingState, type MeetingTurn, type WorkerInfo, type WorkerStatus } from '../shared/protocol.js';
import { validateWorkerEffort, validateWorkerModel } from './agents.js';
import { gitError, type WorktreeRef, type WorktreeState } from './worktrees.js';
import { readChat } from './chat.js';
import { edition } from '../shared/edition.js';

const execFileP = promisify(execFile);

/** What the meeting room needs from the worker manager. Narrow on purpose, so a test can fake it. */
export interface MeetingWorkers {
  readonly defaultProvider: AgentProvider;
  list(): WorkerInfo[];
  /** Seats an agent at a chair of the meeting table, for meeting `meeting`, in its worktree when it has one. */
  seat(deskId: string, by: string, prompt: string, provider: AgentProvider, model: string | undefined, effort: AgentEffort | undefined, meeting: { id: string; worktree?: Meeting['worktree'] }, member?: string, label?: string): WorkerInfo | string;
  prompt(id: string, text: string, by?: string): string | undefined;
  /** Keys into its terminal: Esc, to stop what it's doing. */
  write(id: string, data: string, by: string): void;
  kill(id: string): Promise<{ note?: string; error?: string }>;
  /** Where a worker's conversation is written (a conversation meeting reads each reply from it). */
  transcriptOf?(id: string): string | undefined;
}

/** Git for the meeting's own worktree: made when it starts, tidied away once everyone has gone home. */
export interface MeetingTrees {
  create(slug: string): (Required<WorktreeRef> & { from?: string }) | string;
  inspect(wt: WorktreeRef): Promise<WorktreeState>;
  remove(wt: WorktreeRef, cleanup: 'worktree' | 'all'): Promise<string | undefined>;
}

export interface MeetingEvents {
  update(state: MeetingState): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  /** Why nobody may be hired right now (today's budget is spent), if that's so. */
  hiringPaused(): string | undefined;
  /** Posts the review panel's review on its pull request. Resolves to the review's URL. */
  postReview(pr: number, file: string): Promise<string>;
  /** Has Sonnet write the recap of a meeting from everything said at it (recap.ts); null when it can't. */
  recap?(input: string, model?: string): Promise<string | null>;
  /** Has Haiku fold a conversation meeting's newest exchange into its shared memory (recap.ts); null when it can't. */
  memory?(input: string): Promise<string | null>;
}

/** How much of a conversation the meeting room keeps, and how long one line can be. */
const THREAD_MAX = 600;
const SAY_MAX = 20_000;
const REPLY_MAX = 12_000;
/** How much of each line a seat is shown when it's caught up on what it missed. */
const CATCHUP_LINE = 1_500;
/** How long a seat sits ready, with its transcript unchanged, before its reply is read. */
export const talkTiming = { replySettleMs: 3_000 };

/** Where a floor keeps its finished meetings, relative to its checkout: listed with its 📊 Reports. */
export const MEETINGS_SAVED_DIR = 'reports/meetings';
/** How much of a meeting Sonnet reads for the recap. */
const RECAP_INPUT_MAX = 150_000;

/** Everything written at a meeting: the final write-up and each note, in order. */
interface Transcript {
  output: string;
  notes: { label: string; text: string }[];
}

const PUMP_MS = 3000;
/** A part handed to a worker that sits ready this long without starting on it is handed over again, once. */
const START_GRACE_MS = 60_000;
/** How much of the output file the board in the room shows. */
const PREVIEW_CHARS = 6000;
const PAST_MAX = 20;
const PROMPT_MAX = 20_000;
const ROLE_MAX = 40;
const PARTS_MAX = 100;
/** Who the office types a meeting's prompts as. */
const BY = 'the meeting room';
/** What a red team or a reviewer writes when it has nothing to report. */
const NOTHING = /^\W*no findings\b/i;

/** Ready for its next part: not starting up, busy, waiting on someone, or asleep. */
const ready = (s: WorkerStatus) => s === 'idle' || s === 'done';

/** A part of a round, before it's handed over. */
interface Part {
  seat: number;
  doing: string;
  file: string;
  /** What the worker is told to do, after the "Round n of m" line. */
  ask: string;
}

/**
 * The meeting room. A meeting seats 2–5 agents round the table, each with a role, and runs them
 * through the rounds of its pattern (shared/meetings.ts): in each step every worker with a part gets
 * it as a prompt, and the step is over when each of them has ended its turn with its part written to
 * the file it names. Checking the files, not the talk, is what moves a meeting on. It ends when the
 * output file is written, and stops early, saying why, when it runs over its token budget, when a
 * worker won't write its part, or when a worker leaves.
 *
 * Everyone at the table shares the meeting's own git worktree (in a git project). When it's done,
 * the office commits the output there, or for a review panel posts it on the pull request. The
 * workers stay at the table to be looked at until the room is cleared or the next meeting is called.
 */
export class MeetingRoom {
  private current: Meeting | null = null;
  private past: MeetingRecord[] = [];
  private statePath: string;
  private timer: NodeJS.Timeout;
  private pumping = false;
  private again = false;
  /** Token counts changed: told everyone on the next tick rather than on every worker update. */
  private dirty = false;
  private closing = false;
  /** When each handed-over part's worker was first seen ready without having started on it. */
  private readySince = new Map<MeetingTurn, number>();

  constructor(
    /** The project's checkout. */
    private dir: string,
    private dataDir: string,
    private workers: MeetingWorkers,
    /** Git worktrees, in a project that's a git repository. */
    private trees: MeetingTrees | undefined,
    private events: MeetingEvents,
  ) {
    this.statePath = path.join(dataDir, 'meetings.json');
    this.restore();
    this.timer = setInterval(() => this.tick(), PUMP_MS);
    // Over, but its recap never got written (the office restarted meanwhile, or it ended before recaps): write it now.
    const m = this.current;
    if (m && m.status !== 'running' && !m.recap && m.recapState !== 'failed') setTimeout(() => this.wrapUp(m), 5000);
  }

  state(): MeetingState {
    return { current: this.current && { ...this.current, seats: this.current.seats.map((s) => ({ ...s })), turns: this.current.turns.map((t) => ({ ...t })) }, past: this.past.slice() };
  }

  /** Calls a meeting. Returns why it couldn't, or undefined once everyone is sitting down. */
  start(req: MeetingRequest, by: string): string | undefined {
    if (this.current?.status === 'running') return `The meeting room is busy with “${this.current.title}”: stop that meeting first`;
    if (!isMeetingPattern(req.pattern)) return 'Unknown meeting pattern';
    const pattern = MEETING_PATTERNS[req.pattern];
    const paused = this.events.hiringPaused();
    if (paused) return paused;
    const prompt = String(req.prompt ?? '').replace(/\r\n?/g, '\n').trim().slice(0, PROMPT_MAX);
    if (!prompt) return 'Say what the meeting is about';
    const provider = req.provider ?? this.workers.defaultProvider;
    if (!isAgentProvider(provider) || (provider === 'custom' && this.workers.defaultProvider !== 'custom')) return 'Unknown agent provider';
    const model = provider === 'claude' || provider === 'opencode' ? req.model || undefined : undefined;
    const effort = provider === 'claude' && isAgentEffort(req.effort) ? req.effort : undefined;
    const bad = validateWorkerModel('agent', provider, model) ?? validateWorkerEffort('agent', provider, effort);
    if (bad) return bad;

    const given = Array.isArray(req.roles) ? req.roles.map((r) => String(r ?? '').replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX)) : [];
    const count = given.length || pattern.seats.default;
    if (count < pattern.seats.min || count > Math.min(pattern.seats.max, MEETING_ALL_SEATS.length)) {
      return pattern.seats.min === pattern.seats.max ? `A ${pattern.label} meeting seats ${pattern.seats.min} workers` : `A ${pattern.label} meeting seats ${pattern.seats.min} to ${pattern.seats.max} workers`;
    }
    // In a conversation, a chair with a teammate and no job given goes by the teammate's name.
    const pickedFor = (i: number) => (Array.isArray(req.members) && TEAM_BY_ID.get(String(req.members[i] ?? ''))) || undefined;
    const roles = numbered(Array.from({ length: count }, (_, i) => given[i] || (req.pattern === 'talk' ? pickedFor(i)?.name : undefined) || pattern.roles[i] || `Worker ${i + 1}`));
    // Who sits in each chair: a teammate from the roster (with their own brief, model and effort), or a helper.
    const members = Array.from({ length: count }, (_, i) => {
      const id = Array.isArray(req.members) ? String(req.members[i] ?? '') : '';
      return TEAM_BY_ID.has(id) ? id : undefined;
    });

    const pr = Number.isInteger(req.pr) && (req.pr as number) > 0 ? (req.pr as number) : undefined;
    if (pattern.needs === 'pr' && pr === undefined) return 'A review panel needs a pull request to review';
    const parts = (Array.isArray(req.parts) ? req.parts : []).map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, PARTS_MAX);
    if (pattern.needs === 'parts' && parts.length < count - 1) return `List at least ${count - 1} part${count === 2 ? '' : 's'} for the mappers, one per line (or seat fewer workers)`;
    const issue = Number.isInteger(req.issue) && (req.issue as number) > 0 ? (req.issue as number) : undefined;
    const rounds = clamp(Math.floor(Number(req.rounds) || pattern.rounds.default), pattern.rounds.min, pattern.rounds.max);
    const budget = clamp(Math.floor(Number(req.budget) || count * TOKENS_PER_SEAT), 50_000, MAX_MEETING_BUDGET);
    const title = (String(req.title ?? '').replace(/\s+/g, ' ').trim() || (pr !== undefined && req.pattern === 'review' ? `Review of PR #${pr}` : firstLine(prompt))).slice(0, 100);
    const id = randomBytes(4).toString('hex');
    const slug = slugify(title, 32);
    const output = String(req.output ?? '').trim() || pattern.output(slug, pr);
    const outputBad = outputProblem(output);
    if (outputBad) return outputBad;

    // The last meeting's workers make room: they go home, and their worktree is tidied away after them.
    const last = this.current;
    if (last) void this.dismiss(last);
    const busy = MEETING_ALL_SEATS.slice(0, count).find((d) => this.workers.list().some((w) => w.deskId === d.id));
    if (busy) return 'Someone is still sitting at the meeting table';

    let worktree: Meeting['worktree'];
    if (this.trees) {
      const made = this.trees.create(`meeting-${slug}-${id.slice(0, 4)}`);
      if (typeof made === 'string') return made;
      worktree = made;
    }
    const m: Meeting = {
      id,
      pattern: req.pattern,
      title,
      prompt,
      output,
      seats: roles.map((role, i) => ({ role, deskId: MEETING_ALL_SEATS[i].id, ...(members[i] ? { member: members[i] } : {}) })),
      parts: pattern.needs === 'parts' ? parts : undefined,
      pr,
      issue,
      provider,
      model,
      effort,
      rounds,
      round: 1,
      step: 1,
      turns: [],
      budget,
      tokens: 0,
      cost: 0,
      costKnown: true,
      status: 'running',
      calledBy: by,
      startedAt: Date.now(),
      worktree,
      // Without git, the notes go with the floor's other state.
      notes: worktree ? MEETING_NOTES_DIR : `.agent-office/meetings/${id}`,
    };
    mkdirSync(path.join(this.cwd(m), m.notes), { recursive: true });
    const files = this.takeAttachments(m, req.attachments);
    if (files.length) m.attachments = files;
    const talk = m.pattern === 'talk';
    if (talk) {
      // The question is the opening message, to everyone: each seat's first prompt asks for its answer.
      const opening: MeetingMessage = { id: msgId(), from: 'you', by, text: prompt, at: Date.now(), ...(files.length ? { attachments: files } : {}) };
      m.thread = [opening];
      m.replying = m.seats.map((_, i) => ({ seat: i, re: opening.id, state: 'sent', sentAt: Date.now() }));
      for (const s of m.seats) s.seen = 1;
      this.memoryFrom = 0;
      this.writeMemoryFile(m, `# ${title}\n\n## Where things stand\n- Just started: ${firstLine(prompt).slice(0, 200)}\n`);
      this.appendThread(m, opening);
    }
    const first = talk ? [] : (this.plan(m, 1, 1) ?? []);
    for (let i = 0; i < m.seats.length; i++) {
      const part = first.find((p) => p.seat === i);
      const text = `${this.brief(m, i)}\n\n${talk ? this.talkAsk(m, i, m.thread![0], false) : part ? this.ask(m, part) : `Round 1 has no part for you. Reply in one line that you're ready and end your turn; your part comes in a later message.`}`;
      const w = this.workers.seat(m.seats[i].deskId, `${by} (meeting)`, text, provider, model, effort, { id, worktree }, m.seats[i].member, m.seats[i].member ? undefined : m.seats[i].role);
      if (typeof w === 'string') {
        for (const s of m.seats) if (s.workerId) void this.workers.kill(s.workerId);
        if (worktree && this.trees) void this.trees.remove(worktree, 'all');
        return w;
      }
      m.seats[i].workerId = w.id;
      m.seats[i].workerName = w.name;
    }
    const now = Date.now();
    m.turns = first.map((p) => ({ seat: p.seat, doing: p.doing, file: p.file, state: 'sent', sentAt: now }));
    if (last) this.archive(last);
    this.current = m;
    this.changed();
    this.events.toast(talk ? `💬 ${by} started a conversation with ${count === 1 ? 'one teammate' : `${count} teammates`}: “${title}”` : `🤝 ${by} called a ${pattern.label} meeting: “${title}” (${count} workers, ${rounds} round${rounds === 1 ? '' : 's'} at most, ${fmtTokens(budget)} tokens)`, 'info');
    return undefined;
  }

  /**
   * Puts another question to the meeting that just ended, its workers still at the table. The head of
   * the table takes it: plans who does what, the teammates it picks do their parts, and it writes the
   * answer, which is added to the meeting's output. Then the meeting is over again, with a fresh recap.
   */
  followUp(text: string, by: string, budget?: number, attachments?: string[]): string | undefined {
    const m = this.current;
    if (!m) return 'There is no meeting to follow up: call one first';
    if (m.status === 'running') return 'The meeting is still on: wait for it to finish, or stop it';
    if (m.cleared) return 'That meeting has been cleared away: call a new one';
    if (m.pattern === 'talk') return this.say(text, undefined, by, attachments);
    const question = text.replace(/\r\n?/g, '\n').trim().slice(0, PROMPT_MAX);
    if (!question) return 'Say what you want to follow up on';
    const paused = this.events.hiringPaused();
    if (paused) return paused;
    // Anyone who went home since is seated again, in the same chair, as the same teammate.
    const here = new Set(this.workers.list().filter((w) => w.status !== 'exited').map((w) => w.id));
    for (let i = 0; i < m.seats.length; i++) {
      const s = m.seats[i];
      if (s.workerId && here.has(s.workerId)) continue;
      const w = this.workers.seat(s.deskId, `${by} (meeting)`, `${this.brief(m, i)}\n\nThe meeting is over, but it's taking a follow-up question. Reply in one line that you're ready and end your turn; your part comes in a later message.`, m.provider ?? this.workers.defaultProvider, m.model, m.effort, { id: m.id, worktree: m.worktree }, s.member, s.member ? undefined : s.role);
      if (typeof w === 'string') return `Couldn't seat the ${s.role} again: ${w}`;
      s.workerId = w.id;
      s.workerName = w.name;
    }
    const files = this.takeAttachments(m, attachments);
    m.followups = [...(m.followups ?? []), { text: question, by, at: Date.now(), status: 'running', ...(files.length ? { attachments: files } : {}) }];
    m.followup = m.followups.length;
    m.status = 'running';
    m.reason = undefined;
    m.step = 1;
    // A follow-up gets its own allowance on top of what's been used, a fresh meeting's worth unless asked.
    m.budget = m.tokens + clamp(Math.floor(budget ?? m.seats.length * TOKENS_PER_SEAT), 50_000, MAX_MEETING_BUDGET);
    m.turns = (this.followupPlan(m, 1) ?? []).map((p) => ({ seat: p.seat, doing: p.doing, file: p.file, state: 'waiting' }));
    this.changed();
    this.events.toast(`🤝 ${by} followed up the meeting on “${m.title}”: the ${m.seats[0].role} is on it`, 'info');
    this.pump();
    return undefined;
  }

  /**
   * Copies screenshots and PDFs someone attached (the floor's attachments/, see attachments.ts) into
   * the meeting's notes, where every worker at the table can open them: a meeting works in its own
   * worktree, and reading a file outside it would stop each of them to ask. Anything that isn't a file
   * in the floor's attachments/ is left out. Resolves to the copies' full paths.
   */
  private takeAttachments(m: Meeting, list: string[] | undefined): string[] {
    if (!Array.isArray(list) || !list.length) return [];
    let root: string;
    try {
      root = realpathSync(path.join(this.dir, 'attachments')) + path.sep;
    } catch {
      return [];
    }
    const dest = path.join(this.cwd(m), m.notes, 'attachments');
    const out: string[] = [];
    for (const p of list.slice(0, 12)) {
      try {
        const real = realpathSync(String(p));
        if (!real.startsWith(root) || !statSync(real).isFile()) continue;
        mkdirSync(dest, { recursive: true });
        const to = path.join(dest, path.basename(real));
        copyFileSync(real, to);
        out.push(to);
      } catch {
        // gone, or not ours: left out
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Conversation meetings (pattern 'talk')

  /**
   * Says something to a conversation meeting: to everyone at the table, or to the seats in `to`. Each
   * of them is caught up on what it missed and asked to answer; their replies join the thread as they
   * come in, and once they're all in, Haiku folds the exchange into the shared memory. A conversation
   * that was ended opens again (anyone who went home sits back down).
   */
  say(text: string, to: number[] | undefined, by: string, attachments?: string[]): string | undefined {
    const m = this.current;
    if (!m || m.pattern !== 'talk') return 'There is no conversation meeting on: call one first';
    if (m.cleared) return 'That meeting has been cleared away: call a new one';
    const said = text.replace(/\r\n?/g, '\n').trim().slice(0, SAY_MAX);
    if (!said) return 'Say something first';
    const targets = [...new Set((to ?? []).filter((i) => i >= 0 && i < m.seats.length))];
    if (to?.length && !targets.length) return 'Pick who it is for';
    if (m.status !== 'running') {
      const paused = this.events.hiringPaused();
      if (paused) return paused;
      const err = this.reseat(m, by, 'The meeting was ended, but it has opened again. Reply in one line that you\'re back and end your turn; the next message for you comes after.');
      if (err) return err;
      m.status = 'running';
      m.reason = undefined;
      m.finishedAt = undefined;
      m.recap = undefined;
      m.recapState = undefined;
      // A reopened conversation gets a fresh allowance on top of what it's used.
      m.budget = Math.max(m.budget, m.tokens + clamp(m.seats.length * TOKENS_PER_SEAT, 50_000, MAX_MEETING_BUDGET));
    }
    const files = this.takeAttachments(m, attachments);
    const msg: MeetingMessage = { id: msgId(), from: 'you', by, text: said, at: Date.now(), ...(targets.length && targets.length < m.seats.length ? { to: targets } : {}), ...(files.length ? { attachments: files } : {}) };
    this.post(m, msg);
    for (const seat of msg.to ?? m.seats.map((_, i) => i)) (m.replying ??= []).push({ seat, re: msg.id, state: 'waiting' });
    this.changed();
    this.pump();
    return undefined;
  }

  /** Ends a conversation: the record is written (memory, then every word), committed and recapped. */
  private endTalk(m: Meeting, by: string, reason?: string): undefined {
    if (m.status !== 'running') return undefined;
    // Whoever is still answering is told to stop; what they'd said so far stays in their transcript.
    const busy = new Set(this.workers.list().filter((w) => w.status === 'working').map((w) => w.id));
    for (const r of m.replying ?? []) {
      const id = m.seats[r.seat]?.workerId;
      if (id && busy.has(id) && r.state !== 'waiting') this.workers.write(id, '\x1b', BY);
    }
    m.replying = [];
    if (reason) this.post(m, { id: msgId(), from: 'you', by: 'the meeting room', text: `The meeting ended: ${reason}.`, at: Date.now(), system: true });
    let thread = '';
    try {
      thread = readFileSync(path.join(this.cwd(m), m.notes, 'thread.md'), 'utf8');
    } catch {
      thread = (m.thread ?? []).map((x) => this.threadLine(m, x)).join('');
    }
    try {
      const out = path.join(this.cwd(m), m.output);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `# ${m.title}\n\n_A conversation in ${edition.name}, started by ${m.calledBy.replace(/\s*📱\s*$/u, '')} with ${list(m.seats.map((s) => s.role))}${reason ? `; it ended: ${reason}` : `; ended by ${by}`}._\n\n${m.memory?.trim() ?? ''}\n\n---\n\n## The conversation\n\n${thread}`);
    } catch {
      // the notes still have it all
    }
    this.finish(m);
    return undefined;
  }

  /** Seats anyone who has gone home again, in the same chair as the same teammate. */
  private reseat(m: Meeting, by: string, note: string): string | undefined {
    const here = new Set(this.workers.list().filter((w) => w.status !== 'exited').map((w) => w.id));
    for (let i = 0; i < m.seats.length; i++) {
      const s = m.seats[i];
      if (s.workerId && here.has(s.workerId)) continue;
      const w = this.workers.seat(s.deskId, `${by} (meeting)`, `${this.brief(m, i)}\n\n${note}`, m.provider ?? this.workers.defaultProvider, m.model, m.effort, { id: m.id, worktree: m.worktree }, s.member, s.member ? undefined : s.role);
      if (typeof w === 'string') return `Couldn't seat the ${s.role} again: ${w}`;
      s.workerId = w.id;
      s.workerName = w.name;
      // A new agent hasn't seen any of it: its first message catches it up from the start.
      s.seen = 0;
    }
    return undefined;
  }

  /** Adds a line to the conversation, and to thread.md, the record the seats can read. */
  private post(m: Meeting, msg: MeetingMessage) {
    const thread = (m.thread ??= []);
    thread.push(msg);
    if (thread.length > THREAD_MAX) {
      const cut = thread.length - THREAD_MAX;
      thread.splice(0, cut);
      for (const s of m.seats) s.seen = Math.max(0, (s.seen ?? 0) - cut);
      this.memoryFrom = Math.max(0, this.memoryFrom - cut);
    }
    this.appendThread(m, msg);
  }

  /** Who a line is from, in words. */
  private who(m: Meeting, msg: MeetingMessage): string {
    if (msg.from === 'you') return (msg.by ?? 'Someone').replace(/\s*📱\s*$/u, '');
    const s = m.seats[msg.from];
    const member = s?.member ? TEAM_BY_ID.get(s.member) : undefined;
    return member && member.name !== s.role ? `${member.name} (${s.role})` : (s?.role ?? 'Someone');
  }

  /** A line as it reads in thread.md and in a seat's catch-up. */
  private threadLine(m: Meeting, msg: MeetingMessage, max = Infinity): string {
    const at = new Date(msg.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const to = msg.from === 'you' && !msg.system ? ` → ${msg.to?.length ? list(msg.to.map((i) => m.seats[i]?.role ?? '?')) : 'everyone'}` : '';
    const text = msg.text.length > max ? `${msg.text.slice(0, max)}… (the rest is in thread.md)` : msg.text;
    const files = msg.attachments?.length ? `\n📎 ${msg.attachments.join(', ')}` : '';
    return `### ${this.who(m, msg)}${to} · ${at}\n\n${text}${files}\n\n`;
  }

  private appendThread(m: Meeting, msg: MeetingMessage) {
    try {
      const dir = path.join(this.cwd(m), m.notes);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, 'thread.md'), this.threadLine(m, msg));
    } catch {
      // the thread is still in the meeting's state
    }
  }

  private writeMemoryFile(m: Meeting, text: string) {
    m.memory = text;
    try {
      const dir = path.join(this.cwd(m), m.notes);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'memory.md'), text);
    } catch {
      // kept in the meeting's state either way
    }
  }

  /** The prompt that asks seat `i` to answer `msg`, catching it up on what it missed first. */
  private talkAsk(m: Meeting, i: number, msg: MeetingMessage, catchUp = true): string {
    const seat = m.seats[i];
    const thread = m.thread ?? [];
    const upTo = thread.indexOf(msg);
    const missed = catchUp ? thread.slice(seat.seen ?? 0, upTo < 0 ? thread.length : upTo).filter((x) => x.from !== i) : [];
    const memory = path.join(this.cwd(m), m.notes, 'memory.md');
    const also = msg.to && msg.to.length > 1 ? ` (also asked: ${list(msg.to.filter((j) => j !== i).map((j) => `the ${m.seats[j]?.role ?? '?'}`))})` : !msg.to && m.seats.length > 1 ? ' (asked of everyone at the table)' : '';
    const files = msg.attachments?.length ? `\n\n📎 It came with ${msg.attachments.length === 1 ? 'a file' : `${msg.attachments.length} files`} (screenshots or PDFs). Open ${msg.attachments.length === 1 ? 'it' : 'them'} with your Read tool before you answer:\n${msg.attachments.map((p) => `- ${p}`).join('\n')}` : '';
    return [
      missed.length ? `💬 Since you last spoke in the meeting:\n\n${missed.map((x) => this.threadLine(m, x, CATCHUP_LINE)).join('').trim()}` : '',
      `💬 For you to answer, from ${this.who(m, msg)}${also}:\n\n${msg.text}${files}`,
      // The memory comes with the message, so nobody spends a step (and a pause) reading the file first.
      m.memory?.trim() ? `🧠 The meeting's shared memory right now (also in ${memory}):\n\n${m.memory.trim()}` : '',
      `Answer as ${seat.member ? 'yourself' : `the ${seat.role}`}, directly in your reply, and end your turn.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Where the memory has got to: the thread from here on isn't in it yet. */
  private memoryFrom = 0;
  /** Haiku is writing the memory now; `memoryAgain` says more came in meanwhile. */
  private memoryBusy = false;
  private memoryAgain = false;

  /** Moves a conversation's replies along: hands messages over, and takes the answers when they're done. */
  private runTalk(m: Meeting, byId: Map<string, WorkerInfo>) {
    const now = Date.now();
    let changed = false;
    const replying = (m.replying ??= []);
    const thread = (m.thread ??= []);
    const done = new Set<MeetingReply>();
    for (const r of replying) {
      const seat = m.seats[r.seat];
      const w = seat?.workerId ? byId.get(seat.workerId) : undefined;
      if (!w || w.status === 'exited') {
        done.add(r);
        this.post(m, { id: msgId(), from: 'you', by: 'the meeting room', text: `The ${seat?.role ?? 'teammate'} isn't at the table any more, so they couldn't answer. Say something to them to bring them back.`, at: now, system: true });
        changed = true;
        continue;
      }
      const msg = thread.find((x) => x.id === r.re);
      if (!msg) {
        done.add(r);
        continue;
      }
      if (r.state === 'waiting') {
        // One message at a time per seat: the next waits until it has answered this one.
        if (replying.some((o) => o !== r && o.seat === r.seat && o.state !== 'waiting' && !done.has(o))) continue;
        if (!ready(w.status)) continue;
        if (this.workers.prompt(w.id, this.talkAsk(m, r.seat, msg), BY)) continue;
        r.state = 'sent';
        r.sentAt = now;
        seat.seen = thread.length;
        changed = true;
        continue;
      }
      if (w.status === 'working') {
        r.readyAt = undefined;
        if (r.state !== 'working') {
          r.state = 'working';
          changed = true;
        }
        continue;
      }
      if (!ready(w.status)) {
        r.readyAt = undefined;
        continue;
      }
      // Ready again. Its status can flicker to ready between steps of one turn, and the transcript is
      // written a moment after the turn ends: only once it has sat ready and its transcript has stopped
      // changing for a few seconds is the reply all there.
      r.readyAt ??= now;
      const settle = talkTiming.replySettleMs;
      if (settle > 0 && (now - r.readyAt < settle || now - this.transcriptAt(w.id) < settle)) continue;
      // Its answer is the last thing it said since the message went over.
      const reply = this.replyOf(w.id, r.sentAt ?? 0);
      if (reply) {
        done.add(r);
        this.post(m, { id: msgId(), from: r.seat, re: r.re, text: reply.slice(0, REPLY_MAX), at: Date.now() });
        changed = true;
        continue;
      }
      // Ready but nothing said: it never started (the office restarted, or the prompt was lost), or ended
      // its turn without answering. Ask once more, then give up on this one.
      if (r.state === 'sent' && now - (r.sentAt ?? now) < START_GRACE_MS) continue;
      if (!r.retried) {
        r.retried = true;
        r.sentAt = now;
        r.readyAt = undefined;
        r.state = 'sent';
        this.workers.prompt(w.id, `You ended your turn without answering in the meeting. Answer this, directly in your reply:\n\n${msg.text}`, BY);
        changed = true;
        continue;
      }
      done.add(r);
      this.post(m, { id: msgId(), from: 'you', by: 'the meeting room', text: `The ${seat.role} didn't answer.`, at: now, system: true });
      changed = true;
    }
    if (done.size) {
      m.replying = replying.filter((r) => !done.has(r));
      // An exchange is over when nobody owes a reply to anything: fold it into the memory.
      if (!m.replying.length) this.updateMemory(m);
    }
    if (changed) this.changed();
  }

  /** When a worker's transcript last changed (0 when there's none). */
  private transcriptAt(workerId: string): number {
    const file = this.workers.transcriptOf?.(workerId);
    try {
      return file ? statSync(file).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  /** The text of the last reply a worker wrote since `since`, from its transcript. */
  private replyOf(workerId: string, since: number): string | undefined {
    const file = this.workers.transcriptOf?.(workerId);
    const msgs = readChat(file).filter((x) => x.role === 'assistant' && x.at >= since - 1000 && x.text.trim());
    return msgs.at(-1)?.text.trim();
  }

  /** Has Haiku fold everything said since the last time into the shared memory, one update at a time. */
  private updateMemory(m: Meeting) {
    if (!this.events.memory) return;
    if (this.memoryBusy) {
      this.memoryAgain = true;
      return;
    }
    const thread = m.thread ?? [];
    const from = Math.min(this.memoryFrom, thread.length);
    const fresh = thread.slice(from);
    if (!fresh.length) return;
    this.memoryBusy = true;
    m.memoryState = 'writing';
    const input = `The meeting: ${m.title}\nAt the table: ${list(m.seats.map((s) => s.role))}\n\nThe memory so far:\n${m.memory?.trim() || '(none yet)'}\n\nThe newest exchange:\n\n${fresh.map((x) => this.threadLine(m, x, 6000)).join('')}`;
    const upTo = thread.length;
    void this.events.memory(input).then((text) => {
      this.memoryBusy = false;
      if (this.current !== m) return;
      if (text) {
        this.writeMemoryFile(m, text);
        this.memoryFrom = upTo;
      }
      m.memoryState = text ? 'done' : 'failed';
      this.changed();
      if (this.memoryAgain) {
        this.memoryAgain = false;
        this.updateMemory(m);
      }
    });
  }

  /** Stops the meeting that's running. Its workers stay at the table. */
  stop(by: string): string | undefined {
    const m = this.current;
    if (!m || m.status !== 'running') return 'No meeting is on';
    if (m.pattern === 'talk') return this.endTalk(m, by);
    this.halt(m, `stopped by ${by}`);
    return undefined;
  }

  /** Sends the last meeting's workers home and clears the table. */
  clear(by: string): string | undefined {
    const m = this.current;
    if (!m) return 'Nobody is in the meeting room';
    if (m.status === 'running') return 'The meeting is still on: stop it first';
    this.events.toast(`🤝 ${by} cleared the meeting room`, 'info');
    void this.dismiss(m);
    this.archive(m);
    this.current = null;
    this.changed();
    return undefined;
  }

  /** A worker changed: cheap unless it's at the table. */
  onWorker(info: WorkerInfo) {
    if (info.meeting && info.meeting === this.current?.id) this.pump();
  }

  onWorkerGone(workerId: string) {
    if (this.current?.seats.some((s) => s.workerId === workerId)) this.pump();
  }

  pump() {
    if (this.closing) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.run();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    this.persist();
  }

  // ---------------------------------------------------------------------------

  private tick() {
    const m = this.current;
    if (m?.status === 'running' && this.readPreview(m)) this.dirty = true;
    this.pump();
    if (this.dirty) this.changed();
  }

  private run() {
    const m = this.current;
    if (!m) return;
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    if (this.tally(m, byId)) this.dirty = true;
    if (m.status !== 'running') {
      // Everyone went home one by one: tidy the worktree away after them.
      if (!m.cleared && m.seats.every((s) => !s.workerId || !byId.has(s.workerId))) void this.dismiss(m);
      return;
    }
    if (m.pattern === 'talk') {
      if (m.tokens > m.budget) return void this.endTalk(m, 'the meeting room', `over budget: ${fmtTokens(m.tokens)} of ${fmtTokens(m.budget)} tokens`);
      return this.runTalk(m, byId);
    }
    for (const s of m.seats) {
      const w = s.workerId ? byId.get(s.workerId) : undefined;
      if (!w) return this.halt(m, `the ${s.role}${s.workerName && s.workerName !== s.role ? ` (${s.workerName})` : ''} was sent home`);
      if (w.status === 'exited') return this.halt(m, `the ${s.role}'s agent (${w.name}) exited`);
    }
    if (m.tokens > m.budget) return this.halt(m, `over budget: ${fmtTokens(m.tokens)} of ${fmtTokens(m.budget)} tokens`);
    let changed = false;
    for (const t of m.turns) {
      changed = this.advance(m, t, byId.get(m.seats[t.seat].workerId!)!) || changed;
      if (m.status !== 'running') return;
    }
    if (m.turns.every((t) => t.state === 'done')) {
      this.next(m);
      changed = true;
      this.again = true;
    }
    if (changed) this.changed();
  }

  /** Moves one worker's part along. Returns whether anything changed. */
  private advance(m: Meeting, t: MeetingTurn, w: WorkerInfo): boolean {
    const now = Date.now();
    const seat = m.seats[t.seat];
    const retry = () => {
      t.retried = true;
      this.readySince.delete(t);
      return this.workers.prompt(w.id, `You ended your turn without writing ${path.join(this.cwd(m), t.file)}, which the meeting is waiting on. Write it now, then end your turn.`, BY);
    };
    switch (t.state) {
      case 'waiting': {
        if (!ready(w.status)) return false;
        const part = this.plan(m, m.round, m.step)?.find((p) => p.seat === t.seat);
        if (!part || this.workers.prompt(w.id, this.ask(m, part), BY)) return false;
        t.state = 'sent';
        t.sentAt = now;
        return true;
      }
      case 'sent': {
        if (w.status === 'working') {
          t.state = 'working';
          this.readySince.delete(t);
          return true;
        }
        if (!ready(w.status)) {
          this.readySince.delete(t);
          return false;
        }
        // Written without our seeing it work (the office restarted in between): that counts.
        if (this.written(m, t)) {
          t.state = 'done';
          return true;
        }
        const since = this.readySince.get(t) ?? now;
        this.readySince.set(t, since);
        if (now - since < START_GRACE_MS) return false;
        if (t.retried) {
          this.halt(m, `the ${seat.role} (${seat.workerName}) never started on its part of round ${m.round}`);
          return true;
        }
        const part = this.plan(m, m.round, m.step)?.find((p) => p.seat === t.seat);
        t.retried = true;
        this.readySince.delete(t);
        if (part) this.workers.prompt(w.id, this.ask(m, part), BY);
        return true;
      }
      case 'working': {
        if (!ready(w.status)) return false;
        if (this.written(m, t)) {
          t.state = 'done';
          return true;
        }
        if (t.retried) {
          const last = this.isLast(m, m.round);
          this.halt(m, last && t.file === m.output ? `reached its round limit without writing ${m.output}: the ${seat.role} ended the last round without it` : `the ${seat.role} (${seat.workerName}) ended round ${m.round} without writing ${t.file}`);
          return true;
        }
        retry();
        t.state = 'sent';
        return true;
      }
      default:
        return false;
    }
  }

  /** Every part of the step is written: on to the next step, the next round, or the end. */
  private next(m: Meeting) {
    if (m.followup) {
      const more = this.followupPlan(m, m.step + 1);
      if (!more) return this.finishFollowup(m);
      m.step++;
      m.turns = more.map((p) => ({ seat: p.seat, doing: p.doing, file: p.file, state: 'waiting' }));
      // The helpers are known once the plan is written.
      if (m.step === 2) m.followups![m.followup - 1].helpers = more.map((p) => m.seats[p.seat].role);
      return;
    }
    // Red / blue: the red team found nothing more to fix, so blue writes it up this round.
    if (m.pattern === 'redblue' && m.step === 1 && NOTHING.test(this.head(m, m.turns[0]?.file))) m.lastRound = m.round;
    const more = this.plan(m, m.round, m.step + 1);
    if (more) {
      m.step++;
      m.turns = more.map((p) => ({ seat: p.seat, doing: p.doing, file: p.file, state: 'waiting' }));
      return;
    }
    if (this.isLast(m, m.round)) return this.finish(m);
    m.round++;
    m.step = 1;
    m.turns = (this.plan(m, m.round, 1) ?? []).map((p) => ({ seat: p.seat, doing: p.doing, file: p.file, state: 'waiting' }));
  }

  private isLast(m: Meeting, round: number): boolean {
    return round >= m.rounds || m.lastRound === round;
  }

  /**
   * A follow-up's answer is written: it's added to the meeting's output (so the board, the saved
   * record and the recap all have it), committed on the meeting's branch, and the meeting is over again.
   */
  private finishFollowup(m: Meeting) {
    const n = m.followup!;
    const f = m.followups![n - 1];
    const answerFile = `${m.notes}/f${n}-answer.md`;
    let answer = '';
    try {
      answer = readStart(path.join(this.cwd(m), answerFile), 200_000).trim();
    } catch {
      // written, or the step wouldn't be done; a vanished file just leaves the answer empty
    }
    f.status = 'done';
    f.answer = answerFile;
    f.preview = answer.slice(0, PREVIEW_CHARS);
    m.followup = undefined;
    m.status = 'done';
    m.finishedAt = Date.now();
    m.turns = [];
    try {
      appendFileSync(path.join(this.cwd(m), m.output), `\n\n---\n\n## Follow-up ${n}: ${firstLine(f.text).slice(0, 120)}\n\n_Asked by ${f.by}${f.helpers?.length ? `; the ${m.seats[0].role} brought in ${list(f.helpers)}` : ''}._\n\n${answer}\n`);
    } catch {
      // the answer is still in the notes and the saved record
    }
    this.readPreview(m);
    this.keepNotes(m);
    this.wrapUp(m);
    this.events.toast(`🤝 The ${m.seats[0].role} answered the follow-up on “${m.title}”`, 'info');
    if (m.worktree && m.pattern !== 'review') {
      void commitAll(this.cwd(m), `${m.title}: follow-up ${n}\n\n${firstLine(f.text)}\n\nAsked by ${f.by} in ${edition.name}.`, m.notes).then(
        (sha) => {
          if (sha) m.commit = sha;
          this.changed();
        },
        (err) => {
          this.events.toast(`Couldn't commit the follow-up on ${m.worktree!.branch}: ${gitError(err)}`, 'warn');
          this.changed();
        },
      );
    }
  }

  /** The output is written. Commit it on the meeting's branch, or post the review on its pull request. */
  private finish(m: Meeting) {
    m.status = 'done';
    m.finishedAt = Date.now();
    m.turns = [];
    this.readPreview(m);
    this.keepNotes(m);
    this.wrapUp(m);
    const p = MEETING_PATTERNS[m.pattern];
    this.events.toast(`🤝 The ${p.label} meeting on “${m.title}” is done: it wrote ${m.output}`, 'info');
    const cwd = this.cwd(m);
    if (m.pattern === 'review' && m.pr !== undefined) {
      const pr = m.pr;
      void this.events.postReview(pr, path.join(cwd, m.output)).then(
        (url) => {
          m.review = { url };
          this.events.toast(`🔍 Posted the panel's review on PR #${pr}`, 'info');
          this.changed();
        },
        (err) => {
          m.review = { error: (err as Error).message };
          this.events.toast(`Couldn't post the panel's review on PR #${pr}: ${m.review.error}`, 'warn');
          this.changed();
        },
      );
    } else if (m.worktree) {
      void commitAll(cwd, `${m.title}\n\n${p.label} meeting in ${edition.name}, called by ${m.calledBy}. Output: ${m.output}`, m.notes).then(
        (sha) => {
          m.commit = sha;
          this.changed();
        },
        (err) => {
          this.events.toast(`Couldn't commit ${m.output} on ${m.worktree!.branch}: ${gitError(err)}`, 'warn');
          this.changed();
        },
      );
    }
  }

  /** Stops the meeting short, saying why. Whoever is still busy is told to stop (Esc). */
  private halt(m: Meeting, reason: string) {
    if (m.status !== 'running') return;
    m.status = 'stopped';
    m.reason = reason;
    if (m.followup) {
      const f = m.followups![m.followup - 1];
      f.status = 'stopped';
      f.reason = reason;
      m.followup = undefined;
    }
    m.finishedAt = Date.now();
    const busy = new Set(this.workers.list().filter((w) => w.status === 'working' || w.status === 'needs_input').map((w) => w.id));
    for (const s of m.seats) if (s.workerId && busy.has(s.workerId)) this.workers.write(s.workerId, '\x1b', BY);
    this.readPreview(m);
    this.keepNotes(m);
    this.wrapUp(m);
    this.events.toast(`⛔ The meeting on “${m.title}” stopped in round ${m.round}: ${reason}`, 'warn');
    this.changed();
  }

  /**
   * Sends a meeting's workers home, then tidies its worktree away: the branch stays when the output
   * was committed on it, and everything stays when something is left uncommitted.
   */
  private async dismiss(m: Meeting) {
    if (m.cleared) return;
    m.cleared = true;
    const here = new Set(this.workers.list().map((w) => w.id));
    await Promise.all(m.seats.filter((s) => s.workerId && here.has(s.workerId)).map((s) => this.workers.kill(s.workerId!)));
    const wt = m.worktree;
    if (!wt || !this.trees) return this.persist();
    // Kept with the floor's state already (keepNotes): the notes, and a review panel's review, which
    // is on the pull request now, go, so they don't count as work left behind.
    const cwd = this.cwd(m);
    const own = path.resolve(this.dir, '.agent-office', 'worktrees') + path.sep;
    for (const leftover of [m.notes, m.pattern === 'review' ? m.output : undefined]) {
      const abs = leftover && path.resolve(cwd, leftover);
      if (abs && abs.startsWith(own)) rmSync(abs, { recursive: true, force: true });
    }
    const state = await this.trees.inspect(wt);
    if (state.error || state.dirty) {
      this.events.toast(`Kept the “${m.title}” meeting's worktree and branch ${wt.branch}: ${state.error ?? `${state.dirty} uncommitted change${state.dirty === 1 ? '' : 's'}`}`, 'info');
    } else {
      const err = await this.trees.remove(wt, state.ahead ? 'worktree' : 'all');
      if (err) this.events.toast(`Couldn't tidy away the meeting's worktree: ${err}`, 'warn');
    }
    this.persist();
  }

  /** Puts a finished meeting on the list of earlier ones. */
  private archive(m: Meeting) {
    this.past = [meetingRecord(m), ...this.past.filter((r) => r.id !== m.id)].slice(0, PAST_MAX);
  }

  /** Adds up what the workers at the table have used. Returns whether it changed. */
  private tally(m: Meeting, byId: Map<string, WorkerInfo>): boolean {
    let tokens = 0;
    let cost = 0;
    let known = true;
    for (const s of m.seats) {
      const w = s.workerId ? byId.get(s.workerId) : undefined;
      // A worker sent home took its figures with it: keep the last ones seen.
      if (w?.usage) {
        s.tokens = tokensOf(w.usage);
        s.cost = w.usage.costKnown === false || (w.provider === 'codex' && w.usage.costKnown !== true) ? undefined : w.usage.cost;
      }
      tokens += s.tokens ?? 0;
      if (s.tokens && s.cost === undefined) known = false;
      cost += s.cost ?? 0;
    }
    if (tokens === m.tokens && cost === m.cost && known === m.costKnown) return false;
    m.tokens = tokens;
    m.cost = cost;
    m.costKnown = known;
    return true;
  }

  // --- The patterns ----------------------------------------------------------

  /** What every worker is told when it sits down, ahead of its first part. */
  private brief(m: Meeting, i: number): string {
    const p = MEETING_PATTERNS[m.pattern];
    const role = m.seats[i].role;
    const others = m.seats.filter((_, j) => j !== i).map((s) => `the ${s.role}`);
    const head = m.seats[0].role;
    const how: Record<Meeting['pattern'], string> = {
      debate: `Round 1: everyone proposes an answer. Each round after that until the last: everyone reads the others' latest notes, critiques them and revises their own. Last round: the ${head} writes the decision.`,
      lead: `Round 1: the ${head} splits the task into a part for each of the others and writes the plan. Round 2: each of them does their part. Round 3: the ${head} merges the work, checks it and writes it up.`,
      mapreduce: `Round 1: each mapper does the task over its own parts. Round 2: the ${head} combines what they found into one result.`,
      redblue: `Each round the Red team attacks the change (bugs, security holes, edge cases) and the Blue team fixes what holds up. The ${head} writes it all up in the last round, which comes early if Red finds nothing more.`,
      review: `Round 1: each reviewer reviews the pull request through their own lens. Round 2: the ${head} merges the reviews into one, which the office posts on the pull request.`,
      talk: `It's a conversation, not a set of rounds: ${m.calledBy.replace(/\s*📱\s*$/u, '')} talks with the table, sometimes to everyone and sometimes to just some of you, for as long as it takes.`,
    };
    const where = !m.worktree
      ? `You're in the project's folder, which other people use too: don't commit, push or switch branches.`
      : m.pattern === 'review'
        ? `This is a review: don't change, commit or push anything in the checkout. The only files you write are your notes${i === 0 ? ` and ${m.output}` : ''}.`
        : `You all share one git worktree, on the branch ${m.worktree.branch}. Don't commit, push or switch branches: when the meeting is over, the office commits ${m.output}, with whatever else was changed, there.`;
    // The worktree sits inside the project's own folder, where a search can wander off to.
    const inside = m.worktree ? ` The whole project is checked out in your working directory: read and write files there, by paths inside it, and never in a folder above it.` : '';
    if (m.pattern === 'talk') {
      const notes = path.join(this.cwd(m), m.notes);
      return [
        m.title,
        `You're ${m.seats[i].member ? '' : `the ${role} `}in a conversation meeting in ${edition.name}'s meeting room, round the table with ${others.length ? list(others) : 'nobody else'}. ${how.talk}`,
        `How it works: each message the office hands you is for you to answer. Answer in your reply itself, in plain words, as yourself: your reply is what everyone at the table sees, and the person often reads it on their phone, so lead with the answer and keep it short unless they ask for detail. Don't write files for the meeting (the office keeps the record); you may read and look up whatever you need. Each message comes with the meeting's shared memory, kept up to date for everyone (it's also in ${path.join(notes, 'memory.md')}), and anything you missed since you last spoke; the whole conversation word for word is in ${path.join(notes, 'thread.md')} if you need it. It runs on a budget of ${fmtTokens(m.budget)} tokens between all of you.`,
        where + inside,
      ].join('\n\n');
    }
    return [
      m.title,
      `You're the ${role} in a ${p.label} meeting in ${edition.name}'s meeting room, round the table with ${list(others)}. ${how[m.pattern]}`,
      `What the meeting is about:\n${m.prompt}`,
      m.attachments?.length ? attachedNote(m.calledBy, m.attachments) : '',
      m.pr !== undefined ? `The pull request is #${m.pr}: read it with gh pr view ${m.pr} and gh pr diff ${m.pr}.` : '',
      m.issue !== undefined ? `It comes from GitHub issue #${m.issue}: gh issue view ${m.issue} --comments.` : '',
      `How it runs: the office hands each of you your part of every round in a message like this one. Do just that part, write it to the file it names, and end your turn; the next round starts once every part of this one is written. Your working directory is ${this.cwd(m)}, and every file of the meeting is in it: the notes go in ${path.join(this.cwd(m), m.notes)}/, which is where you read what the others wrote. The meeting ends when ${m.output} (${path.join(this.cwd(m), m.output)}) is written, and only the part that says so writes it. It has ${m.rounds} round${m.rounds === 1 ? '' : 's'} at most and ${fmtTokens(m.budget)} tokens between all of you, so keep your notes short: bullets over prose.`,
      where + inside,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** A part, as the prompt that hands it over. */
  private ask(m: Meeting, part: Part): string {
    if (m.followup) return `Follow-up ${m.followup}, ${part.doing}. ${part.ask}`;
    return `Round ${m.round} of ${m.rounds}, ${part.doing}. ${part.ask}`;
  }

  /**
   * A follow-up's three steps: (1) the head of the table plans who does what, (2) the teammates it
   * named do their parts, (3) it writes the answer. Step 2 is empty when it answers on its own.
   * Null past the last step.
   */
  private followupPlan(m: Meeting, step: number): Part[] | null {
    const n = m.followup!;
    const f = m.followups![n - 1];
    const A = (rel: string) => path.join(this.cwd(m), rel);
    const planFile = `${m.notes}/f${n}-plan.md`;
    const answerFile = `${m.notes}/f${n}-answer.md`;
    const part = (i: number) => `${m.notes}/f${n}-${i + 1}-${slugify(m.seats[i].role, 24)}.md`;
    const others = m.seats.map((_, i) => i).filter((i) => i > 0);
    const earlier = (m.followups ?? []).slice(0, n - 1).map((x, i) => x.answer && `follow-up ${i + 1} (“${firstLine(x.text).slice(0, 80)}”): ${A(x.answer)}`).filter(Boolean);
    const context = `Everything from the meeting is in ${A(m.notes)}/ (each round's notes) and the decision in ${A(m.output)}${earlier.length ? `; earlier follow-ups' answers: ${earlier.join('; ')}` : ''}.`;
    if (step === 1) {
      return [{
        seat: 0,
        doing: 'planning',
        file: planFile,
        ask: `${f.by} has a follow-up for the table: “${f.text}”.${f.attachments?.length ? ` ${attachedNote(f.by, f.attachments)}` : ''} You lead this table, so it's yours to run. ${context} Decide who at the table should do what to answer it. Write the plan to ${A(planFile)}: a section for each teammate who has something to do, headed with their role exactly as \`## <role>\` (the table: ${list(m.seats.slice(1).map((s) => s.role))}), saying what you need from them. Leave out anyone with nothing to do. If you can answer it well yourself without them, write just ANSWER MYSELF. Then end your turn.`,
      }];
    }
    if (step === 2) {
      const helpers = this.helpersFor(m, planFile, others);
      return helpers.map((i) => ({
        seat: i,
        doing: 'doing their part',
        file: part(i),
        ask: `The follow-up question: “${f.text}”.${f.attachments?.length ? ` It came with files: ${f.attachments.join(', ')}. Open the ones your part needs with your Read tool.` : ''} The ${m.seats[0].role}'s plan is in ${A(planFile)}; your part is under \`## ${m.seats[i].role}\` (if there's no section for you, do what the plan asks of everyone). ${context} Do your part and write your result to ${A(part(i))}, short and to the point: bullets over prose. Then end your turn.`,
      }));
    }
    if (step === 3) {
      const helpers = this.helpersFor(m, planFile, others);
      return [{
        seat: 0,
        doing: 'answering',
        file: answerFile,
        ask: `${helpers.length ? `Your team's results are in: ${helpers.map((i) => A(part(i))).join(', ')}. Read them, then answer` : 'Answer'} the follow-up “${f.text}” in ${A(answerFile)}, in Markdown: the answer first, then what changed from the meeting's decision and why, then what's still open. Write it for ${f.by}, who asked: plain words, the key numbers. Then end your turn.`,
      }];
    }
    return null;
  }

  /**
   * Who the plan gives a part to: the seats with a `## <role>` section in it. None when the head of
   * the table answers on its own; everyone else when the plan names nobody it can be matched to.
   */
  private helpersFor(m: Meeting, planFile: string, others: number[]): number[] {
    let text = '';
    try {
      text = readStart(path.join(this.cwd(m), planFile), 60_000);
    } catch {
      return others;
    }
    if (/^\W*answer myself\W*$/im.test(text.trim().split('\n')[0] ?? '') && !/^##\s/m.test(text)) return [];
    const heads = [...text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((x) => x[1].toLowerCase().replace(/[*_`]/g, '').trim());
    const named = others.filter((i) => {
      const role = m.seats[i].role.toLowerCase();
      return heads.some((h) => h === role || h.startsWith(`${role} `) || h.startsWith(`${role}:`) || h.startsWith(`${role} (`) || h.includes(role));
    });
    return named.length ? named : others;
  }

  /** The parts of step `step` of round `round`, or null when that round has no such step. */
  private plan(m: Meeting, round: number, step: number): Part[] | null {
    if (m.followup) return this.followupPlan(m, step);
    // A conversation has no parts: it runs on runTalk.
    if (m.pattern === 'talk') return null;
    const n = m.seats.length;
    // Parts name their files by full path: a worktree sits inside the project's own folder, and an
    // agent can take a relative path to be the project's (and then it's asked about writing outside).
    const A = (rel: string) => path.join(this.cwd(m), rel);
    const note = (r: number, i: number) => `${m.notes}/r${r}-${i + 1}-${slugify(m.seats[i].role, 24)}.md`;
    const notes = (r: number, seats: number[]) => seats.map((i) => A(note(r, i))).join(', ');
    const all = m.seats.map((_, i) => i);
    const last = this.isLast(m, round);
    const out = `That file is the meeting's output.`;
    switch (m.pattern) {
      case 'debate': {
        if (step > 1) return null;
        if (last) {
          return [{ seat: 0, doing: 'writing the decision', file: m.output, ask: `Read every note in ${A(m.notes)}/ (the last round's are ${notes(round - 1, all)}). Weigh the proposals and critiques, and write the decision to ${A(m.output)}: what was decided and why, the options that lost and why, and what's still open. ${out}` }];
        }
        if (round === 1) return all.map((i) => ({ seat: i, doing: 'proposing', file: note(1, i), ask: `Propose your answer, from where you stand as the ${m.seats[i].role}: what you'd do, why, and what it costs. Write it to ${A(note(1, i))}, then end your turn.` }));
        return all.map((i) => ({
          seat: i,
          doing: 'critiquing',
          file: note(round, i),
          ask: `Read the others' notes from round ${round - 1}: ${notes(round - 1, all.filter((j) => j !== i))}. Say where they're wrong or miss something, then give your revised proposal. Write it to ${A(note(round, i))}, then end your turn.`,
        }));
      }
      case 'lead': {
        const team = all.slice(1);
        if (step > 1) return null;
        const plan = `${m.notes}/plan.md`;
        if (round === 1) {
          return [{ seat: 0, doing: 'planning', file: plan, ask: `Read the task and the code it touches, and split the work into ${team.length} part${team.length === 1 ? '' : 's'}, one each for ${list(team.map((i) => `the ${m.seats[i].role}`))}. Write the plan to ${A(plan)}: a section for each of them headed with their role (like "## ${m.seats[team[0]].role}"), saying what to do and which files they own, so that no two of them touch the same file. Don't make the changes yourself. Then end your turn.` }];
        }
        if (round === 2) {
          return team.map((i) => ({ seat: i, doing: 'doing their part', file: note(2, i), ask: `Read ${A(plan)} and do your part, the section headed "## ${m.seats[i].role}". Change only the files it gives you, and don't commit. When you're done, write what you did and what the ${m.seats[0].role} should know (what you couldn't do, how you checked it) to ${A(note(2, i))}, then end your turn.` }));
        }
        return [{ seat: 0, doing: 'merging the work', file: m.output, ask: `Read the team's reports (${notes(2, team)}) and look at their changes (git status, git diff). Fix whatever doesn't fit together and check that it works (build it, run the tests). Then write ${A(m.output)}: what was done, by whom, and how it was checked. ${out} Don't commit.` }];
      }
      case 'mapreduce': {
        if (step > 1) return null;
        const mappers = all.slice(1);
        if (round === 1) {
          return mappers.map((i, k) => {
            const mine = (m.parts ?? []).filter((_, j) => j % mappers.length === k);
            return { seat: i, doing: 'mapping', file: note(1, i), ask: `Do the task for your parts, and only those:\n${mine.map((x) => `- ${x}`).join('\n')}\nWrite what you found or did to ${A(note(1, i))}, a section per part, then end your turn.` };
          });
        }
        return [{ seat: 0, doing: 'reducing', file: m.output, ask: `Read the mappers' results (${notes(1, mappers)}) and combine them into ${A(m.output)}: one result that reads as a whole, not a pile of sections. ${out}` }];
      }
      case 'redblue': {
        const [blue, red] = [0, 1];
        const redNote = `${m.notes}/r${round}-red.md`;
        const blueNote = `${m.notes}/r${round}-blue.md`;
        if (step === 1) {
          const before = round > 1 ? ` The Blue team's fixes from round ${round - 1} are in ${A(`${m.notes}/r${round - 1}-blue.md`)}: check them first, then keep looking.` : '';
          return [{ seat: red, doing: 'attacking', file: redNote, ask: `Attack the change the meeting is about like an adversary would: bugs, security holes, unhandled edge cases, broken error handling. Read the code; don't change it.${before} List each finding in ${A(redNote)} with its file:line, what goes wrong and how to make it happen, the most serious first. If you find nothing worth fixing, write just NO FINDINGS. Then end your turn.` }];
        }
        if (step > 2) return null;
        if (m.lastRound === round) {
          return [{ seat: blue, doing: 'writing it up', file: m.output, ask: `The Red team found nothing more in ${A(redNote)}. Write ${A(m.output)}: every finding from every round (${A(m.notes)}/), what was fixed and how, and what's still open. ${out} Don't commit.` }];
        }
        const wrap = last ? ` This is the last round: once you've fixed things, also write ${A(m.output)}: every finding from every round (${A(m.notes)}/), what was fixed and how, and what's still open. ${out}` : '';
        return [{ seat: blue, doing: last ? 'fixing and writing it up' : 'fixing', file: last ? m.output : blueNote, ask: `Read the Red team's findings in ${A(redNote)} and fix each one that's real, in the checkout (don't commit). For each, say in ${A(blueNote)} what you did, or why it isn't a problem.${wrap} Then end your turn.` }];
      }
      case 'review': {
        if (step > 1) return null;
        if (round === 1) {
          return all.map((i) => ({
            seat: i,
            doing: 'reviewing',
            file: note(1, i),
            ask: `Review pull request #${m.pr} through your lens, ${m.seats[i].role}, and nothing else. Read it with gh pr view ${m.pr} and gh pr diff ${m.pr}; don't check it out or change any files. Write your findings to ${A(note(1, i))}, one per bullet: the file:line, what's wrong and what to do about it, the most serious first. If you find nothing, write just NO FINDINGS. Then end your turn.`,
          }));
        }
        return [{ seat: 0, doing: 'writing the review', file: m.output, ask: `Read every reviewer's findings (${notes(1, all)}). Drop the duplicates, keeping the clearest wording, and write one combined review to ${A(m.output)} in Markdown: a short summary with your verdict first, then the findings, the most serious first, each tagged with the lens it came from in bold brackets like **[${m.seats[1]?.role ?? 'Security'}]**, with its file:line. Don't post it: the office posts it on the pull request once the file is written. ${out}` }];
      }
    }
  }

  // --- Files -----------------------------------------------------------------

  private cwd(m: Meeting): string {
    return m.worktree ? path.join(this.dir, m.worktree.path) : this.dir;
  }

  /** Whether a part's file is there, with something in it, written since the part was handed over. */
  private written(m: Meeting, t: MeetingTurn): boolean {
    try {
      const st = statSync(path.join(this.cwd(m), t.file));
      return st.isFile() && st.size > 0 && st.mtimeMs >= (t.sentAt ?? 0) - 2000;
    } catch {
      return false;
    }
  }

  /** The first line of a notes file with something on it ('' when there's no such file). */
  private head(m: Meeting, file: string | undefined): string {
    if (!file) return '';
    try {
      return readStart(path.join(this.cwd(m), file), 400).split('\n').find((l) => l.trim()) ?? '';
    } catch {
      return '';
    }
  }

  /** Reads what's written of the output so far, for the board in the room. Returns whether it changed. */
  private readPreview(m: Meeting): boolean {
    let text: string | undefined;
    try {
      text = readStart(path.join(this.cwd(m), m.output), PREVIEW_CHARS * 2).slice(0, PREVIEW_CHARS);
    } catch {
      text = undefined;
    }
    if (text === m.preview) return false;
    m.preview = text;
    return true;
  }

  /**
   * Once a meeting is over: saves all of it (the question, the final write-up and every note) to the
   * floor's reports/meetings/, where it outlives the worktree and shows in 📊 Reports, then has Sonnet
   * write the recap for the board from what was said, and saves it again with the recap on top.
   */
  private wrapUp(m: Meeting) {
    const all = this.transcript(m);
    if (!all.output.trim() && !all.notes.length) return;
    m.saved = this.save(m, all) ?? m.saved;
    if (!this.events.recap) return;
    m.recapState = 'writing';
    this.changed();
    void this.events.recap(recapInput(m, all), m.pattern === 'talk' ? CLAUDE_MODEL_IDS.haiku : undefined).then((text) => {
      if (text) m.recap = text;
      m.recapState = text ? 'done' : 'failed';
      m.saved = this.save(m, all) ?? m.saved;
      // Archived meanwhile (the room was cleared, or another meeting called): the record gets it too.
      this.past = this.past.map((r) => (r.id === m.id ? meetingRecord(m) : r));
      if (text) this.events.toast(`📋 The recap of “${m.title}” is up on the meeting room's board`, 'info');
      this.changed();
    });
  }

  /** Everything written at the meeting, from its checkout, or from the copy kept with the floor's state. */
  private transcript(m: Meeting): Transcript {
    const kept = path.join(this.dataDir, 'meetings', m.id);
    const read = (file: string, max: number) => {
      try {
        return readStart(file, max);
      } catch {
        return '';
      }
    };
    const output = read(path.join(this.cwd(m), m.output), 200_000) || read(path.join(kept, `output-${path.basename(m.output)}`), 200_000);
    const byRole = new Map(m.seats.map((s, i) => [`${i + 1}-${slugify(s.role, 24)}`, s.role]));
    const notes: Transcript['notes'] = [];
    for (const dir of [path.join(this.cwd(m), m.notes), kept]) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('output-'));
      } catch {
        continue;
      }
      if (!files.length) continue;
      files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const f of files) {
        const r = /^r(\d+)-(\d+-.+)\.md$/.exec(f);
        const fu = /^f(\d+)-(plan|answer|\d+-.+)\.md$/.exec(f);
        const label = r
          ? `Round ${r[1]} · ${byRole.get(r[2]) ?? r[2].replace(/^\d+-/, '')}`
          : fu
            ? `Follow-up ${fu[1]} · ${fu[2] === 'plan' ? `the ${m.seats[0]?.role ?? 'lead'}'s plan` : fu[2] === 'answer' ? `the ${m.seats[0]?.role ?? 'lead'}'s answer` : (byRole.get(fu[2]) ?? fu[2].replace(/^\d+-/, ''))}`
            : f.replace(/\.md$/, '');
        const text = read(path.join(dir, f), 40_000).trim();
        if (text) notes.push({ label, text });
      }
      break;
    }
    return { output, notes };
  }

  /** Writes the whole meeting to reports/meetings/ on the floor. Returns its path there, or undefined. */
  private save(m: Meeting, all: Transcript): string | undefined {
    try {
      const at = new Date(m.finishedAt ?? Date.now());
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const rel = m.saved ?? `${MEETINGS_SAVED_DIR}/${day}-${slugify(m.title, 40)}-${m.id.slice(0, 4)}.md`;
      const p = MEETING_PATTERNS[m.pattern];
      const who = m.seats.map((s) => {
        const member = s.member ? TEAM_BY_ID.get(s.member) : undefined;
        return member ? `${s.role} (${member.emoji} ${member.name})` : s.role;
      });
      const recap = m.recap ?? (m.recapState === 'writing' ? '_Sonnet is writing the recap…_' : '_No recap: read the final write-up below._');
      const text = [
        `# 🤝 ${m.title}`,
        '',
        `${p.icon} ${p.label} meeting · ${at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} · called by ${m.calledBy} · ${m.status === 'done' ? '✅ done' : `⛔ stopped: ${m.reason ?? 'stopped'}`}`,
        '',
        `**At the table:** ${list(who)}`,
        '',
        '## 📋 Recap',
        '',
        recap,
        '',
        '## ❓ The question',
        '',
        m.prompt,
        '',
        ...(m.followups?.length ? ['## ↪️ Follow-ups', '', ...m.followups.map((f, i) => `${i + 1}. ${f.text.replace(/\n+/g, ' ')} _(${f.by}${f.status === 'stopped' ? `, stopped: ${f.reason ?? 'stopped'}` : f.status === 'running' ? ', being answered' : ''})_`), ''] : []),
        `## 📄 Final write-up (${m.output})`,
        '',
        all.output.trim() || '_Nothing was written._',
        '',
        '## 💬 What each agent said, round by round',
        '',
        ...all.notes.flatMap((n) => [`### ${n.label}`, '', n.text, '']),
      ].join('\n');
      const file = path.join(this.dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      this.excludeFromGit();
      return rel;
    } catch {
      return undefined;
    }
  }

  /** A saved meeting isn't work to commit: keep reports/meetings/ out of git status in a git checkout. */
  private excludeFromGit() {
    try {
      const info = path.join(this.dir, '.git', 'info');
      if (!existsSync(info) || !statSync(info).isDirectory()) return;
      const file = path.join(info, 'exclude');
      const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!now.split(/\r?\n/).includes(`/${MEETINGS_SAVED_DIR}/`)) appendFileSync(file, `${now && !now.endsWith('\n') ? '\n' : ''}/${MEETINGS_SAVED_DIR}/\n`);
    } catch {
      // only tidiness
    }
  }

  /** Copies the meeting's notes and output next to the floor's other state, where they outlive its worktree. */
  private keepNotes(m: Meeting) {
    try {
      const to = path.join(this.dataDir, 'meetings', m.id);
      const from = path.join(this.cwd(m), m.notes);
      if (path.resolve(from) !== path.resolve(to) && existsSync(from)) cpSync(from, to, { recursive: true });
      const out = path.join(this.cwd(m), m.output);
      if (existsSync(out)) cpSync(out, path.join(to, `output-${path.basename(m.output)}`));
    } catch {
      // the notes are a courtesy; the meeting is over either way
    }
  }

  private changed() {
    this.dirty = false;
    this.persist();
    this.events.update(this.state());
  }

  private persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify({ current: this.current, past: this.past }, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<MeetingState>;
      if (Array.isArray(saved.past)) this.past = saved.past.filter((r) => r && typeof r.id === 'string' && typeof r.summary === 'string').slice(0, PAST_MAX);
      const m = saved.current;
      // The workers at the table outlive a restart of the office, so a meeting carries on where it was.
      if (m && typeof m.id === 'string' && isMeetingPattern(m.pattern) && Array.isArray(m.seats) && Array.isArray(m.turns)) this.current = m;
    } catch {
      // corrupt state file: an empty room
    }
  }
}

/**
 * Commits everything in a checkout but `leaveOut` (the notes); resolves to the commit's short hash, or
 * undefined when there was nothing to commit.
 */
async function commitAll(cwd: string, message: string, leaveOut: string): Promise<string | undefined> {
  const git = async (args: string[]) => (await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 60_000 })).stdout.trim();
  await git(['add', '-A', '--', '.', `:(exclude)${leaveOut}`]);
  if (!(await git(['diff', '--cached', '--name-only']))) return undefined;
  await git(['commit', '-q', '-m', message]);
  return git(['rev-parse', '--short', 'HEAD']);
}

/** The start of a file, at most `bytes` of it. */
function readStart(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } finally {
    closeSync(fd);
  }
}

/** Roles that repeat get numbered, so each worker at the table has one of its own: Engineer 1, Engineer 2. */
function numbered(roles: string[]): string[] {
  const seen = new Map<string, number>();
  const count = new Map<string, number>();
  for (const r of roles) count.set(r.toLowerCase(), (count.get(r.toLowerCase()) ?? 0) + 1);
  return roles.map((r) => {
    const key = r.toLowerCase();
    if ((count.get(key) ?? 0) < 2) return r;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return `${r} ${n}`;
  });
}

/** "a", "a and b", "a, b and c". */
function list(xs: string[]): string {
  return xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** What Sonnet reads to write a meeting's recap: the question, who sat where, the write-up and every note. */
function recapInput(m: Meeting, all: Transcript): string {
  const text = [
    `The question: ${m.prompt}`,
    ...(m.followups ?? []).map((f, i) => `Follow-up question ${i + 1} (asked after the meeting; the latest matters most): ${f.text}`),
    `At the table: ${m.seats.map((s, i) => `${i === 0 ? 'head of the table: ' : ''}${s.role}${s.member && TEAM_BY_ID.get(s.member) ? ` (${TEAM_BY_ID.get(s.member)!.name})` : ''}`).join('; ')}`,
    m.status === 'done' ? '' : `The meeting stopped early: ${m.reason ?? 'stopped'}`,
    `## The final write-up\n${all.output.trim() || '(none was written)'}`,
    ...all.notes.map((n) => `## ${n.label}\n${n.text}`),
  ].filter(Boolean).join('\n\n');
  return text.length > RECAP_INPUT_MAX ? `${text.slice(0, RECAP_INPUT_MAX)}\n\n(cut short here)` : text;
}

/** The lines that tell everyone at the table about the files that came with the question. */
function attachedNote(by: string, paths: string[]): string {
  const one = paths.length === 1;
  return `📎 ${by.replace(/\s*📱\s*$/u, '')} attached ${one ? 'a file' : `${paths.length} files`} (screenshots or PDFs) for this. Open ${one ? 'it' : 'each one'} with your Read tool before you start: ${one ? 'it is' : 'they are'} part of the question.\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

/** A short id for a line of a conversation. */
function msgId(): string {
  return randomBytes(4).toString('hex');
}
