import { MEETING_PATTERNS, MEETING_PATTERN_IDS, TOKENS_PER_SEAT, meetingSpend, outputProblem, slugify } from '../../shared/meetings';
import { MEETING_SEATS } from '../../shared/layout';
/** The 3D room seats as many as its table has chairs; the app can seat a bigger table. */
const maxSeats = (d: { seats: { max: number } }) => Math.min(d.seats.max, MEETING_SEATS.length);
import { fmtTokens, type Meeting, type MeetingMessage, type MeetingPattern, type MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { meetingStage, messageCount, saidBy, seatColor, seatEmoji, seatName, thinkingSeats } from '../world/meeting';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { confirmDialog } from './prompt';
import { markdown } from './markdown';
import { attachments as attachBox } from '../attach';
import { openMinutes } from './minutes';
import { CLAUDE_MODEL_LABEL, providerPicker } from './provider';
import { CREWS, DEPARTMENTS, DEPARTMENT_ICON, TEAM, TEAM_BY_ID } from '../../shared/team';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
}

/** A meeting about a GitHub issue: the form filled in with it. */
export function issueMeeting(n: number, title: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: `GitHub issue #${n}: “${title}”. Read it first with gh issue view ${n} --comments.` };
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: '⏳ up next', sent: '📨 handed over', working: '💬 on it', done: '✅ written' };

/**
 * The meeting room's window. With a meeting at the table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🤝 Meeting room');
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.meeting-window', { role: 'dialog', 'aria-label': 'Meeting room' }, h('header', {}, title, close), body, foot);
  let view: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  /** A conversation's window stays put between updates, so what you're typing isn't lost. */
  let talk: ReturnType<typeof talkView> | null = null;
  const callAnother = () => {
    view = 'form';
    render();
  };
  const render = () => {
    const m = store.meeting.current;
    if (view === 'status' && m?.pattern === 'talk') {
      form = null;
      if (talk?.id !== m.id) {
        talk = talkView(m, net, actions, callAnother);
        body.replaceChildren(talk.body);
      }
      title.textContent = '💬 Meeting room';
      el.classList.add('talk-window');
      talk.update(m, foot);
      return;
    }
    talk = null;
    el.classList.remove('talk-window');
    if (view === 'status' && m) {
      form = null;
      title.textContent = '🤝 Meeting room';
      renderStatus(m, body, foot, net, actions, callAnother);
      return;
    }
    if (!form) {
      form = meetingForm(net, preset, () => modal.close(), () => {
        view = 'status';
        render();
      });
      title.textContent = '🤝 Call a meeting';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, { doing: '🤝 at the meeting room', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in a meeting' : m.status);
  const f = Math.min(1, m.tokens / Math.max(1, m.budget));
  const seats = h(
    'ul.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${t.doing}` : '👂 listening') : '';
      return h(
        'li',
        {},
        h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
        h('b', {}, s.role),
        s.member && TEAM_BY_ID.get(s.member) ? h('small', {}, ` · ${TEAM_BY_ID.get(s.member)!.emoji} ${TEAM_BY_ID.get(s.member)!.name}`) : h('small.bad', {}, ' · no teammate picked'),
        h('span.muted', {}, `${i === 0 ? 'head of the table · ' : ''}${s.workerName ?? '…'}`),
        w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
        part ? h('span.meeting-part', { title: t?.file ?? '' }, part) : null,
        s.tokens ? h('span.muted', {}, `${fmtTokens(s.tokens)} tokens`) : null,
        w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
      );
    }),
  );
  const where = m.worktree ? h('span', {}, '🌿 ', h('code', {}, m.worktree.branch), m.commit ? ` · committed ${m.commit}` : '') : null;
  const review = m.review?.url ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `🔍 The review on PR #${m.pr} ↗`) : m.review?.error ? h('span.bad', {}, `Couldn't post the review: ${m.review.error}`) : null;
  const recap = recapBox(m);
  body.replaceChildren(
    ...present(
    h('div.meeting-head', {}, pill, h('b', {}, `${p.icon} ${p.label}`), h('span.meeting-title', { title: m.prompt }, m.title)),
    h('p.meeting-line', {}, running ? `${meetingStage(m)} · called by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}` : m.status === 'done' ? `✅ Wrote ${m.output} in ${m.round} round${m.round === 1 ? '' : 's'}` : `⛔ Stopped in round ${m.round}: ${m.reason ?? 'stopped'}`),
    h('div.meeting-budget', { title: `${m.tokens.toLocaleString()} of ${m.budget.toLocaleString()} tokens` }, h('div.meeting-bar', {}, h('i', { style: `width:${(f * 100).toFixed(1)}%;background:${f > 0.9 ? 'var(--bad)' : f > 0.7 ? 'var(--warn)' : 'var(--good)'}` })), h('span', {}, `${meetingSpend(m)} of ${fmtTokens(m.budget)} tokens`)),
    recap,
    seats,
    h('div.meeting-out', {}, h('div.meeting-out-head', {}, h('b', {}, '📄 '), h('code', {}, m.output), where, review), h('pre.meeting-preview', {}, m.preview?.trim() ? m.preview : running ? 'Nothing written yet.' : 'Nothing was written.')),
    followups(m),
    !running && !m.cleared ? followBox(m, net) : null,
    pastMeetings(),
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
    h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : m.saved ? `Clearing the room sends the workers home. The whole meeting stays saved in ${m.saved} (📊 Reports).` : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
    running ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Stop the meeting?', `The workers stop where they are and stay at the table. ${m.output} is only there if it was written.`, 'Stop it', () => net.send({ t: 'meeting.stop' })) }, '⛔ Stop meeting') : null,
    !running && m.commit && head?.worktree && store.project?.remote ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a pull request`, onclick: () => actions.openPr(head.id) }, head.pr ? `🔀 PR #${head.pr.number}` : '🔀 Open PR') : null,
    !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, '🧹 Clear the room') : null,
    !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 Call a meeting…') : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** Once a meeting is over: its recap (or that it's being written), and the way to read all of it. */
