// A conversation with one teammate (DESIGN.md §6.4, REDESIGN.md §3): the heart of Hearth. A glass
// header with who they are and how they're doing, her messages on the right in ember, theirs on the
// left as rendered markdown with the tools they used as quiet chips, a working indicator that says
// what they're up to, a "needs you" card that can answer a terminal prompt with one tap, and a glass
// composer that rides the keyboard and takes photos and PDFs. The header opens the teammate sheet:
// their role card, model, tokens and cost, and everything you can do with them (wake, stop, the
// terminal, their changes, a pull request, send home).
//
// Where the words come from: GET /api/chat (the teammate's own transcript), polled every 2.5 s while
// the chat is open and at once when the teammate's status changes. Messages are patched in by id (a
// reply still being written keeps its id and grows), never re-rendered, so nothing flashes or jumps.
// Sending is worker.prompt over the socket (it wakes a resting teammate too), shown at once and
// matched to the transcript when it lands.

import type { AppContext, View } from '../context';
import type { ChatAttachment, ChatMessage, ChatResponse, ChatTool } from '../../../shared/app-api';
import { CLAUDE_MODEL_IDS, fmtCost, fmtTokens, tokensOf, type WorkerInfo } from '../../../shared/protocol';
import { PERSONAL_DEPARTMENTS, TEAM_BY_ID } from '../../../shared/team';
import { markdown } from '../../ui/markdown';
import { attachNote, uploadImage } from '../../attach';
import { icon } from '../icons';
import {
  avatar,
  button,
  clockTime,
  confirmDialog,
  dayLabel,
  emptyState,
  fileSize,
  firstName,
  h,
  iconButton,
  isResting,
  loadDraft,
  onTeam,
  roleTitle,
  saveDraft,
  setAvatarStatus,
  sheet,
  signInAgain,
  skeleton,
  spaceColor,
  spaceName,
  statusChip,
  uiStatus,
  type SheetHandle,
} from '../ui';
import { chatEntries, chatRow } from './chats';
import { followKeyboard, haptic, peekTerminal, screenChoices, sentKeyToast, tmBack, tmIcon, type TmIcon } from './terminal';

