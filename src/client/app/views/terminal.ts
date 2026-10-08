// A teammate's live terminal (#/term/<floor>/<worker>): the same screen the 3D office shows at the
// desk (client/ui/terminal.ts), full screen on a phone, with a key bar above the keyboard so setup
// prompts ("trust this folder?", "log in") and permission questions can be answered from the sofa.
//
// How it talks to the office, as the 3D office does: worker.attach gets a term.snapshot (the screen
// so far) and then term.data as it changes; keys go back as term.input; term.resize sizes the shared
// PTY. Opening or resizing only claims the PTY's size when nobody else is watching; typing always
// does (the latest typist wins), so a phone that's only looking never reflows the desk.
//
// This file also holds the few helpers the teammate screens share (chat.ts, changes.ts): a way to
// stop listening to the socket, keyboard tracking for phones, a handful of extra icons, and a quiet
// "peek" at a terminal's screen for the chat's needs-you card.

import type { AppContext, View } from '../context';
import type { Net } from '../../net';
import type { ServerMsg, WorkerInfo } from '../../../shared/protocol';
import { APP_NAME } from '../../../shared/edition';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
import { avatar, backButton, button, h, isResting, setAvatarStatus, spaceColor, spaceName, statusWords, toast, uiStatus } from '../ui';

// =================================================================================================
// Shared helpers
// =================================================================================================

type Tap = (msg: ServerMsg) => void;
const taps = new WeakMap<Net, Set<Tap>>();
const statusTaps = new WeakMap<Net, Set<(up: boolean) => void>>();

/** Every server message while a screen is up. Net can't stop listening, so one tap per Net fans out. */
export function onServer(net: Net, fn: Tap): () => void {
  let set = taps.get(net);
  if (!set) {
    const s = new Set<Tap>();
    taps.set(net, s);
    net.onMessage((m) => s.forEach((f) => f(m)));
    set = s;
  }
  set.add(fn);
  return () => void set!.delete(fn);
}

/** Connection up/down while a screen is up: a reconnect has to attach or watch again. */
export function onNetStatus(net: Net, fn: (up: boolean) => void): () => void {
  let set = statusTaps.get(net);
  if (!set) {
    const s = new Set<(up: boolean) => void>();
    statusTaps.set(net, s);
    net.onStatus((up) => s.forEach((f) => f(up)));
    set = s;
  }
  set.add(fn);
  return () => void set!.delete(fn);
}

export const phoneLayout = () => !matchMedia('(min-width: 700px)').matches;

/**
 * Phones: sizes `el` to the visual viewport so whatever sits at its bottom rides on top of the
 * keyboard (DESIGN §11). Android shrinks the layout viewport itself; iOS needs this. Sets --a-kb
 * (how much the keyboard covers) and body.kb-open while it's up.
 */
export function followKeyboard(el: HTMLElement, onChange?: () => void): () => void {
  const vv = window.visualViewport;
  const reset = () => {
    el.style.height = '';
    el.style.transform = '';
    document.body.classList.remove('kb-open');
    document.documentElement.style.setProperty('--a-kb', '0px');
  };
  const apply = () => {
    if (!vv || !phoneLayout()) reset();
    else {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
      el.style.height = `${vv.height}px`;
      el.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
      document.documentElement.style.setProperty('--a-kb', `${kb}px`);
      document.body.classList.toggle('kb-open', kb > 80);
    }
    onChange?.();
  };
  const mq = matchMedia('(min-width: 700px)');
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  mq.addEventListener('change', apply);
  apply();
  return () => {
    vv?.removeEventListener('resize', apply);
    vv?.removeEventListener('scroll', apply);
    mq.removeEventListener('change', apply);
    reset();
  };
}

/** A small buzz on Android when something was sent (iOS has no vibrate; that's fine). */
export function haptic() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // not allowed here
  }
}

/** Icons the shared set doesn't have (Lucide geometry, same 24 grid and 1.75 stroke). */
const TM_PATHS = {
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/>',
  paste: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  read: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  list: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  helper: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  spark: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  enter: '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
} as const;
export type TmIcon = keyof typeof TM_PATHS;

export function tmIcon(name: TmIcon, size = 20): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `a-icon a-icon--${name}` })) svg.setAttribute(k, v);
  svg.innerHTML = TM_PATHS[name];
  return svg;
}