function recapBox(m: Meeting): HTMLElement | null {
  const running = m.status === 'running';
  // A conversation's recap is Haiku's, like its memory; the structured patterns get Sonnet's.
  const by = m.pattern === 'talk' ? 'Haiku' : 'Sonnet';
  const readAll = m.saved && !running ? h('button.btn.small', { type: 'button', onclick: () => void openMinutes(m.saved!) }, '📖 Read the whole meeting') : null;
  if (m.recap && !running) return h('div.meeting-recap', {}, h('div.meeting-recap-head', {}, h('b', {}, '📋 Recap'), h('small.muted', {}, `by ${by}, from everything said at the table`), readAll), markdown(m.recap));
  if (m.recapState === 'writing') return h('div.meeting-recap.wait', {}, h('div.meeting-recap-head', {}, h('b', {}, `✍️ ${by} is writing the recap…`), readAll), h('small.muted', {}, 'It reads everything said at the table and puts a short recap up on the board.'));
  return readAll ? h('div.meeting-recap-head', {}, readAll) : null;
}

/** The floor's earlier meetings, folded away, each with its recap's first line. */
function pastMeetings(): HTMLElement | null {
  if (!store.meeting.past.length) return null;
  return h('details.meeting-past', {}, h('summary', {}, `Earlier meetings (${store.meeting.past.length})`), h('ul', {}, ...store.meeting.past.map((r) => h('li', { title: `Called by ${r.calledBy}` }, h('b', {}, r.title), r.saved ? h('button.btn.small', { type: 'button', style: 'margin-left:8px', onclick: () => void openMinutes(r.saved!) }, '📖 Read') : null, h('div.muted', {}, r.recap ? r.recap.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? r.summary : r.summary)))));
}

const meetingTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * A conversation meeting's window: the thread down the left with a composer under it (to everyone,
 * or the seats you tick), and down the right who's at the table and what the table knows (Haiku's
 * shared memory). Built once and updated in place, so a half-typed message survives every update.
 */