const POLL_MS = 2500;
const GROUP_GAP_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;
const TECHNICAL = /\\|\w\/\w|\(\)|\.(?:ts|js|json|md|py|ps1|sh)\b|\bnpm\b|[{}<>`]/;
/** A needs_input that's Claude's own first-run screen (trust this folder, log in), not a question from the work. */
const SETUP = /setup prompt|trust|log ?in|signed in|\/hooks/i;

interface Pending {
  localId: string;
  text: string;
  files: File[];
  /** Once uploaded, so a retry doesn't upload them again. */
  paths?: string[];
  previews: string[];
  sentAt: number;
  state: 'sending' | 'sent' | 'failed';
  row: HTMLElement;
}

/** The office's own instructions for a group chat (see server/meetings.ts): never her words. */
// Any edition's name (and the old one, in chats from before): "...in Hearth's meeting room".
const GROUP_BRIEF = /\bin an? [^\n]{1,40}? meeting in [^\n]{1,40}?'s meeting room\b/;
const GROUP_TOPIC = /What the meeting is about:\n([^\n]+)/;
const GROUP_ROUND = /^Round (\d+) of (\d+), [^\n]{1,60}?\. /;

/**
 * A message the office sent a teammate in her name (a group chat's brief or its next round), as the
 * quiet line Hearth shows instead; null for anything she actually said.
 */
export function officeLine(m: Pick<ChatMessage, 'role' | 'text'>): string | null {
  if (m.role !== 'user') return null;
  const t = m.text.trim();
  if (GROUP_BRIEF.test(t)) {
    const first = t.split('\n')[0].trim();
    let topic = first && !/^You(?:'|’)re /.test(first) ? first : (GROUP_TOPIC.exec(t)?.[1] ?? '').trim();
    if (topic.length > 80) topic = `${topic.slice(0, 79).trimEnd()}…`;
    return topic ? `Joined a group chat about “${topic[0].toUpperCase()}${topic.slice(1)}”` : 'Joined a group chat';
  }
  const r = GROUP_ROUND.exec(t);
  if (r) return `Group chat, round ${r[1]} of ${r[2]}`;
  return null;
}

const fileUrl = (floor: string, path: string) => `/api/attach/file?floor=${encodeURIComponent(floor)}&path=${encodeURIComponent(path)}`;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f: File) => f.type.startsWith('image/');
const finePointer = () => matchMedia('(pointer: fine)').matches;
const phoneLayout = () => !matchMedia('(min-width: 700px)').matches;
const splitLayout = () => matchMedia('(min-width: 1200px)').matches;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

// =================================================================================================
// Who they are, in words: the household's spaces get the plain version (DESIGN §9 glossary)
// =================================================================================================

/** The household's spaces (the roster's personal departments, like Personal Finance): no model names, commands or file paths on screen. */
export function plainSpace(floor: string, w?: { role?: string }): boolean {
  const group = w?.role ? TEAM_BY_ID.get(w.role)?.group : undefined;
  if (group) return PERSONAL_DEPARTMENTS.has(group);
  return /home|personal|finance|family/i.test(floor);
}

const EFFORT_WORD: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** "Opus 5.5", "Sonnet 5.5", "Haiku 4.5", or the model's own name for other providers. */
export function modelName(w: Pick<WorkerInfo, 'kind' | 'model' | 'provider' | 'role'>): string | null {
  if (w.kind !== 'agent') return null;
  const m = w.model ?? (w.role ? TEAM_BY_ID.get(w.role)?.model : undefined);
  if (!m) return w.provider && w.provider !== 'claude' ? cap(w.provider) : null;
  const alias = /(?:^|[-/])(opus|sonnet|haiku|fable)(?=$|[-/])/i.exec(m)?.[1]?.toLowerCase();
  if (!alias) return m.split('/').pop() ?? m;
  const id = /\d/.test(m) ? m : CLAUDE_MODEL_IDS[alias as keyof typeof CLAUDE_MODEL_IDS] ?? '';
  const v = /-(\d+)-(\d{1,2})(?:-|$)/.exec(id);
  return `${cap(alias)}${v ? ` ${v[1]}.${v[2]}` : ''}`;
}

export function effortName(w: Pick<WorkerInfo, 'kind' | 'effort' | 'role'>): string | null {
  if (w.kind !== 'agent') return null;
  const e = w.effort ?? (w.role ? TEAM_BY_ID.get(w.role)?.effort : undefined);
  return e ? (EFFORT_WORD[e] ?? cap(e)) : null;
}

interface ToolLook {
  icon: TmIcon;
  /** Past tense, for the chip under a reply: "Searched the web". */
  did: string;
  /** Present, for the working indicator: "Searching the web". */
  doing: string;
  what?: string;
  mono?: boolean;
}

/** A tool call in a few plain words. Null for the office's own plumbing, which isn't worth a chip. */
export function toolLook(t: ChatTool, plain: boolean): ToolLook | null {
  const n = t.name.replace(/^mcp__[^_]+__/, '');
  const s = t.summary.trim();
  const file = s ? basename(s) : undefined;
  switch (t.name) {
    case 'ToolSearch':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return null;
    case 'Read':
    case 'NotebookRead':
      return { icon: 'read', did: 'Read', doing: 'Reading', what: file };
    case 'Write':
      return { icon: 'pencil', did: 'Wrote', doing: 'Writing', what: file };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: 'pencil', did: 'Edited', doing: 'Editing', what: file };
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { icon: 'search', did: 'Looked through files', doing: 'Looking through files', what: plain ? undefined : s, mono: true };
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
      return plain ? { icon: 'terminal', did: 'Ran a command', doing: 'Running a command' } : { icon: 'terminal', did: 'Ran', doing: 'Running', what: s || 'a command', mono: !!s };
    case 'WebSearch':
      return { icon: 'search', did: 'Searched the web', doing: 'Searching the web', what: s };
    case 'WebFetch':
      return { icon: 'globe', did: 'Opened', doing: 'Reading a web page', what: s.replace(/^https?:\/\//, '').split('/')[0] };
    case 'Task':
    case 'Agent':
      return { icon: 'helper', did: 'Asked a helper', doing: 'Asking a helper', what: s };
    case 'TodoWrite':
      return { icon: 'list', did: 'Updated its list', doing: 'Planning' };
    case 'Skill':
      return { icon: 'spark', did: 'Used a skill', doing: 'Using a skill', what: s };
  }
  const nice = n.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { icon: 'spark', did: `Used ${nice}`, doing: `Using ${nice}`, what: plain ? undefined : s || undefined };
}

/** What a working teammate is up to right now, for the typing bubble and the status line. */
function doingNow(w: WorkerInfo, plain: boolean): string | null {
  const a = (w.activity ?? '').trim();
  const tool = /^([A-Za-z_]+)(?::\s*|\s+)?(.*)$/.exec(a);
  if (tool && /^[A-Z]/.test(tool[1])) {
    const look = toolLook({ name: tool[1], summary: tool[2] ?? '' }, plain);
    if (look && (tool[1] !== look.did || !tool[2])) return look.doing;
  }
  const sum = w.task?.summary?.trim();
  if (sum && (!plain || !TECHNICAL.test(sum))) return sum.length > 70 ? `${sum.slice(0, 69).trimEnd()}…` : sum;
  return null;
}

// =================================================================================================
// Pictures and files
// =================================================================================================

/** A full-screen look at a picture. */
function lightbox(src: string, alt: string) {
  const img = h('img', { src, alt });
  const d = h('dialog.a-lightbox', { 'aria-label': alt || 'Picture' }, img) as HTMLDialogElement;
  const close = () => {
    d.close();
    d.remove();
  };
  d.append(iconButton('close', 'Close', close, 24));
  d.addEventListener('click', (e) => e.target !== img && close());
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/** Markdown for a teammate's bubble: tables and code scroll sideways, pictures open full screen. */
function renderMarkdown(text: string): HTMLElement {
  const md = markdown(text);
  for (const t of md.querySelectorAll('table')) {
    const wrap = h('div.a-tm-table');
    t.replaceWith(wrap);
    wrap.append(t);
  }
  for (const img of md.querySelectorAll('img')) img.addEventListener('click', () => lightbox(img.src, img.alt));
  return md;
}

function attachmentsEl(floor: string, list: ChatAttachment[]): HTMLElement | null {
  if (!list.length) return null;
  return h(
    'div.a-tm-files',
    {},
    ...list.map((a) => {
      const src = fileUrl(floor, a.path);
      const chip = () => h('a.a-tm-filechip', { href: src, target: '_blank', rel: 'noopener' }, icon(a.kind === 'pdf' ? 'file' : 'photo', 18), h('span', {}, a.name));
      if (a.kind !== 'image') return chip();
      const img = h('img', { src, alt: a.name, loading: 'lazy', decoding: 'async' }) as HTMLImageElement;
      const b = h('button.a-tm-thumb', { type: 'button', 'aria-label': `Open ${a.name}` }, img);
      b.addEventListener('click', () => lightbox(src, a.name));
      // No thumbnail (moved, or an office that can't serve it yet): a chip with the name instead.
      img.addEventListener('error', () => b.replaceWith(chip()), { once: true });
      return b;
    }),
  );
}

/** The tools of one reply as quiet chips: repeats fold into one ("Read × 4"), long lists fold behind "+3". */
function toolsEl(tools: ChatTool[], plain: boolean): HTMLElement | null {
  const looks: (ToolLook & { n: number })[] = [];
  for (const t of tools) {
    const l = toolLook(t, plain);
    if (!l) continue;
    const last = looks[looks.length - 1];
    if (last && last.did === l.did) {
      last.n++;
      last.what = l.what ?? last.what;
    } else looks.push({ ...l, n: 1 });
  }
  if (!looks.length) return null;
  const SHOW = 3;
  const chip = (l: ToolLook & { n: number }) =>
    h(
      'span.a-tm-tool',
      { title: l.what ? `${l.did} ${l.what}` : l.did },
      tmIcon(l.icon, 14),
      h('span.a-tm-tool__did', {}, l.did),
      l.what ? h('span.a-tm-tool__what', { class: l.mono ? 'is-mono' : '' }, l.what) : null,
      l.n > 1 ? h('span.a-tm-tool__n', {}, `×${l.n}`) : null,
    );
  const row = h('div.a-tm-tools', { role: 'list', 'aria-label': 'What they did' }, ...looks.slice(0, SHOW).map((l) => h('span', { role: 'listitem', style: 'display:contents' }, chip(l))));
  if (looks.length > SHOW) {
    const more = h('button.a-tm-tool.a-tm-tool--more', { type: 'button', 'aria-label': `Show ${looks.length - SHOW} more` }, `+${looks.length - SHOW}`);
    more.addEventListener('click', () => {
      more.replaceWith(...looks.slice(SHOW).map(chip));
    });
    row.append(more);
  }
  return row;
}

// =================================================================================================
// The screen
// =================================================================================================

export const chatView: View = (root, ctx, route) => {
  if (route.view !== 'chat') return;
  const { floor, worker: workerId } = route;
  return mountChat(root, ctx, floor, workerId);
};

function mountChat(root: HTMLElement, ctx: AppContext, floor: string, workerId: string): () => void {
  const cleanups: (() => void)[] = [];
  const info = (): WorkerInfo | undefined => ctx.store.workers.get(workerId);
  let name = info()?.name ?? 'Teammate';
  const plain = plainSpace(floor, info());

  // =============================================================================================
  // Frame: [conversation list on wide screens] + aura / log / glass header / glass composer
  // =============================================================================================
  const whoAvatar = info() ? avatar(info()!, 40) : avatar({ name, size: 40 });
  const nameEl = h('span.a-tm-head__name', {}, name);
  const statusEl = h('span.a-tm-head__status', { 'aria-live': 'polite' });
  const whoBtn = h(
    'button.a-tm-who',
    { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${name}: about them, and what you can do` },
    h('span.a-tm-halo', {}, whoAvatar),
    h('span.a-tm-who__text', {}, h('h1.a-tm-head__title', {}, nameEl), statusEl),
  );
  const moreBtn = h('button.a-tm-round', { type: 'button', 'aria-label': 'Teammate actions', 'aria-haspopup': 'dialog', title: 'Actions' }, icon('more', 22));
  const strip = h('div.a-tm-strip');
  const header = h('header.a-tm-head', {}, h('div.a-tm-head__row', {}, tmBack(spaceName(floor), ctx, { view: 'space', floor }), whoBtn, moreBtn), strip);

  const stream = h('div.a-tm-stream');
  const tail = h('div.a-tm-tail');
  const log = h('div.a-tm-log', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': `Conversation with ${name}`, tabindex: '0' }, h('div.a-tm-log__inner', {}, stream, tail));
  const pill = h('button.a-tm-newpill', { type: 'button', hidden: true }, 'New message', icon('arrow-down', 16));

  // ---- Composer ----
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  const attachBtn = h('button.a-tm-composer__attach', { type: 'button', 'aria-label': 'Attach photos or files', title: 'Attach photos or files' }, icon('attach', 20));
  attachBtn.addEventListener('click', () => fileInput.click());
  const field = h('textarea.a-tm-composer__field', {
    rows: 1,
    autocapitalize: 'sentences',
    spellcheck: 'true',
    autocomplete: 'off',
    'aria-label': `Message ${name}`,
    placeholder: `Message ${name}…`,
  }) as HTMLTextAreaElement;
  if (finePointer()) field.setAttribute('enterkeyhint', 'send');
  const sendBtn = h('button.a-tm-composer__send.is-hidden', { type: 'submit', 'aria-label': 'Send' }, icon('send', 20));
  const chips = h('div.a-tm-attachrow', { 'aria-label': 'Attached files' });
  const composer = h('form.a-tm-composer', { 'aria-label': `Message ${name}` }, chips, h('div.a-tm-composer__row', {}, attachBtn, fileInput, h('div.a-tm-composer__box', {}, field, sendBtn)));

  const aura = h('div.a-tm-aura', { 'aria-hidden': 'true' }, h('span'), h('span'));
  const conversation = h('section.a-tm-chat__main', { 'aria-label': `Chat with ${name}` }, aura, log, header, pill, composer);
  const aside = h('aside.a-tm-chat__list', { 'aria-label': 'Chats' });
  const chatEl = h('div.a-tm-chat', { style: `--a-who:${info()?.color ?? 'var(--a-accent, var(--a-clay))'};--a-space:${spaceColor(floor)}` }, aside, conversation);
  root.append(chatEl);

  // The log scrolls under the glass: pad it by however tall the header and composer are right now.
  const ro = new ResizeObserver(() => {
    chatEl.style.setProperty('--a-tm-head-h', `${header.offsetHeight}px`);
    chatEl.style.setProperty('--a-tm-foot-h', `${composer.offsetHeight}px`);
    if (stick) scrollToBottom();
  });
  ro.observe(header);
  ro.observe(composer);
  cleanups.push(() => ro.disconnect());

  // =============================================================================================
  // Header, status line, the strip (model · task) and the tail (working / needs you)
  // =============================================================================================
  let lastStatus = '';
  /** The teammate sheet while it's open (see openActions below). */
  let actions: { handle: SheetHandle; body: HTMLElement; sig: string } | null = null;
  const renderStatus = () => {
    const w = info();
    if (!w) return;
    name = w.name;
    nameEl.textContent = w.name;
    document.title = `${w.name} · Hearth`;
    const s = uiStatus(w);
    setAvatarStatus(whoAvatar, s);
    chatEl.style.setProperty('--a-who', w.color);
    chatEl.dataset.status = s;
    const doing = s === 'working' ? doingNow(w, plain) : null;
    const sig = `${w.status}|${w.acked}|${w.activity ?? ''}|${w.task?.name ?? ''}|${w.task?.summary ?? ''}|${w.model ?? ''}|${w.effort ?? ''}`;
    if (sig === lastStatus) return;
    lastStatus = sig;
    statusEl.dataset.status = s;
    const words =
      w.status === 'starting'
        ? 'Getting settled…'
        : s === 'working'
          ? doing ?? 'Working on it'
          : s === 'needs'
            ? SETUP.test(w.activity ?? '') ? 'Needs you · a setup question' : 'Needs your OK'
            : s === 'done'
              ? 'Finished · take a look'
              : s === 'resting'
                ? 'Resting'
                : roleTitle(w) ?? 'Here';
    statusEl.replaceChildren(h('span.a-tm-dot', { 'aria-hidden': 'true' }), h('span', {}, words));
    field.placeholder = s === 'needs' ? `Reply to ${w.name}…` : `Message ${w.name}…`;
    field.setAttribute('aria-label', s === 'needs' ? `Reply to ${w.name}` : `Message ${w.name}`);

    // The strip under the name: what they run on (not on the household's spaces) and what they're on.
    strip.replaceChildren();
    const model = plain ? null : modelName(w);
    const effort = plain ? null : effortName(w);
    if (model) strip.append(h('span.a-tm-badge', { title: 'Model and effort' }, tmIcon('spark', 13), model, effort ? h('span.a-tm-badge__sep', {}, effort) : null));
    const taskName = w.task?.name && w.task.name.toLowerCase() !== w.name.toLowerCase() ? w.task.name : w.task?.summary;
    if (taskName) strip.append(h('span.a-tm-task', { title: w.task?.summary || taskName }, h('span.a-tm-task__over', {}, 'On'), taskName));
    else if (w.title && !plain && w.title.toLowerCase() !== w.name.toLowerCase()) strip.append(h('span.a-tm-task', {}, h('span.a-tm-task__over', {}, 'On'), w.title));
    strip.hidden = !strip.childElementCount;

    // The empty chat's hello says whether they're resting.
    stream.querySelector('.a-tm-intro')?.replaceWith(intro());
    renderTail();
    if (actions) renderActions();
  };

  // ---- Needs you: the card, and a quiet look at the question on their screen ----
  let stopPeek: (() => void) | null = null;
  let needsCard: HTMLElement | null = null;
  const peekEl = h('pre.a-tm-needs__screen', { 'aria-label': 'What their screen says' });
  const answers = h('div.a-tm-needs__answers', { role: 'group', 'aria-label': 'Quick answers' });
  let lastChoices = '';

  /** Keys for her, one message each, a beat apart, so a TUI sees them as keypresses (the last is usually Enter). */
  let keyTimers: ReturnType<typeof setTimeout>[] = [];
  const sendKeys = (keys: string[], label: string) => {
    keyTimers.forEach(clearTimeout);
    keyTimers = keys.map((data, i) => setTimeout(() => ctx.net.send({ t: 'term.input', workerId, data }), i * 90));
    sentKeyToast(name, label);
  };
  cleanups.push(() => keyTimers.forEach(clearTimeout));
  const answerBtn = (kbd: string | SVGElement, label: string, aria: string, keys: string[], toastLabel: string, cls = '') => {
    const b = h('button.a-tm-answer', { type: 'button', class: cls, 'aria-label': aria }, typeof kbd === 'string' ? (kbd ? h('kbd', {}, kbd) : null) : kbd, label ? h('span', {}, label) : null);
    b.addEventListener('click', () => sendKeys(keys, toastLabel));
    return b;
  };
  const renderAnswers = (lines: string[] | null) => {
    const choices = lines ? screenChoices(lines) : [];
    const key = JSON.stringify(choices);
    if (key === lastChoices && answers.childElementCount) return;
    lastChoices = key;
    const picks = choices.length
      ? choices.map((c) => answerBtn(c.hint, c.label, `Answer: ${c.label}`, c.keys, `“${c.label}”`, 'a-tm-answer--choice'))
      : ['1', '2'].map((n) => answerBtn(n, '', `Press ${n}`, [n], `“${n}”`));
    answers.replaceChildren(
      ...picks,
      answerBtn(tmIcon('enter', 16), 'Enter', 'Press Enter', ['\r'], 'Enter', 'a-tm-answer--key'),
      answerBtn('', 'Esc', 'Press Escape', ['\x1b'], 'Esc', 'a-tm-answer--key is-quiet'),
    );
  };
  const buildNeeds = (w: WorkerInfo): HTMLElement => {
    const setup = SETUP.test(w.activity ?? '');
    const title = setup ? 'It’s asking something in its terminal' : 'Wants your OK';
    const text = setup
      ? `${w.name} is stuck on a setup question, like trusting this folder or signing in. Pick an answer below, or open the terminal to see it all.`
      : w.activity && !TECHNICAL.test(w.activity)
        ? w.activity
        : `${w.name} is waiting for your answer in its terminal.`;
    peekEl.replaceChildren(h('span.a-tm-needs__wait', {}, 'Looking at their screen…'));
    renderAnswers(null);
    return h(
      'div.a-tm-needs',
      { role: 'group', 'aria-label': title },
      h('div.a-tm-needs__over', {}, h('span.a-tm-needs__pulse', { 'aria-hidden': 'true' }), 'Needs you'),
      h('h2.a-tm-needs__title', {}, title),
      h('p.a-tm-needs__text', {}, text),
      h('div.a-tm-needs__frame', {}, peekEl),
      answers,
      h(
        'a.a-tm-needs__open',
        { href: `#/term/${encodeURIComponent(floor)}/${encodeURIComponent(workerId)}` },
        tmIcon('terminal', 18),
        h('span', {}, plain ? 'Open behind the scenes' : 'Open the terminal'),
        icon('forward', 18),
      ),
    );
  };
  const startPeek = () => {
    if (stopPeek) return;
    stopPeek = peekTerminal(ctx.net, workerId, (lines) => {
      const near = isNearBottom();
      if (!lines.length) peekEl.replaceChildren(h('span.a-tm-needs__wait', {}, 'Open the terminal to see what it’s asking.'));
      else peekEl.textContent = lines.join('\n');
      // The question and its choices are at the bottom of the screen.
      peekEl.scrollTop = peekEl.scrollHeight;
      renderAnswers(lines);
      if (near) scrollToBottom();
    });
  };
  const endPeek = () => {
    stopPeek?.();
    stopPeek = null;
    needsCard = null;
    lastChoices = '';
  };
  cleanups.push(endPeek);

  const renderTail = () => {
    const w = info();
    const nearBottom = isNearBottom();
    if (!w) return tail.replaceChildren();
    const s = uiStatus(w);
    if (s === 'needs') {
      if (!needsCard) {
        needsCard = buildNeeds(w);
        tail.replaceChildren(needsCard);
      }
      startPeek();
    } else {
      endPeek();
      tail.replaceChildren();
      if (s === 'working' && w.status !== 'starting') {
        const doing = doingNow(w, plain);
        tail.append(
          h(
            'div.a-tm-typing',
            { 'aria-hidden': 'true' },
            h('span.a-tm-typing__dots', {}, h('span'), h('span'), h('span')),
            h('span.a-tm-typing__text', {}, doing ? `${doing}…`.replace(/…+$/, '…') : 'Thinking…'),
          ),
        );
      } else if (w.status === 'starting') tail.append(h('div.a-tm-typing', { 'aria-hidden': 'true' }, h('span.a-tm-typing__dots', {}, h('span'), h('span'), h('span')), h('span.a-tm-typing__text', {}, 'Getting settled…')));
    }
    if (nearBottom) scrollToBottom();
  };

  // =============================================================================================
  // Messages: patched in by id
  // =============================================================================================
  const rendered = new Map<string, { row: HTMLElement; key: string }>();
  const pending: Pending[] = [];
  let loaded = false;
  let missing = false;
  const keyOf = (m: ChatMessage) => `${m.at}|${m.text.length}|${m.text.slice(-40)}|${(m.attachments ?? []).map((a) => a.path).join('|')}|${m.tools?.length ?? 0}`;

  const buildMessage = (m: ChatMessage): HTMLElement => {
    const sys = officeLine(m);
    if (sys !== null) return h('div.a-tm-msg.a-tm-msg--sys', { 'data-id': m.id, 'data-at': m.at }, h('p.a-tm-sysline', {}, sys));
    const me = m.role === 'user';
    const row = h('div.a-tm-msg', { class: me ? 'a-tm-msg--me' : 'a-tm-msg--them', 'data-id': m.id, 'data-at': m.at });
    fillRow(row, m);
    return row;
  };

  const fillRow = (row: HTMLElement, m: ChatMessage) => {
    const me = m.role === 'user';
    const meta = row.querySelector(':scope > .a-tm-meta') ?? h('div.a-tm-meta');
    row.replaceChildren();
    const tools = !me && m.tools?.length ? toolsEl(m.tools, plain) : null;
    if (tools) row.append(tools);
    const files = attachmentsEl(floor, m.attachments ?? []);
    if (m.text.trim() || files) {
      const bubble = h('div.a-tm-bubble');
      if (m.text.trim()) bubble.append(me ? h('span.a-tm-bubble__text', {}, m.text) : renderMarkdown(m.text));
      if (files) bubble.append(files);
      row.append(bubble);
    }
    row.classList.toggle('is-tools-only', !!tools && !row.querySelector('.a-tm-bubble'));
    row.append(meta);
  };

  const visible = (m: ChatMessage) => !!(m.text.trim() || m.attachments?.length || (m.role === 'assistant' && m.tools?.some((t) => toolLook(t, plain))));

  /**
   * Groups (same sender, within 5 min, same day), their meta lines, and the day separators. Touches
   * the DOM only where something changed: the log is aria-live, so a re-added "Today" would be read out
   * again on every poll.
   */
  const regroup = () => {
    const keep = new Set<Element>();
    const rows = [...stream.querySelectorAll<HTMLElement>('.a-tm-msg')];
    let prevDay = '';
    rows.forEach((row, i) => {
      const at = Number(row.dataset.at);
      const prev = rows[i - 1];
      const next = rows[i + 1];
      const day = new Date(at).toDateString();
      const sys = (o: HTMLElement) => o.classList.contains('a-tm-msg--sys');
      const sameAs = (o: HTMLElement | undefined) =>
        !!o && !sys(o) && !sys(row) && o.classList.contains('a-tm-msg--me') === row.classList.contains('a-tm-msg--me') && Math.abs(Number(o.dataset.at) - at) < GROUP_GAP_MS && new Date(Number(o.dataset.at)).toDateString() === day;
      if (day !== prevDay) {
        const label = dayLabel(at);
        const before = row.previousElementSibling;
        if (before?.classList.contains('a-tm-day') && before.textContent === label) keep.add(before);
        else {
          const sep = h('div.a-tm-day', { role: 'separator' }, h('span', {}, label));
          stream.insertBefore(sep, row);
          keep.add(sep);
        }
        prevDay = day;
      }
      row.classList.toggle('is-group-start', !sameAs(prev));
      row.classList.toggle('is-group-end', !sameAs(next));
      const meta = row.querySelector<HTMLElement>(':scope > .a-tm-meta');
      const said = row.classList.contains('a-tm-msg--me') ? `Sent ${clockTime(at)}` : clockTime(at);
      if (meta && !row.dataset.local && meta.textContent !== said) meta.textContent = said;
    });
    stream.querySelectorAll('.a-tm-day').forEach((d) => keep.has(d) || d.remove());
  };

  const isNearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
  /** Whether she's reading the newest messages: kept up to date as she scrolls, so a resize can follow. */
  let stick = true;
  const scrollToBottom = () => {
    log.scrollTop = log.scrollHeight;
    pill.hidden = true;
    stick = true;
  };
  log.addEventListener('scroll', () => {
    stick = isNearBottom();
    if (stick) pill.hidden = true;
    header.classList.toggle('is-scrolled', log.scrollTop > 4);
  }, { passive: true });
  pill.addEventListener('click', () => {
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
    pill.hidden = true;
  });

  const intro = () => {
    const w = info();
    const member = w?.role ? TEAM_BY_ID.get(w.role) : undefined;
    return h(
      'div.a-tm-intro',
      {},
      h('span.a-tm-halo.a-tm-halo--big', {}, w ? avatar(w, 72) : avatar({ name, size: 72 })),
      h('h2.a-tm-intro__name', {}, name),
      member ? h('p.a-tm-intro__role', {}, member.title !== name ? member.title : member.group) : null,
      member?.pitch ? h('p.a-tm-intro__pitch', {}, member.pitch) : null,
      h('p.a-tm-intro__hint', {}, isResting(w ?? { status: 'idle' }) ? `${name} is resting. Send a message and they’ll wake up.` : `Send ${name} a message to get started.`),
    );
  };

  const patch = (messages: ChatMessage[]) => {
    const wasNear = isNearBottom();
    const firstLoad = !loaded;
    loaded = true;
    stream.querySelector('.a-tm-skeleton')?.remove();
    const shown = messages.filter(visible);
    let incoming = 0;
    const firstPending = pending[0]?.row ?? null;
    shown.forEach((m, i) => {
      const key = keyOf(m);
      const have = rendered.get(m.id);
      if (!have) {
        const row = buildMessage(m);
        if (!firstLoad) row.classList.add('is-new');
        rendered.set(m.id, { row, key });
        stream.insertBefore(row, stream.querySelectorAll('.a-tm-msg:not([data-local])')[i] ?? firstPending);
        if (m.role === 'assistant') incoming++;
      } else if (have.key !== key) {
        if (have.row.classList.contains('a-tm-msg--sys')) have.row.querySelector('.a-tm-sysline')!.textContent = officeLine(m) ?? '';
        else fillRow(have.row, m);
        have.row.dataset.at = String(m.at);
        have.key = key;
        if (m.role === 'assistant') incoming++;
      }
    });
    // Her optimistic messages that have landed in the transcript.
    for (const p of [...pending]) {
      if (p.state === 'failed') continue;
      const hit = shown.find((m) => m.role === 'user' && officeLine(m) === null && m.at >= p.sentAt - 10_000 && (norm(m.text) === norm(p.text) || (!p.text && (m.attachments?.length ?? 0) > 0)));
      if (hit) {
        // The real bubble takes the optimistic one's place without rising in again.
        rendered.get(hit.id)?.row.classList.remove('is-new');
        p.row.remove();
        p.previews.forEach((u) => u && URL.revokeObjectURL(u));
        pending.splice(pending.indexOf(p), 1);
      }
    }
    const introEl = stream.querySelector('.a-tm-intro');
    if (shown.length || pending.length) introEl?.remove();
    else if (!introEl) stream.append(intro());
    regroup();
    if (firstLoad || wasNear) scrollToBottom();
    else if (incoming) pill.hidden = false;
  };

  // ---- Loading ----
  const skel = h(
    'div.a-tm-skeleton',
    { 'aria-busy': 'true', 'aria-label': 'Loading' },
    skeleton('block', { height: 64, width: '62%' }),
    skeleton('block', { height: 44, width: '40%' }),
    skeleton('block', { height: 88, width: '70%' }),
  );
  const skelTimer = setTimeout(() => !loaded && stream.append(skel), 300);
  cleanups.push(() => clearTimeout(skelTimer));

  let inflight = false;
  let stopped = false;
  const load = async () => {
    if (inflight || stopped) return;
    inflight = true;
    try {
      const res = await fetch(`/api/chat?floor=${encodeURIComponent(floor)}&worker=${encodeURIComponent(workerId)}`, { cache: 'no-store' });
      if (stopped) return;
      if (res.status === 401) {
        signInAgain();
        return;
      }
      if (res.status === 404) {
        // No such teammate here, or an office that can't show chats yet: say so, keep the composer.
        if (!info()) return showMissing();
        if (!loaded) patch([]);
        return;
      }
      if (!res.ok) {
        if (!loaded) patch([]);
        return;
      }
      const data = (await res.json()) as ChatResponse;
      if (!stopped) patch(data.messages ?? []);
    } catch {
      if (!loaded && !stopped) patch([]);
    } finally {
      inflight = false;
    }
  };

  const showMissing = () => {
    if (missing) return;
    missing = true;
    // Nobody to ask: stop polling for a transcript that isn't there.
    stopped = true;
    endPeek();
    conversation.replaceChildren(
      aura,
      h(
        'div.a-tm-log.a-tm-log--empty',
        {},
        emptyState({ emoji: '🪑', title: 'This teammate isn’t here', text: 'They may have been sent home from this space.', action: { label: `Go to ${spaceName(floor)}`, variant: 'secondary', href: `#/space/${encodeURIComponent(floor)}` } }),
      ),
      header,
    );
    statusEl.textContent = '';
    moreBtn.hidden = true;
  };

  if (!info()) showMissing();

  const poll = setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, POLL_MS);
  cleanups.push(() => clearInterval(poll));
  const onVisible = () => document.visibilityState === 'visible' && void load();
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
  void load();

  // Status changes: the line, the tail, and a fresh look at the transcript right away.
  let soon: ReturnType<typeof setTimeout> | undefined;
  let lastWorkerSig = '';
  cleanups.push(
    ctx.on('workers', () => {
      const w = info();
      if (!w) {
        if (loaded) showMissing();
        return;
      }
      const sig = JSON.stringify([w.status, w.acked, w.activity, w.name, w.task, w.usage?.cost, w.worktree?.branch, w.pr, w.prOpening, w.model, w.effort]);
      if (sig === lastWorkerSig) return;
      const statusChanged = lastWorkerSig ? JSON.parse(lastWorkerSig)[0] !== w.status : true;
      lastWorkerSig = sig;
      renderStatus();
      if (actions) renderActions();
      if (statusChanged) {
        clearTimeout(soon);
        soon = setTimeout(() => void load(), 250);
      }
    }),
  );
  cleanups.push(() => clearTimeout(soon));
  renderStatus();

  // She's looked at what they finished: mark it seen (the office counts opening it as seen).
  const seenTimer = setTimeout(() => {
    const w = info();
    if (w && w.status === 'done' && !w.acked && document.visibilityState === 'visible') {
      ctx.net.send({ t: 'worker.attach', workerId });
      ctx.net.send({ t: 'worker.detach', workerId });
    }
  }, 1500);
  cleanups.push(() => clearTimeout(seenTimer));

  // =============================================================================================
  // The teammate sheet: role card, model, usage, and actions
  // =============================================================================================
  const actionRow = (o: { glyph: SVGElement; label: string; sub?: string; href?: string; external?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => void }) => {
    const kids = [
      h('span.a-tm-action__icon', {}, o.glyph),
      h('span.a-tm-action__text', {}, h('span.a-tm-action__label', {}, o.label), o.sub ? h('span.a-tm-action__sub', {}, o.sub) : null),
      o.external ? icon('external', 18) : o.href ? icon('forward', 18) : null,
    ];
    const cls = `a-tm-action${o.danger ? ' is-danger' : ''}`;
    const el = o.href
      ? h('a', { class: cls, href: o.href, target: o.external ? '_blank' : undefined, rel: o.external ? 'noopener' : undefined }, ...kids)
      : h('button', { class: cls, type: 'button', disabled: o.disabled }, ...kids);
    el.addEventListener('click', () => {
      if (o.href && !o.external) actions?.handle.close();
      o.onClick?.();
    });
    return el;
  };

  const renderActions = () => {
    if (!actions) return;
    const w = info();
    if (!w) return actions.handle.close();
    const sig = JSON.stringify([w.status, w.acked, w.task, w.usage, w.worktree, w.pr, w.prOpening, w.model, w.effort, ctx.store.project?.remote]);
    if (sig === actions.sig) return;
    actions.sig = sig;
    const s = uiStatus(w);
    const member = w.role ? TEAM_BY_ID.get(w.role) : undefined;
    const model = modelName(w);
    const effort = effortName(w);
    const busy = w.status === 'working' || w.status === 'needs_input' || w.status === 'starting';
    const remote = !!ctx.store.project?.remote;

    const facts: [string, string][] = [];
    if (!plain && model) facts.push(['Model', model]);
    if (!plain && effort) facts.push(['Effort', effort]);
    if (w.usage) {
      if (!plain) facts.push(['Tokens', fmtTokens(tokensOf(w.usage))]);
      facts.push([plain ? 'Cost so far' : 'Cost', w.usage.costKnown === false ? '—' : fmtCost(w.usage.cost)]);
    }

    const card = h(
      'section.a-tm-card',
      { 'aria-label': `About ${w.name}`, 'data-status': s },
      h('div.a-tm-card__hero', {}, h('span.a-tm-halo.a-tm-halo--big', {}, avatar(w, 72)), h('div.a-tm-card__who', {}, h('p.a-tm-card__role', {}, member?.title ?? spaceName(floor)), member ? h('p.a-tm-card__dept', {}, member.group) : null, statusChip(w))),
      member?.pitch ? h('p.a-tm-card__pitch', {}, member.pitch) : null,
      facts.length ? h('dl.a-tm-facts', {}, ...facts.map(([k, v]) => h('div.a-tm-fact', {}, h('dt', {}, k), h('dd', {}, v)))) : null,
      w.usage?.incomplete ? h('p.a-tm-card__note', {}, 'Still counting: some of the history is loading.') : null,
      w.task?.name
        ? h(
            'div.a-tm-card__task',
            {},
            h('span.a-tm-card__over', {}, 'Working on'),
            w.task.name.toLowerCase() !== w.name.toLowerCase() ? h('p.a-tm-card__task-name', {}, w.task.name) : null,
            w.task.summary ? h('p.a-tm-card__task-sum', {}, w.task.summary) : null,
          )
        : null,
    );

    const rows: HTMLElement[] = [];
    if (isResting(w)) {
      rows.push(
        actionRow({
          glyph: icon('wake', 20),
          label: `Wake ${w.name}`,
          sub: 'Picks up where they left off',
          onClick: () => {
            ctx.net.send({ t: 'worker.resume', workerId });
            haptic();
            ctx.toast(`Waking ${w.name}…`);
            actions?.handle.close();
          },
        }),
      );
    }
    if (busy) {
      rows.push(
        actionRow({
          glyph: tmIcon('stop', 20),
          label: 'Stop what they’re doing',
          sub: 'Like pressing Esc at their desk',
          onClick: async () => {
            actions?.handle.close();
            const ok = await confirmDialog({ title: `Stop what ${w.name} is doing?`, body: 'This presses Esc in their terminal. Nothing is lost, and you can tell them what to do next.', action: 'Stop' });
            if (!ok) return;
            ctx.net.send({ t: 'term.input', workerId, data: '\x1b' });
            haptic();
            ctx.toast(`Asked ${w.name} to stop`);
          },
        }),
      );
    }
    rows.push(actionRow({ glyph: tmIcon('terminal', 20), label: plain ? 'Behind the scenes' : 'Terminal', sub: 'Their live screen, with keys to answer it', href: `#/term/${encodeURIComponent(floor)}/${encodeURIComponent(workerId)}` }));
    if (w.worktree) rows.push(actionRow({ glyph: tmIcon('branch', 20), label: 'Changes', sub: plain ? 'What they changed' : w.worktree.branch, href: `#/changes/${encodeURIComponent(floor)}/${encodeURIComponent(workerId)}` }));
    if (w.pr) rows.push(actionRow({ glyph: tmIcon('pr', 20), label: `Pull request #${w.pr.number}`, sub: 'Open it on GitHub', href: w.pr.url, external: true }));
    else if (remote && w.worktree) {
      rows.push(
        actionRow({
          glyph: tmIcon('pr', 20),
          label: w.prOpening ? 'Opening a pull request…' : 'Open a pull request',
          sub: busy ? `When ${w.name} is finished` : `Pushes ${w.worktree.branch} to GitHub`,
          disabled: busy || !!w.prOpening,
          onClick: async () => {
            actions?.handle.close();
            const ok = await confirmDialog({ title: `Open a pull request for ${w.name}’s work?`, body: `This pushes ${w.worktree!.branch} to GitHub and opens a pull request drafted from their task.`, action: 'Open pull request' });
            if (!ok) return;
            ctx.net.send({ t: 'worker.pr', workerId });
            haptic();
            ctx.toast('Opening a pull request…');
          },
        }),
      );
    }
    rows.push(actionRow({ glyph: icon('notes', 20), label: 'What the team knows', sub: `${spaceName(floor)}’s notes`, href: `#/space/${encodeURIComponent(floor)}/notes` }));

    const home = actionRow({
      glyph: icon('rest', 20),
      label: 'Send home',
      sub: 'They stop, and leave their desk',
      danger: true,
      onClick: async () => {
        actions?.handle.close();
        const space = spaceName(floor);
        const ok = await confirmDialog({ title: `Send ${w.name} home?`, body: `They’ll stop what they’re doing and leave ${space}. Their notes stay with the team.`, action: 'Send home', danger: true });
        if (!ok) return;
        ctx.net.send({ t: 'worker.kill', workerId });
        haptic();
        ctx.toast(`${w.name} went home`);
        ctx.go({ view: 'space', floor });
      },
    });

    actions.body.replaceChildren(card, h('div.a-tm-actions', { role: 'group', 'aria-label': 'Actions' }, ...rows), h('div.a-tm-actions', {}, home));
  };

  const openActions = () => {
    const w = info();
    if (!w || actions) return;
    const titleId = `a-tm-sheet-${workerId}`;
    const handle = sheet({
      label: w.name,
      className: 'a-tm-sheet',
      onClose: () => {
        actions = null;
      },
    });
    handle.dialog.setAttribute('aria-labelledby', titleId);
    handle.dialog.removeAttribute('aria-label');
    handle.dialog.style.setProperty('--a-who', w.color);
    const body = h('div.a-sheet__body.a-tm-sheet__body');
    handle.root.append(h('header.a-sheet__head', {}, h('h2.a-sheet__title.a-tm-sheet__title', { id: titleId }, w.name), iconButton('close', 'Close', () => handle.close())), body);
    actions = { handle, body, sig: '' };
    renderActions();
  };
  whoBtn.addEventListener('click', openActions);
  moreBtn.addEventListener('click', openActions);
  cleanups.push(() => actions?.handle.close());

  // =============================================================================================
  // Composer
  // =============================================================================================
  const files: File[] = [];
  const previews = new Map<File, string>();

  const renderChips = () => {
    chips.replaceChildren(
      ...files.map((f, i) => {
        const remove = h('button.a-tm-attach__remove', { type: 'button', 'aria-label': `Remove ${f.name}` }, icon('close', 14));
        remove.addEventListener('click', () => {
          files.splice(i, 1);
          const u = previews.get(f);
          if (u) URL.revokeObjectURL(u);
          previews.delete(f);
          renderChips();
          updateSend();
          field.focus();
        });
        if (isImage(f)) {
          let u = previews.get(f);
          if (!u) previews.set(f, (u = URL.createObjectURL(f)));
          return h('span.a-tm-attach.a-tm-attach--image', {}, h('img', { src: u, alt: f.name }), remove);
        }
        return h('span.a-tm-attach.a-tm-attach--file', {}, icon('file', 18), h('span.a-tm-attach__name', { title: f.name }, f.name), h('span.a-tm-attach__size', {}, fileSize(f.size)), remove);
      }),
    );
  };

  const addFiles = (list: Iterable<File>) => {
    let skipped = 0;
    for (const f of list) {
      if (!isImage(f) && !isPdf(f)) {
        skipped++;
        continue;
      }
      if (f.size > (isPdf(f) ? 15 : 45) * 1024 * 1024) {
        ctx.toast('That file is too big — try one under 15 MB.', 'warn');
        continue;
      }
      files.push(f);
    }
    if (skipped) ctx.toast('Only photos and PDFs can be attached.', 'warn');
    renderChips();
    updateSend();
  };

  const autosize = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight + 2, 6 * 24 + 22)}px`;
  };

  const updateSend = () => {
    const empty = !field.value.trim() && !files.length;
    sendBtn.classList.toggle('is-hidden', empty);
    sendBtn.toggleAttribute('disabled', empty);
    composer.classList.toggle('has-text', !empty);
  };

  field.value = loadDraft(workerId);
  autosize();
  updateSend();
  field.addEventListener('input', () => {
    saveDraft(workerId, field.value);
    autosize();
    updateSend();
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && finePointer()) {
      e.preventDefault();
      void send();
    }
  });
  field.addEventListener('paste', (e) => {
    const got = [...(e.clipboardData?.files ?? [])].filter((f) => isImage(f) || isPdf(f));
    if (!got.length) return;
    e.preventDefault();
    addFiles(got);
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files ?? []);
    fileInput.value = '';
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  // Tapping send keeps the keyboard up for the next message.
  sendBtn.addEventListener('pointerdown', (e) => document.activeElement === field && e.preventDefault());

  // Drag and drop anywhere on the conversation (the paperclip always works too).
  let dragDepth = 0;
  const drop = h('div.a-tm-drop', { 'aria-hidden': 'true' }, icon('attach', 28), 'Drop to attach');
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  conversation.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) conversation.append(drop);
  });
  conversation.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  conversation.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      drop.remove();
    }
  });
  conversation.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.remove();
    addFiles(e.dataTransfer?.files ?? []);
  });

  // ---- Sending ----
  let seq = 0;
  const pendingRow = (p: Pending): HTMLElement => {
    const bubble = h('div.a-tm-bubble.is-sending');
    if (p.text) bubble.append(h('span.a-tm-bubble__text', {}, p.text));
    if (p.files.length) {
      bubble.append(
        h(
          'div.a-tm-files',
          {},
          ...p.files.map((f, i) => (isImage(f) && p.previews[i] ? h('span.a-tm-thumb', {}, h('img', { src: p.previews[i], alt: f.name })) : h('span.a-tm-filechip', {}, icon('file', 18), h('span', {}, f.name)))),
        ),
      );
    }
    return h('div.a-tm-msg.a-tm-msg--me.is-new', { 'data-local': p.localId, 'data-at': p.sentAt }, bubble, h('div.a-tm-meta.is-important', {}, 'Sending…'));
  };

  const setPendingState = (p: Pending, state: Pending['state']) => {
    p.state = state;
    const bubble = p.row.querySelector('.a-tm-bubble')!;
    bubble.classList.toggle('is-sending', state === 'sending');
    bubble.classList.toggle('is-failed', state === 'failed');
    const old = p.row.querySelector(':scope > .a-tm-meta')!;
    let meta: HTMLElement;
    if (state === 'failed') {
      meta = h('button.a-tm-meta.is-important.is-failed', { type: 'button' }, "Didn't send · Tap to retry");
      meta.addEventListener('click', () => void deliver(p));
    } else meta = h('div.a-tm-meta.is-important', {}, state === 'sending' ? 'Sending…' : 'Sent');
    old.replaceWith(meta);
  };

  const deliver = async (p: Pending) => {
    setPendingState(p, 'sending');
    try {
      if (p.files.length && !p.paths) {
        const paths: string[] = [];
        for (const f of p.files) paths.push(await uploadImage(f, floor));
        p.paths = paths;
      }
    } catch {
      setPendingState(p, 'failed');
      ctx.toast('Couldn’t send that. Tap to try again.', 'error');
      return;
    }
    if (!ctx.net.up || ctx.store.floor !== floor) {
      setPendingState(p, 'failed');
      return;
    }
    // Signed by whoever is signed in, by first name.
    const who = firstName();
    const prompt = (p.text || 'Have a look at this.') + attachNote(p.paths ?? [], who && who !== 'Guest' ? who : undefined);
    ctx.net.send({ t: 'worker.prompt', workerId, prompt });
    haptic();
    p.sentAt = Date.now();
    setPendingState(p, 'sent');
    const w = info();
    if (w && isResting(w)) ctx.toast(`Waking ${w.name} with your message`);
    clearTimeout(soon);
    soon = setTimeout(() => void load(), 800);
  };

  const send = async () => {
    const text = field.value.trim();
    if (!text && !files.length) return;
    const picked = files.splice(0);
    const p: Pending = {
      localId: `local-${++seq}`,
      text,
      files: picked,
      previews: picked.map((f) => (isImage(f) ? (previews.get(f) ?? URL.createObjectURL(f)) : '')),
      sentAt: Date.now(),
      state: 'sending',
      row: null as unknown as HTMLElement,
    };
    previews.clear();
    p.row = pendingRow(p);
    pending.push(p);
    stream.querySelector('.a-tm-intro')?.remove();
    stream.append(p.row);
    regroup();
    field.value = '';
    saveDraft(workerId, '');
    autosize();
    renderChips();
    updateSend();
    scrollToBottom();
    await deliver(p);
  };

  // =============================================================================================
  // Phone keyboard (DESIGN §11): the chat takes the visual viewport, so the composer rides the keyboard.
  // =============================================================================================
  cleanups.push(followKeyboard(chatEl, () => stick && scrollToBottom()));
  // A downward drag on the log puts the keyboard away, like Messages.
  let touchY = 0;
  log.addEventListener('touchstart', (e) => (touchY = e.touches[0]?.clientY ?? 0), { passive: true });
  log.addEventListener(
    'touchmove',
    (e) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchY > 24 && document.activeElement === field) field.blur();
    },
    { passive: true },
  );

  // =============================================================================================
  // Wide screens (≥ 1200 px): the conversation list beside the chat
  // =============================================================================================
  let offTeam: (() => void) | null = null;
  const renderAside = () => {
    if (!splitLayout()) return;
    const list = chatEntries();
    if (!list.some((e) => e.id === workerId) && info()) {
      const w = info()!;
      list.unshift({ id: w.id, name: w.name, role: w.role, color: w.color, status: w.status, acked: w.acked, kind: w.kind, activity: w.activity, floor, floorName: spaceName(floor) });
    }
    const multi = new Set(list.map((e) => e.floor)).size > 1;
    aside.replaceChildren(
      h('h2.a-tm-chat__list-title', {}, 'Chats'),
      h('div.a-group', { role: 'list' }, ...list.map((e) => h('div.a-row-wrap', { role: 'listitem' }, chatRow(e, { compact: true, current: e.id === workerId, showSpace: multi })))),
    );
  };
  const mq = matchMedia('(min-width: 1200px)');
  const onSplit = () => {
    if (mq.matches && !offTeam) {
      offTeam = onTeam(renderAside);
      renderAside();
    } else if (!mq.matches && offTeam) {
      offTeam();
      offTeam = null;
      aside.replaceChildren();
    }
  };
  mq.addEventListener('change', onSplit);
  cleanups.push(() => {
    mq.removeEventListener('change', onSplit);
    offTeam?.();
  });
  onSplit();

  // Desktop: straight into typing. Phones: no autofocus (the keyboard would jump the layout).
  if (finePointer() && !phoneLayout()) setTimeout(() => field.focus({ preventScroll: true }), 60);

  return () => {
    stopped = true;
    cleanups.forEach((fn) => fn());
    for (const u of previews.values()) URL.revokeObjectURL(u);
    for (const p of pending) p.previews.forEach((u) => u && URL.revokeObjectURL(u));
  };
}