/** A header back link that's just the chevron in a glass circle (the screen's title says where you are). */
export function tmBack(label: string, ctx: AppContext, fallback: Parameters<AppContext['go']>[0]): HTMLElement {
  const b = backButton(label, ctx.go, fallback);
  b.classList.add('a-tm-back');
  return b;
}

// ---- xterm, loaded on first use: a phone never downloads it unless someone opens a terminal there ----

type XtermModules = { Terminal: typeof XTerminal; FitAddon: typeof XFitAddon; WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon };
let xtermLoading: Promise<XtermModules> | null = null;

export function loadXterm(): Promise<XtermModules> {
  xtermLoading ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links'), import('@xterm/xterm/css/xterm.css')]).then(([x, f, l]) => ({
    Terminal: x.Terminal,
    FitAddon: f.FitAddon,
    WebLinksAddon: l.WebLinksAddon,
  }));
  xtermLoading.catch(() => (xtermLoading = null));
  return xtermLoading;
}

/** "Evening Glass" for a terminal: warm ink on a see-through ground, the ember cursor, the status hues. */
const TERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#E9E5DD',
  cursor: '#F2915F',
  cursorAccent: '#0A0A0C',
  selectionBackground: 'rgba(242,145,95,0.30)',
  black: '#1B1B20',
  red: '#F2787B',
  green: '#8FD6A4',
  yellow: '#F1C872',
  blue: '#7FB9F4',
  magenta: '#CDA4F2',
  cyan: '#6DD8D1',
  white: '#D9D5CD',
  brightBlack: '#77727E',
  brightRed: '#FF9DA0',
  brightGreen: '#ACE8BD',
  brightYellow: '#FFDD97',
  brightBlue: '#A6D0FF',
  brightMagenta: '#E0C2FF',
  brightCyan: '#9DEAE4',
  brightWhite: '#FFFFFF',
  scrollbarSliderBackground: 'rgba(233,229,221,0.12)',
  scrollbarSliderHoverBackground: 'rgba(233,229,221,0.22)',
  scrollbarSliderActiveBackground: 'rgba(233,229,221,0.3)',
};
const MONO = '"Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** Box-drawing borders and blank lines stripped, so a TUI's screen reads as plain lines. */
export function screenLines(term: XTerminal, max = 14): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.viewportY; i < buf.viewportY + term.rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  const clean = lines
    .map((l) => l.replace(/^\s*[│┃║|]\s?/, '').replace(/\s?[│┃║|]\s*$/, '').replace(/\s+$/, ''))
    .filter((l) => !/^\s*[╭╮╰╯─━═┌┐└┘┬┴├┤┼\s]+$/.test(l) || !l.trim());
  // Squash runs of blank lines, and trim the ends.
  const out: string[] = [];
  for (const l of clean) if (l.trim() || (out.length && out[out.length - 1].trim())) out.push(l);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Keep the common indent out of the way on a narrow phone.
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const trimmed = Number.isFinite(indent) && indent > 0 ? out.map((l) => l.slice(indent)) : out;
  return trimmed.slice(-max);
}

/** An answer to a prompt on screen: what it says, the keys that pick it, and a hint of those keys. */
export interface ScreenChoice {
  label: string;
  keys: string[];
  hint: string;
}

/**
 * The choices on a prompt's screen, for answer buttons. Numbered ones ("1. Yes, proceed") are picked
 * by their number; a pointer menu ("❯ No, exit" over "  Yes, I trust this folder") by moving the
 * pointer with the arrow keys and pressing Enter.
 */