function talkView(first: Meeting, net: Net, actions: MeetingActions, callAnother: () => void) {
  let m = first;
  /** Who the next message is for; empty means everyone. */
  const to = new Set<number>();
  /** Scroll to the newest line on the next update: you just sent something, or the window just opened. */
  let stick = true;
  let sending = false;

  const head = h('div.meeting-head');
  const line = h('p.meeting-line');
  const budget = h('div.meeting-budget');
  const recapSlot = h('div.talk-recap');
  const thread = h('div.talk-thread', { role: 'log', 'aria-label': 'The conversation', 'aria-live': 'polite' });
  const toRow = h('div.talk-to', { role: 'group', 'aria-label': 'Who it is for' });
  const input = h('textarea.talk-input', { rows: 2, 'aria-label': 'Your message', placeholder: '' }) as HTMLTextAreaElement;
  const files = attachBox(input);
  const sendBtn = h('button.btn.primary.talk-send', { type: 'button' }, '💬 Send') as HTMLButtonElement;
  const composerNote = h('small.muted.talk-note');
  const composer = h('div.talk-composer', {}, composerNote, toRow, input, h('div.talk-actions', {}, files.element, sendBtn));
  const cleared = h('p.talk-cleared.muted', {}, 'This conversation was cleared away: call a new meeting to talk again.');
  const seats = h('ul.talk-seats');
  const memoryState = h('small.talk-memory-state');
  const memory = h('div.talk-memory-body');
  const past = h('div.talk-past');
  const body = h(
    'div.talk',
    {},
    head,
    h('div.talk-sub', {}, line, budget),
    recapSlot,
    h(
      'div.talk-main',
      {},
      h('section.talk-chat', {}, thread, composer, cleared),
      h(
        'aside.talk-side',
        {},
        h('div.talk-box', {}, h('b.talk-box-title', {}, '🪑 At the table'), seats),
        h('div.talk-box.talk-memory', {}, h('div.talk-box-head', {}, h('b.talk-box-title', {}, '🧠 What the table knows'), memoryState), memory),
      ),
    ),
    past,
  );

  // Typing here mustn't walk you round the office or set off its keys; Enter sends, Shift+Enter is a new line.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener('click', () => void send());

  const send = async () => {
    if (sending || m.cleared) return;
    const text = input.value.trim();
    if (!text) return input.focus();
    let attached: string[] | undefined;
    if (files.count()) {
      sending = true;
      sendBtn.disabled = true;
      try {
        toast(`📎 Uploading ${files.count() === 1 ? 'the file' : `${files.count()} files`}…`);
        attached = await files.upload();
      } catch (err) {
        toast(`Couldn't upload: ${(err as Error).message}`, 'error');
        return;
      } finally {
        sending = false;
        sendBtn.disabled = false;
      }
    }
    // Every seat ticked is the same as everyone: the server then tells each of them it went to the whole table.
    const picked = [...to].filter((i) => i < m.seats.length).sort((a, b) => a - b);
    net.send({ t: 'meeting.say', text, to: picked.length && picked.length < m.seats.length ? picked : undefined, attachments: attached });
    if (m.status !== 'running') toast('💬 Opening the conversation again: anyone who went home sits back down');
    input.value = '';
    files.clear();
    stick = true;
    input.focus();
  };

  /** Points the next message at one seat only (from a reply's ↩, or a seat's name on the right). */
  const replyTo = (i: number) => {
    to.clear();
    to.add(i);
    renderTo();
    input.focus();
  };

  const renderTo = () => {
    const everyone = to.size === 0;
    const names = [...to].sort((a, b) => a - b).map((i) => seatName(m, i));
    toRow.replaceChildren(
      h('span.talk-to-label', {}, 'To'),
      h('button.talk-chip', { type: 'button', class: everyone ? 'on' : '', 'aria-pressed': String(everyone), onclick: () => (to.clear(), renderTo()) }, '👥 Everyone'),
      ...m.seats.map((_, i) =>
        h(
          'button.talk-chip',
          {
            type: 'button',
            class: to.has(i) ? 'on' : '',
            'aria-pressed': String(to.has(i)),
            style: `--seat:${seatColor(m, i)}`,
            title: `Only ${seatName(m, i)} answers (tick more to add them)`,
            onclick: () => {
              if (to.has(i)) to.delete(i);
              else to.add(i);
              if (to.size >= m.seats.length) to.clear();
              renderTo();
            },
          },
          h('i.talk-dot'),
          `${seatEmoji(m, i)} ${seatName(m, i)}`,
        ),
      ),
    );
    const running = m.status === 'running';
    sendBtn.textContent = `${running ? '💬 Send' : '💬 Keep talking'}${everyone ? (m.seats.length > 1 ? ' to everyone' : '') : ` to ${andList(names)}`}`;
    input.placeholder = everyone ? `Say something to ${m.seats.length > 1 ? 'everyone at the table' : seatName(m, 0)}… (Enter sends, Shift+Enter for a new line)` : `Say something to ${andList(names)}… (the others still see it in the shared memory)`;
  };

  /** One line of the thread: yours (or a colleague's) on the right, a seat's on the left in its colour. */
  const message = (msg: MeetingMessage, lastAsk: string | undefined): HTMLElement => {
    if (msg.system) return h('div.talk-sys', {}, `ℹ️ ${msg.text}`);
    const files = msg.attachments?.length ? h('div.talk-files', {}, ...msg.attachments.map((p) => h('span.talk-file', { title: p }, `📎 ${fileName(p)}`))) : null;
    if (msg.from === 'you') {
      const toWho = msg.to?.length
        ? msg.to.map((i) => h('span.talk-to-name', { style: `--seat:${seatColor(m, i)}` }, seatName(m, i)))
        : [h('span.talk-to-name.all', {}, 'everyone')];
      return h('div.talk-msg.you', {}, h('div.talk-msg-head', {}, h('b', {}, saidBy(m, msg)), h('span.talk-arrow', {}, '→'), ...toWho, h('time', {}, meetingTime(msg.at))), h('div.talk-bubble', {}, markdown(msg.text)), files);
    }
    const i = msg.from;
    const s = m.seats[i];
    const name = seatName(m, i);
    const ask = msg.re && msg.re !== lastAsk ? m.thread?.find((x) => x.id === msg.re) : undefined;
    return h(
      'div.talk-msg.seat',
      { style: `--seat:${seatColor(m, i)}` },
      h(
        'div.talk-msg-head',
        {},
        h('i.talk-dot'),
        h('b', {}, `${seatEmoji(m, i)} ${name}`),
        s && s.role !== name ? h('small.muted', {}, s.role) : null,
        h('time', {}, meetingTime(msg.at)),
        m.cleared ? null : h('button.talk-reply', { type: 'button', title: `Say something to ${name} only`, onclick: () => replyTo(i) }, '↩ Reply'),
      ),
      ask ? h('div.talk-re', {}, `↪ answering ${saidBy(m, ask)}: “${ask.text.slice(0, 90)}${ask.text.length > 90 ? '…' : ''}”`) : null,
      h('div.talk-bubble', {}, markdown(msg.text)),
      files,
    );
  };

  /** A seat that owes a reply: thinking, reading it, or with it queued behind another one. */
  const pending = (i: number): HTMLElement => {
    const owed = (m.replying ?? []).filter((r) => r.seat === i);
    const r = owed.find((x) => x.state !== 'waiting') ?? owed[0];
    const what = r?.state === 'working' ? 'thinking' : r?.state === 'sent' ? 'reading it' : 'answers next';
    return h(
      'div.talk-msg.seat.thinking',
      { style: `--seat:${seatColor(m, i)}` },
      h('div.talk-msg-head', {}, h('i.talk-dot'), h('b', {}, `${seatEmoji(m, i)} ${seatName(m, i)}`), owed.length > 1 ? h('small.muted', {}, `${owed.length} to answer`) : null),
      h('div.talk-bubble', {}, h('span.talk-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), ` …${what}`),
    );
  };

  let threadKey = '';
  const renderThread = () => {
    const msgs = m.thread ?? [];
    const thinking = m.status === 'running' ? thinkingSeats(m) : [];
    const key = JSON.stringify([msgs.length, msgs.at(-1)?.id, m.replying?.map((r) => `${r.seat}${r.state}`), m.status, m.cleared, m.seats.map((_, i) => seatColor(m, i))]);
    if (key === threadKey) return;
    threadKey = key;
    // Follow the conversation down only if you were reading its end already: scrolled up, you stay put.
    const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
    let lastAsk: string | undefined;
    const nodes: HTMLElement[] = [];
    for (const msg of msgs) {
      nodes.push(message(msg, lastAsk));
      if (msg.from === 'you' && !msg.system) lastAsk = msg.id;
    }
    if (!msgs.length) nodes.push(h('div.talk-sys', {}, 'Nothing said yet.'));
    nodes.push(...thinking.map(pending));
    if (m.status === 'running' && !thinking.length && msgs.length) nodes.push(h('div.talk-sys.turn', {}, '👂 Everyone has answered: your turn.'));
    thread.replaceChildren(...nodes);
    if (atEnd || stick) {
      thread.scrollTop = thread.scrollHeight;
      // Again once it has laid out (markdown can grow a line or two).
      requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
    }
    stick = false;
  };

  const renderSeats = () => {
    const thinking = new Set(m.status === 'running' ? thinkingSeats(m) : []);
    seats.replaceChildren(
      ...m.seats.map((s, i) => {
        const w = s.workerId ? store.workers.get(s.workerId) : undefined;
        const state = !w || w.status === 'exited' ? '🏠 gone home' : thinking.has(i) ? '💭 thinking' : m.status === 'running' ? '👂 listening' : `${STATUS_LABEL[w.status]}`;
        return h(
          'li',
          { style: `--seat:${seatColor(m, i)}` },
          h('i.talk-dot'),
          h('button.talk-seat-name', { type: 'button', title: m.cleared ? s.role : `Say something to ${seatName(m, i)} only`, disabled: m.cleared, onclick: () => replyTo(i) }, `${seatEmoji(m, i)} ${seatName(m, i)}`),
          h('small.muted', {}, `${i === 0 ? 'host · ' : ''}${state}${s.tokens ? ` · ${fmtTokens(s.tokens)}` : ''}`),
          w ? h('button.btn.small', { type: 'button', title: `${w.name}'s terminal`, onclick: () => actions.openTerminal(w.id) }, '🖥️') : null,
        );
      }),
    );
  };

  let memoryKey = '';
  const renderMemory = () => {
    memoryState.textContent = m.memoryState === 'writing' ? '✍️ Haiku is updating…' : m.memoryState === 'failed' ? '⚠️ Haiku couldn’t update it: this is the last version' : 'kept by Haiku';
    memoryState.classList.toggle('writing', m.memoryState === 'writing');
    const key = m.memory ?? '';
    if (key === memoryKey && memory.childNodes.length) return;
    memoryKey = key;
    memory.replaceChildren(m.memory?.trim() ? markdown(m.memory) : h('p.muted', {}, 'Nothing yet: after each exchange Haiku writes down where things stand, so whoever you talk to next is caught up.'));
  };

  const update = (next: Meeting, foot: HTMLElement) => {
    m = next;
    const running = m.status === 'running';
    // Once it's over the recap sits above the thread, so the thread gets shorter to keep Keep talking in view.
    body.classList.toggle('over', !running);
    const said = messageCount(m);
    const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in conversation' : m.status === 'done' ? 'over' : 'ended');
    head.replaceChildren(pill, h('b', {}, '💬 Conversation'), h('span.meeting-title', { title: m.prompt }, m.title));
    line.textContent = running
      ? `${meetingStage(m)} · started by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}`
      : m.status === 'done'
        ? `✅ Over after ${said} message${said === 1 ? '' : 's'}: written up in ${m.output}`
        : `⛔ Ended after ${said} message${said === 1 ? '' : 's'}: ${m.reason ?? 'stopped'}`;
    const f = Math.min(1, m.tokens / Math.max(1, m.budget));
    budget.title = `${m.tokens.toLocaleString()} of ${m.budget.toLocaleString()} tokens`;
    budget.replaceChildren(h('div.meeting-bar', {}, h('i', { style: `width:${(f * 100).toFixed(1)}%;background:${f > 0.9 ? 'var(--bad)' : f > 0.7 ? 'var(--warn)' : 'var(--good)'}` })), h('span', {}, meetingSpend(m).replace(' tokens', ` of ${fmtTokens(m.budget)} tokens`)));
    const recap = recapBox(m);
    recapSlot.replaceChildren(...present(recap));
    composer.classList.toggle('hidden', !!m.cleared);
    cleared.classList.toggle('hidden', !m.cleared);
    composerNote.textContent = running ? '' : 'Keep talking: it opens the conversation again, and anyone who went home sits back down, caught up from the shared memory.';
    composerNote.classList.toggle('hidden', running);
    for (const i of [...to]) if (i >= m.seats.length) to.delete(i);
    renderTo();
    renderThread();
    renderSeats();
    renderMemory();
    past.replaceChildren(...present(running ? null : pastMeetings()));

    const lead = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
    foot.replaceChildren(
      ...present(
        h('span.grow', {}, running ? 'Everyone at the table reads the shared memory before they answer, so whoever you talk to is caught up.' : m.cleared ? 'The room is clear.' : m.saved ? `The whole conversation is saved in ${m.saved} (📊 Reports). Clearing the room sends the teammates home.` : 'Clearing the room sends the teammates home.'),
        running
          ? h(
              'button.btn',
              {
                type: 'button',
                onclick: () =>
                  confirmDialog(
                    'End the conversation?',
                    `Anyone still answering stops where they are. The conversation is written up in ${m.output} and Haiku writes a recap for the board. The teammates stay at the table, so you can keep talking later.`,
                    'End it',
                    () => net.send({ t: 'meeting.stop' }),
                  ),
              },
              '⏹️ End meeting',
            )
          : null,
        !running && m.commit && lead?.worktree && store.project?.remote ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a pull request`, onclick: () => actions.openPr(lead.id) }, lead.pr ? `🔀 PR #${lead.pr.number}` : '🔀 Open PR') : null,
        !running && !m.cleared ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, '🧹 Clear the room') : null,
        !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 Call a meeting…') : null,
      ),
    );
  };

  setTimeout(() => input.focus(), 0);
  return { id: first.id, body, update };
}

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the bounds. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, done: () => void, back: () => void) {
  // A conversation is the everyday meeting: you talk, the table answers. The structured patterns are a click away.
  let pattern: MeetingPattern = preset?.pattern ?? 'talk';
  let roles: string[] = [];
  /** Who sits in each chair: a roster teammate's id, or '' for a helper. Only these start. */
  let members: string[] = [];
  let outputTouched = false;
  let budgetTouched = false;
  const patterns = h('div.meeting-patterns', { role: 'radiogroup', 'aria-label': 'Pattern' });
  const about = h('textarea', { rows: 4, 'aria-label': 'What the meeting is about' }) as HTMLTextAreaElement;
  const aboutLabel = h('label');
  about.value = preset?.prompt ?? '';
  // Screenshots and PDFs for the table (or paste one into the box).
  const files = attachBox(about);
  const titleIn = h('input', { type: 'text', placeholder: 'Title (optional): the first line otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input', { type: 'text', 'aria-label': 'Output file', spellcheck: 'false' }) as HTMLInputElement;
  const outputNote = h('small.muted');
  const prSel = h('select.provider-select', { 'aria-label': 'Pull request' }) as HTMLSelectElement;
  const prRow = h('div.meeting-field', {}, h('label', {}, 'Pull request'), prSel);
  const partsIn = h('textarea', { rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'Parts', spellcheck: 'false' }) as HTMLTextAreaElement;
  const partsRow = h('div.meeting-field', {}, h('label', {}, 'Parts, one per line'), partsIn, h('small.muted', {}, 'Handed out to the mappers in turn: files, folders, modules or issues.'));
  const count = h('b');
  const minus = h('button.btn.small', { type: 'button', 'aria-label': 'Fewer workers' }, '−');
  const plus = h('button.btn.small', { type: 'button', 'aria-label': 'More workers' }, '+');
  const roleList = h('div.meeting-roles');
  // Seat a crew at the table in one go: its first members take the chairs, as many as the pattern seats.
  const crewFill = h('select.provider-select', { 'aria-label': 'Fill the table from a crew' }) as HTMLSelectElement;
  crewFill.append(
    h('option', { value: '' }, '👥 Fill the table from…'),
    h('option', { value: '@awake' }, '🟢 Teammates awake on this floor'),
    ...CREWS.map((c) => h('option', { value: c.id }, `${c.emoji} ${c.name} (${c.members.length})`)),
  );
  /** Who's coming, spelled out, with a warning for any chair nobody was picked for. */
  const whoSummary = h('p.meeting-who-summary');
  const whoNote = h('small.muted', {}, 'The words on the left are each chair\'s job in the meeting; the picker on the right is WHO sits there. Only the people at the table start, and each teammate brings their own model and brief (unless you pick a model for everyone below).');
  const roundsIn = h('input', { type: 'number', 'aria-label': 'Rounds' }) as HTMLInputElement;
  const roundsNote = h('small.muted');
  const roundsRow = h('div.meeting-field', {}, h('label', {}, 'Round limit'), roundsIn, roundsNote);
  const outputRow = h('div.meeting-field', {}, h('label', {}, 'Output file'), outputIn, outputNote);
  const footNote = h('span.grow');
  const budgetIn = h('input', { type: 'number', min: 50, step: 250, 'aria-label': 'Token budget in thousands' }) as HTMLInputElement;
  const provider = providerPicker(store.project, 'meeting-provider', 'Meeting provider', 'meeting');
  const busy = h('p.meeting-busy');
  const submit = h('button.btn.primary', { type: 'submit' }, '🤝 Start the meeting');
  const cancel = h('button.btn', { type: 'button', onclick: store.meeting.current ? back : done }, store.meeting.current ? '← Back' : 'Cancel');

  const def = () => MEETING_PATTERNS[pattern];
  /** A new chair's job: in a conversation none, so it goes by the teammate's name; otherwise the pattern's part for it. */
  const defaultRole = (i: number) => (pattern === 'talk' ? '' : (def().roles[i] ?? `Worker ${i + 1}`));
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem ? `⚠️ ${problem}` : pattern === 'review' ? 'It ends when this file is written; the office then posts it on the PR as one review.' : store.project?.branch ? 'It ends when this file is written; the office commits it on the meeting’s own branch.' : 'It ends when this file is written.';
    outputNote.classList.toggle('bad', !!problem);
  };
  const syncBudget = () => {
    if (!budgetTouched) budgetIn.value = String((roles.length * TOKENS_PER_SEAT) / 1000);
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = String(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= maxSeats(d));
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input.meeting-job', { type: 'text', value: r, maxlength: 40, placeholder: 'their job at the table (optional)', title: 'The part this chair plays in the meeting, like Chair or Devil’s advocate. Not the person: pick the person above.', 'aria-label': `Chair ${i + 1}'s job at the table` }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        const who = h('select.provider-select.meeting-who', { 'aria-label': `Who sits in chair ${i + 1}` }) as HTMLSelectElement;
        who.append(h('option', { value: '' }, '🎲 A helper'));
        for (const dept of DEPARTMENTS) {
          const og = h('optgroup', { label: `${DEPARTMENT_ICON[dept]} ${dept}` });
          for (const m of TEAM.filter((t) => t.group === dept)) og.append(h('option', { value: m.id }, `${m.emoji} ${m.name} · ${CLAUDE_MODEL_LABEL[m.model]}`));
          who.append(og);
        }
        who.value = members[i] ?? '';
        who.addEventListener('change', () => {
          members[i] = who.value;
          renderWho();
        });
        return h('div.meeting-role', {}, h('span.muted', {}, i === 0 ? '👑' : `${i + 1}`), h('div.meeting-seat', {}, h('small.meeting-seat-label', {}, i === 0 ? 'Who leads' : 'Who'), who, input));
      }),
    );
    syncBudget();
    renderWho();
  };
  const renderWho = () => {
    const names = roles.map((_, i) => TEAM_BY_ID.get(members[i] ?? '')?.name);
    const helpers = names.filter((n) => !n).length;
    const picked = names.filter(Boolean) as string[];
    whoSummary.replaceChildren(
      picked.length ? h('span', {}, '✅ Coming: ', h('b', {}, picked.join(', '))) : h('span', {}, 'Nobody picked yet.'),
      ...(helpers ? [h('span.bad', {}, ` ⚠️ ${helpers} chair${helpers === 1 ? ' has' : 's have'} no teammate picked: ${helpers === 1 ? 'a general helper sits' : 'general helpers sit'} there. Pick someone in the right-hand box, or remove the chair.`)] : []),
    );
    const icon = pattern === 'talk' ? '💬' : '🤝';
    const start = pattern === 'talk' ? 'Start talking' : 'Start';
    submit.textContent = picked.length && !helpers ? `${icon} ${start} with ${picked.length === 1 ? picked[0] : `these ${picked.length}`}` : helpers === roles.length ? `${icon} ${start} with ${helpers} helper${helpers === 1 ? '' : 's'}` : `${icon} ${start} (${picked.length} teammate${picked.length === 1 ? '' : 's'} + ${helpers} helper${helpers === 1 ? '' : 's'})`;
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = Array.from({ length: Math.min(d.seats.default, maxSeats(d)) }, (_, i) => defaultRole(i));
    members = members.slice(0, roles.length);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    roundsIn.min = String(d.rounds.min);
    roundsIn.max = String(d.rounds.max);
    roundsIn.value = String(d.rounds.default);
    roundsIn.disabled = d.rounds.min === d.rounds.max;
    roundsNote.textContent = d.roundsNote;
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    // A conversation has no rounds and writes its file only when it ends: nothing to set for either.
    const talk = p === 'talk';
    roundsRow.classList.toggle('hidden', talk);
    outputRow.classList.toggle('hidden', talk);
    aboutLabel.textContent = talk ? 'Your opening message, to everyone at the table' : 'What’s it about?';
    about.placeholder = talk ? 'Say hello and what you want to talk about: e.g. “Morning all. What should we ship this week, and what’s in the way?”' : 'The question to settle, or the task to do: e.g. “Should the dog use A* or a navmesh?”';
    footNote.textContent = talk ? 'No rounds: you talk, they answer, until you end it. Haiku keeps the table’s shared memory.' : 'Few rounds and a file at the end: that’s what keeps meetings cheap.';
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.meeting-pattern', { type: 'button', role: 'radio', 'data-pattern': id, onclick: () => pickPattern(id) }, h('b', {}, `${d.icon} ${d.label}`), h('small', {}, d.blurb)));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) {
      roles.pop();
      members = members.slice(0, roles.length);
    }
    renderRoles();
  });
  crewFill.addEventListener('change', () => {
    const awake = crewFill.value === '@awake'
      ? { id: '@awake', name: 'teammates awake here', members: [...new Set([...store.workers.values()].filter((w) => w.role && w.kind === 'agent' && w.status !== 'offline' && w.status !== 'exited' && !w.meeting).map((w) => w.role!))] }
      : undefined;
    const crew = awake ?? CREWS.find((c) => c.id === crewFill.value);
    crewFill.value = '';
    if (!crew) return;
    if (!crew.members.length) return void toast('Nobody from the roster is awake on this floor: wake some (R at their desk) or pick them in the boxes', 'warn');
    const d = def();
    const n = Math.max(d.seats.min, Math.min(maxSeats(d), crew.members.length));
    // Keep the pattern's parts for the chairs, and grow or shrink the table to fit the crew.
    roles = Array.from({ length: n }, (_, i) => roles[i] ?? (pattern === 'talk' ? '' : (d.roles[i] ?? TEAM_BY_ID.get(crew.members[i] ?? '')?.name ?? `Worker ${i + 1}`)));
    members = Array.from({ length: n }, (_, i) => crew.members[i] ?? '');
    if (crew.members.length > n) toast(`${d.label} seats at most ${maxSeats(d)}: the first ${n} of the ${crew.name} sit down`, 'warn');
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < maxSeats(def())) roles.push(defaultRole(roles.length));
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  budgetIn.addEventListener('input', () => (budgetTouched = true));
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);

  const bodyEl = h(
    'form.meeting-form',
    {},
    patterns,
    h('div.meeting-field', {}, aboutLabel, about, files.element),
    h('div.meeting-field', {}, titleIn),
    prRow,
    partsRow,
    outputRow,
    h('div.meeting-field', {}, h('label.meeting-count', {}, 'At the table', minus, count, plus, crewFill), roleList, whoSummary, whoNote),
    h('div.meeting-bounds', {}, roundsRow, h('div.meeting-field', {}, h('label', {}, 'Token budget (thousands)'), budgetIn, h('small.muted', {}, 'For everyone at the table together. Over it, the meeting stops.'))),
    provider.element,
    busy,
  ) as HTMLFormElement;
  bodyEl.noValidate = true;

  /** Said yes to general helpers for this start. */
  let helpersOk = false;
  let uploading = false;
  const send = async () => {
    if (store.meeting.current?.status === 'running' || uploading) return;
    const prompt = about.value.trim();
    if (!prompt) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`List at least ${roles.length - 1} parts, one per line, or seat fewer workers`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (pattern !== 'talk' && outputProblem(output)) return outputIn.focus();
    if (!provider.valid()) return;
    const empty = roles.map((r, i) => (members[i] ? null : r.trim() || `chair ${i + 1}`)).filter((r): r is string => !!r);
    if (empty.length && !helpersOk) {
      confirmDialog(
        'Start with general helpers?',
        `Nobody from your team is picked for ${empty.length === roles.length ? 'any chair' : empty.map((r) => `“${r}”`).join(', ')}, so a general helper (not one of your teammates) would sit there. Pick people in the “Who” boxes, or start anyway.`,
        'Start anyway',
        () => {
          helpersOk = true;
          void send();
        },
      );
      return;
    }
    helpersOk = false;
    // The files go up first: the message hands the table their paths.
    let attached: string[] | undefined;
    if (files.count()) {
      uploading = true;
      try {
        toast(`📎 Uploading ${files.count() === 1 ? 'the file' : `${files.count()} files`}…`);
        attached = await files.upload();
      } catch (err) {
        toast(`Couldn't upload: ${(err as Error).message}`, 'error');
        return;
      } finally {
        uploading = false;
      }
    }
    net.send({
      t: 'meeting.start',
      attachments: attached,
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      // A conversation's write-up goes where the pattern puts it, named after its title.
      output: pattern === 'talk' ? undefined : output,
      roles: roles.map((r) => r.trim()),
      members: roles.map((_, i) => members[i] ?? ''),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsIn.value) || undefined,
      budget: Math.round((Number(budgetIn.value) || 0) * 1000) || undefined,
      provider: provider.value(),
      model: provider.model(),
      effort: provider.effort(),
    });
    toast(pattern === 'talk' ? '💬 Starting the conversation: your teammates are heading for the meeting room' : `🤝 Calling the ${def().label} meeting: the workers are heading for the meeting room`);
    done();
  };
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    void send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const want = prSel.value || (preset?.pr ? String(preset.pr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (preset?.pr && !open.some((p) => p.number === preset.pr)) opts.unshift([String(preset.pr), `#${preset.pr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(h('option', { value: '' }, open.length || preset?.pr ? 'Pick a pull request…' : 'No open pull requests'), ...opts.map(([v, label]) => h('option', { value: v }, label.length > 70 ? `${label.slice(0, 69)}…` : label)));
      prSel.value = want;
      syncOutput();
    }
    const m = store.meeting.current;
    const taken = m?.status === 'running';
    busy.textContent = taken ? `The room is busy with “${m.title}” until it ends or someone stops it.` : m ? `Starting this sends the last meeting’s workers home.` : '';
    submit.toggleAttribute('disabled', taken);
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, foot: [footNote, cancel, submit], refresh };
}

/** The follow-ups put to the table once it was over: the question, who the lead brought in, the answer's start. */
function followups(m: Meeting): HTMLElement | null {
  if (!m.followups?.length) return null;
  return h(
    'div.meeting-followups',
    {},
    h('b', {}, `↪️ Follow-ups (${m.followups.length})`),
    ...m.followups.map((f, i) =>
      h(
        'div.meeting-followup',
        {},
        h('div', {}, h('b', {}, `${i + 1}. `), f.text),
        h(
          'small.muted',
          {},
          f.status === 'running' && m.followup === i + 1 ? `⏳ the ${m.seats[0]?.role ?? 'lead'} is on it${f.helpers?.length ? ` with ${f.helpers.join(', ')}` : ''}` : f.status === 'stopped' ? `⛔ ${f.reason ?? 'stopped'}` : `✅ answered${f.helpers?.length ? ` with ${f.helpers.join(', ')}` : ''}: it's in ${m.output}`,
        ),
      ),
    ),
  );
}

/** Another question for the table that just met: its head takes it and directs the others. */
function followBox(m: Meeting, net: Net): HTMLElement {
  const lead = m.seats[0];
  const input = h('textarea', { rows: 2, placeholder: `Ask the ${lead?.role ?? 'lead'} (${lead?.workerName ?? 'the head of the table'}) a follow-up…`, 'aria-label': 'Follow-up' }) as HTMLTextAreaElement;
  const send = h('button.btn.primary', { type: 'button' }, '↪️ Follow up') as HTMLButtonElement;
  const files = attachBox(input);
  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    let attached: string[] | undefined;
    if (files.count()) {
      try {
        attached = await files.upload();
      } catch (err) {
        return toast(`Couldn't upload: ${(err as Error).message}`, 'error');
      }
    }
    net.send({ t: 'meeting.followup', text, attachments: attached });
    input.value = '';
    files.clear();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send.click();
  });
  return h('div.meeting-followbox', {}, h('small.muted', {}, `Keep going: the ${lead?.role ?? 'lead'} reads your follow-up, hands the others their parts and adds the answer to ${m.output}.`), input, files.element, send);
}