export function screenChoices(lines: string[]): ScreenChoice[] {
  const numbered = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*(?:[❯›>▶]\s*)?([1-9])[.)]\s+(.{1,60}?)\s*$/.exec(l);
    if (m && !numbered.has(m[1])) numbered.set(m[1], m[2].replace(/\s{2,}.*$/, ''));
  }
  if (numbered.size) return [...numbered].slice(0, 4).map(([key, label]) => ({ label, keys: [key], hint: key }));
  const at = lines.findIndex((l) => /^\s*[❯›>▶]\s+\S/.test(l));
  if (at < 0) return [];
  const col = /^\s*[❯›>▶]\s+/.exec(lines[at])![0].length;
  const isOption = (l: string | undefined) => !!l && l.trim() !== '' && l.length - l.trimStart().length === col && !/^\s*[❯›>▶]/.test(l);
  let first = at;
  while (isOption(lines[first - 1]) && at - first < 5) first--;
  let last = at;
  while (isOption(lines[last + 1]) && last - first < 5) last++;
  if (first === last) return [];
  const out: ScreenChoice[] = [];
  for (let i = first; i <= last; i++) {
    const label = lines[i].replace(/^\s*[❯›>▶]?\s*/, '').replace(/\s{2,}.*$/, '').slice(0, 60);
    const steps = i - at;
    const arrow = steps > 0 ? '\x1b[B' : '\x1b[A';
    out.push({ label, keys: [...Array.from({ length: Math.abs(steps) }, () => arrow), '\r'], hint: steps === 0 ? '↵' : steps > 0 ? '↓' : '↑' });
  }
  return out;
}

/**
 * A quiet look at a teammate's screen, without showing a terminal: attaches (which doesn't count as
 * answering a question), keeps an unopened xterm up to date, and reports its lines as they change.
 */
export function peekTerminal(net: Net, workerId: string, onLines: (lines: string[]) => void): () => void {
  let stopped = false;
  let term: XTerminal | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early: ServerMsg[] = [];
  const report = () => {
    clearTimeout(timer);
    timer = setTimeout(() => term && !stopped && onLines(screenLines(term)), 120);
  };
  const handle = (msg: ServerMsg) => {
    if (!term) return void early.push(msg);
    if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
      term.reset();
      term.resize(Math.max(20, msg.cols), Math.max(5, msg.rows));
      term.write(msg.data, report);
    } else if (msg.t === 'term.data' && msg.workerId === workerId) term.write(msg.data, report);
  };
  const off = onServer(net, (m) => (m.t === 'term.snapshot' || m.t === 'term.data') && m.workerId === workerId && handle(m));
  const offUp = onNetStatus(net, (up) => up && net.send({ t: 'worker.attach', workerId }));
  net.send({ t: 'worker.attach', workerId });
  void loadXterm()
    .then(({ Terminal }) => {
      if (stopped) return;
      term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 200 });
      early.splice(0).forEach(handle);
    })
    .catch(() => onLines([]));
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
    offUp();
    net.send({ t: 'worker.detach', workerId });
    term?.dispose();
  };
}

/** Says the office sent a key for her, softly. */
export function sentKeyToast(name: string, label: string) {
  haptic();
  toast(`Sent ${label} to ${name}`);
}

// =================================================================================================
// The terminal screen
// =================================================================================================

const FONT_KEY = 'hearth.term.font';
const FONT_MIN = 8;
const FONT_MAX = 22;
const readFont = () => {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (n >= FONT_MIN && n <= FONT_MAX) return n;
  } catch {
    // storage blocked
  }
  return phoneLayout() ? 12 : 14;
};
const saveFont = (n: number) => {
  try {
    localStorage.setItem(FONT_KEY, String(n));
  } catch {
    // storage blocked
  }
};

interface Key {
  label: string;
  aria: string;
  /** What to send, or a function of the terminal's modes (arrows differ in application-cursor mode). */
  data: string | ((appCursor: boolean) => string);
  icon?: TmIcon;
  wide?: boolean;
  accent?: boolean;
}

const arrow = (c: string) => (app: boolean) => (app ? `\x1bO${c}` : `\x1b[${c}`);
const KEYS: Key[] = [
  { label: 'Esc', aria: 'Escape', data: '\x1b' },
  { label: 'Tab', aria: 'Tab', data: '\t' },
  { label: '', aria: 'Up arrow', data: arrow('A'), icon: 'up' },
  { label: '', aria: 'Down arrow', data: arrow('B'), icon: 'down' },
  { label: '', aria: 'Left arrow', data: arrow('D'), icon: 'left' },
  { label: '', aria: 'Right arrow', data: arrow('C'), icon: 'right' },
  { label: 'Enter', aria: 'Enter', data: '\r', icon: 'enter', wide: true, accent: true },
  { label: '^C', aria: 'Control C', data: '\x03' },
  { label: '1', aria: '1', data: '1' },
  { label: '2', aria: '2', data: '2' },
  { label: '3', aria: '3', data: '3' },
  { label: 'y', aria: 'y', data: 'y' },
  { label: 'n', aria: 'n', data: 'n' },
];

export const terminalView: View = (root, ctx, route) => {
  if (route.view !== 'terminal') return;
  const { floor, worker: workerId } = route;
  const info = (): WorkerInfo | undefined => ctx.store.workers.get(workerId);
  const cleanups: (() => void)[] = [];
  document.body.classList.add('a-tm-immersive');
  cleanups.push(() => document.body.classList.remove('a-tm-immersive'));

  const w0 = info();
  if (!w0) {
    root.append(
      h(
        'div.a-tm-term.a-tm-term--missing',
        {},
        h('header.a-tm-term__bar', {}, tmBack(spaceName(floor), ctx, { view: 'space', floor })),
        h('div.a-tm-term__gone', {}, h('p.a-tm-serif', {}, 'This teammate isn’t here'), h('p', {}, 'They may have been sent home.'), button({ label: `Go to ${spaceName(floor)}`, variant: 'secondary', href: `#/space/${encodeURIComponent(floor)}` })),
      ),
    );
    return () => cleanups.forEach((f) => f());
  }
  document.title = `${w0.name} · Terminal · ${APP_NAME}`;

  // ---- Chrome ----
  const who = avatar(w0, 32);
  const nameEl = h('span.a-tm-term__name', {}, w0.name);
  const statusEl = h('span.a-tm-term__status', { 'aria-live': 'polite' });
  const fontDown = h('button.a-tm-term__font', { type: 'button', 'aria-label': 'Smaller text', title: 'Smaller text' }, h('span', { style: 'font-size:12px' }, 'A'));
  const fontUp = h('button.a-tm-term__font', { type: 'button', 'aria-label': 'Bigger text', title: 'Bigger text' }, h('span', { style: 'font-size:17px' }, 'A'));
  const chatLink = h('a.a-tm-term__chip', { href: `#/chat/${encodeURIComponent(floor)}/${encodeURIComponent(workerId)}`, 'aria-label': `Chat with ${w0.name}`, title: 'Chat' }, tmIcon('chat', 18));
  const bar = h(
    'header.a-tm-term__bar',
    {},
    tmBack(w0.name, ctx, { view: 'chat', floor, worker: workerId }),
    h('div.a-tm-term__who', {}, who, h('div.a-tm-term__who-text', {}, nameEl, statusEl)),
    h('div.a-tm-term__tools', { role: 'group', 'aria-label': 'Text size' }, fontDown, fontUp),
    chatLink,
  );

  const host = h('div.a-tm-term__host');
  const loading = h('div.a-tm-term__loading', { 'aria-hidden': 'true' }, ...[62, 84, 45, 70, 30].map((w) => h('span', { style: `width:${w}%` })));
  const fitChip = h('button.a-tm-term__fit', { type: 'button', hidden: true }, 'Fit to my screen');
  const hint = h('div.a-tm-term__hint', { hidden: true });
  const frame = h('div.a-tm-term__frame', {}, host, loading);
  const stage = h('div.a-tm-term__stage', {}, hint, frame, fitChip);

  const keyRow = h('div.a-tm-keys', { role: 'toolbar', 'aria-label': 'Keys' });
  const cmd = h('input.a-tm-cmd__field', {
    type: 'text',
    placeholder: 'Type a command…',
    'aria-label': 'Type a command, sent with Enter',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'send',
  }) as HTMLInputElement;
  const cmdSend = h('button.a-tm-cmd__send', { type: 'submit', 'aria-label': 'Send with Enter', disabled: true }, tmIcon('enter', 18));
  const cmdForm = h('form.a-tm-cmd', { 'aria-label': 'Command line' }, h('span.a-tm-cmd__prompt', { 'aria-hidden': 'true' }, '›'), cmd, cmdSend);
  const wakeSlot = h('div.a-tm-term__wake');
  const dock = h('div.a-tm-term__dock', {}, wakeSlot, keyRow, cmdForm);
  const el = h('div.a-tm-term', { style: `--a-who:${w0.color};--a-space:${spaceColor(floor)}` }, h('div.a-tm-term__aura', { 'aria-hidden': 'true' }), bar, stage, dock);
  root.append(el);
  cleanups.push(followKeyboard(el, () => requestAnimationFrame(() => sendSize())));

  // ---- The terminal ----
  let term: XTerminal | null = null;
  let fit: XFitAddon | null = null;
  let ready = false;
  let lastSentSize = '';
  let fontSize = readFont();
  const early: ServerMsg[] = [];

  /** Sends keys as hers (the office records who typed), claiming the PTY's size for this screen. */
  const sendData = (data: string) => {
    sendSize(true);
    ctx.net.send({ t: 'term.input', workerId, data });
  };

  /** Fits the terminal to this screen, and tells the office when that's our call to make (see the top). */
  const sendSize = (claim = false) => {
    if (!term || !fit || !ready) return;
    const w = info();
    const others = (w?.viewers.length ?? 0) > 1;
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = fit.proposeDimensions();
    } catch {
      return;
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.max(20, dims.cols);
    const rows = Math.max(6, dims.rows);
    if (others && !claim) {
      // Someone else is here: show the PTY as it is, and offer to take it over.
      if (w && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
      fitChip.hidden = !w || w.cols <= cols;
      return;
    }
    fitChip.hidden = true;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    const key = `${cols}x${rows}`;
    if (w && (w.cols !== cols || w.rows !== rows) && key !== lastSentSize) {
      lastSentSize = key;
      ctx.net.send({ t: 'term.resize', workerId, cols, rows });
    }
  };

  const setFont = (n: number, claim = true) => {
    fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
    saveFont(fontSize);
    fontDown.toggleAttribute('disabled', fontSize <= FONT_MIN);
    fontUp.toggleAttribute('disabled', fontSize >= FONT_MAX);
    if (term) term.options.fontSize = fontSize;
    requestAnimationFrame(() => sendSize(claim));
  };
  fontDown.addEventListener('click', () => setFont(fontSize - 1));
  fontUp.addEventListener('click', () => setFont(fontSize + 1));
  fitChip.addEventListener('click', () => sendSize(true));

  const onMsg = (msg: ServerMsg) => {
    if (!('workerId' in msg) || msg.workerId !== workerId) return;
    if (msg.t !== 'term.snapshot' && msg.t !== 'term.data') return;
    if (!term) return void early.push(msg);
    if (msg.t === 'term.data') term.write(msg.data);
    else {
      term.reset();
      term.resize(Math.max(20, msg.cols), Math.max(5, msg.rows));
      term.write(msg.data, () => {
        ready = true;
        loading.remove();
        sendSize();
        term?.scrollToBottom();
      });
    }
  };
  cleanups.push(onServer(ctx.net, onMsg));
  cleanups.push(onNetStatus(ctx.net, (up) => up && ctx.net.send({ t: 'worker.attach', workerId })));
  ctx.net.send({ t: 'worker.attach', workerId });
  cleanups.push(() => ctx.net.send({ t: 'worker.detach', workerId }));

  let disposed = false;
  cleanups.push(() => {
    disposed = true;
    term?.dispose();
  });
  void (async () => {
    let mods: XtermModules;
    try {
      mods = await loadXterm();
      // The mono face has to be in before xterm measures a cell, or the columns come out wrong.
      await Promise.race([document.fonts?.load(`${fontSize}px "Geist Mono"`), new Promise((r) => setTimeout(r, 800))]).catch(() => {});
    } catch {
      loading.replaceChildren(h('p', {}, 'Couldn’t open the terminal right now. Try again in a moment.'));
      return;
    }
    if (disposed) return;
    const t = new mods.Terminal({
      fontFamily: MONO,
      fontSize,
      lineHeight: 1.15,
      letterSpacing: 0,
      theme: TERM_THEME,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const f = new mods.FitAddon();
    t.loadAddon(f);
    t.loadAddon(new mods.WebLinksAddon());
    t.open(host);
    term = t;
    fit = f;
    setFont(fontSize, false);
    // Focus reports (the terminal telling the program it gained or lost focus) aren't her typing.
    t.onData((data) => (data === '\x1b[I' || data === '\x1b[O' ? ctx.net.send({ t: 'term.input', workerId, data }) : sendData(data)));
    t.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && e.key === ']'));
    early.splice(0).forEach(onMsg);
    const ro = new ResizeObserver(() => sendSize());
    ro.observe(host);
    cleanups.push(() => ro.disconnect());
    if (!phoneLayout()) setTimeout(() => t.focus(), 60);
  })();

  // Pinch to change the text size (two fingers on the screen), like zooming a photo.
  let pinch: { d: number; font: number } | null = null;
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  frame.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: dist(e), font: fontSize };
  }, { passive: true });
  frame.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const next = Math.round(pinch.font * (dist(e) / pinch.d));
    if (next !== fontSize) {
      fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, next));
      if (term) term.options.fontSize = fontSize;
    }
  }, { passive: false });
  frame.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      setFont(fontSize);
    }
  }, { passive: true });

  // ---- Keys ----
  for (const k of KEYS) {
    const b = h('button.a-tm-key', { type: 'button', 'aria-label': k.aria, class: `${k.wide ? 'is-wide' : ''} ${k.accent ? 'is-accent' : ''}` }, k.icon ? tmIcon(k.icon, 18) : null, k.label ? h('span', {}, k.label) : null);
    // pointerdown keeps the phone keyboard (and xterm's focus) where it was.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const data = typeof k.data === 'function' ? k.data(!!term?.modes.applicationCursorKeysMode) : k.data;
      haptic();
      sendData(data);
    });
    keyRow.append(b);
  }
  const pasteBtn = h('button.a-tm-key.is-wide', { type: 'button', 'aria-label': 'Paste' }, tmIcon('paste', 18), h('span', {}, 'Paste'));
  pasteBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  pasteBtn.addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast(`Your browser didn’t let ${APP_NAME} read the clipboard. Long-press the command line and paste there.`, 'warn');
      return;
    }
    if (!text) return toast('The clipboard is empty.');
    haptic();
    // xterm wraps it as a bracketed paste when the program asked for that, then onData sends it.
    if (term) term.paste(text);
    else sendData(text);
  });
  keyRow.append(pasteBtn);

  // ---- Command line: the whole line, then Enter (a beat later, so a TUI takes it as typed, not pasted) ----
  cmd.addEventListener('input', () => cmdSend.toggleAttribute('disabled', !cmd.value));
  cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = cmd.value;
    if (!text) return;
    haptic();
    if (term?.modes.bracketedPasteMode) sendData(`\x1b[200~${text}\x1b[201~`);
    else sendData(text);
    setTimeout(() => sendData('\r'), 120);
    cmd.value = '';
    cmdSend.setAttribute('disabled', '');
  });

  // ---- Status ----
  let sig = '';
  const renderStatus = () => {
    const w = info();
    if (!w) {
      ctx.go({ view: 'space', floor });
      return;
    }
    const s = uiStatus(w);
    const next = `${w.status}|${w.acked}|${w.activity ?? ''}|${w.name}`;
    if (next === sig) return;
    sig = next;
    setAvatarStatus(who, s);
    nameEl.textContent = w.name;
    statusEl.dataset.status = s;
    statusEl.replaceChildren(h('span.a-tm-dot', { 'aria-hidden': 'true' }), statusWords(w));
    const setup = s === 'needs' && /setup|trust|log ?in|signed in|\/hooks/i.test(w.activity ?? '');
    hint.hidden = s !== 'needs';
    hint.replaceChildren(
      h('span.a-tm-dot', { 'aria-hidden': 'true' }),
      setup ? 'A setup question. Answer with the keys below.' : 'Waiting for your answer. Use the keys below.',
    );
    wakeSlot.replaceChildren();
    if (isResting(w)) {
      wakeSlot.append(
        h('p', {}, `${w.name} is resting.`),
        button({
          label: 'Wake',
          icon: 'wake',
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            ctx.net.send({ t: 'worker.resume', workerId });
            haptic();
            toast(`Waking ${w.name}…`);
          },
        }),
      );
    }
  };
  cleanups.push(ctx.on('workers', () => {
    renderStatus();
    sendSize();
  }));
  renderStatus();

  return () => cleanups.forEach((f) => f());
};
