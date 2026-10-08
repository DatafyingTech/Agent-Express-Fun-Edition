// The meeting room (the Meetings segment of a space): the same room as the 3D office's
// (ui/meeting.ts status window, world/meeting.ts board, ui/minutes.ts reader), laid out for a phone.
//
//   Running: the pattern and question, a round table seen from above with each chair's state (up
//            next, handed over, on it, written), the round in the middle of the table, the token
//            budget, the write-up as it's being written, each chair's terminal, and Stop.
//   Done:    Sonnet's recap as the hero (a shimmer while it's being written), "Read the whole
//            meeting" (the file the office saved in reports/meetings/, in a full-screen reader),
//            Clear the room, Call another.
//   Empty:   an invitation to call one, with the ways of meeting in plain words.
//   Earlier meetings under all of it, each with its recap's headline and Read.
//
// The meeting updates many times a minute while it runs (tokens, turns, the write-up), so each part
// of the screen is kept in its own slot and only redrawn when what it shows changed: the table's
// rings don't restart, an opened write-up stays open, and the reader's scroll doesn't jump.
// Also exports the pattern words, glyphs and the reader for the Call a meeting sheet (views/meeting.ts).

import { filePicker } from '../filepicker';
import type { View } from '../context';
import type { Meeting, MeetingFollowup, MeetingMessage, MeetingPattern, MeetingRecord, MeetingReply, MeetingSeat, MeetingTurn, WorkerInfo } from '../../../shared/protocol';
import { fmtCost, fmtTokens } from '../../../shared/protocol';
import { MEETING_PATTERNS, meetingRecord, meetingSpend } from '../../../shared/meetings';
import { TEAM_BY_ID } from '../../../shared/team';
import { markdown } from '../../ui/markdown';
import { icon } from '../icons';
import { avatar, button, clockTime, confirmDialog, h, hrefOf, iconButton, plural, sheet, shortDate, signInAgain, skeleton, timeAgo, uiStatus, type ButtonOpts, type UiStatus } from '../ui';

// =================================================================================================
// Shared with the Call a meeting sheet: the patterns in plain words, and a few glyphs of our own
// =================================================================================================

/** Each way of meeting, in words anyone gets: what happens, not how it's wired. */
export const PATTERN_WORDS: Record<MeetingPattern, { name: string; line: string; short: string }> = {
  talk: {
    name: 'Conversation',
    short: 'Talk it over with the table',
    line: 'Talk with everyone at the table, or just a few of them. No rounds: it runs until you end it, and everyone keeps up through a shared memory.',
  },
  debate: {
    name: 'Debate',
    short: 'Talk it through and decide',
    line: 'Everyone puts an idea on the table, then they pick holes in each other’s. In the last round the lead writes down the decision.',
  },
  lead: {
    name: 'Lead & team',
    short: 'Split a job and pull it together',
    line: 'The lead splits the job into parts, each person takes one, and the lead pulls the work together and writes it up.',
  },
  mapreduce: {
    name: 'Divide & combine',
    short: 'The same job over many pieces',
    line: 'The same job done over many pieces at once (files, issues, tickers), then the lead combines what everyone found.',
  },
  redblue: {
    name: 'Red / blue',
    short: 'Attack a plan, fix what’s real',
    line: 'One person attacks the plan looking for holes, the other fixes what holds up, round after round, then writes it up.',
  },
  review: {
    name: 'Review panel',
    short: 'Review a pull request together',
    line: 'Each reviewer reads a pull request through their own lens; the lead merges it all into one review, posted on GitHub.',
  },
};

/** Our own strokes (Lucide geometry, ISC), on the same 24 grid and 1.75 stroke as icons.ts. */
const GLYPHS = {
  talk: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/>',
  debate: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  lead: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
  mapreduce: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  redblue: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 22V2"/>',
  review: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  terminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  pen: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  pull: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  table: '<ellipse cx="12" cy="12" rx="7" ry="4"/><circle cx="12" cy="4" r="1.5"/><circle cx="12" cy="20" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="21" cy="12" r="1.5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  dice: '<rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 8h.01"/><path d="M16 8h.01"/><path d="M12 12h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  reply: '<path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  hangup: '<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName, size = 20): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(k, String(v));
  }
  svg.setAttribute('class', `a-icon a-mtg-glyph a-mtg-glyph--${name}`);
  svg.innerHTML = GLYPHS[name];
  return svg;
}

/** The pattern's mark on its own soft tile. */
export function patternTile(p: MeetingPattern, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  return h('span.a-mtg-ptile', { 'data-pattern': p, 'data-size': size, 'aria-hidden': 'true' }, glyph(p, size === 'lg' ? 26 : size === 'sm' ? 16 : 20));
}

/** "2 to 5 people · 2 to 4 rounds", "Exactly 2 people · always 3 rounds". */
export function patternBounds(p: MeetingPattern): string {
  const d = MEETING_PATTERNS[p];
  if (p === 'talk') return `${d.seats.min} to ${d.seats.max} people · no rounds`;
  const seats = d.seats.min === d.seats.max ? `Exactly ${d.seats.min} people` : `${d.seats.min} to ${d.seats.max} people`;
  const rounds = d.rounds.min === d.rounds.max ? `always ${plural(d.rounds.min, 'round')}` : `${d.rounds.min} to ${d.rounds.max} rounds`;
  return `${seats} · ${rounds}`;
}

/** "Head of Research", "A and B", "A, B and C". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** ui.ts's button, plus classes of our own (its `attrs` would replace the a-btn ones). */
export function btn(o: ButtonOpts & { cls?: string }): HTMLButtonElement | HTMLAnchorElement {
  const el = button(o);
  if (o.cls) el.classList.add(...o.cls.split(' '));
  return el;
}

/** A little buzz on a key confirmation, where the phone can. */
export function buzz() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // not allowed here
  }
}

/** Who sits in a seat, as far as we know: the roster member, else the helper named by their job. */
export function seatWho(s: MeetingSeat, workers: Map<string, WorkerInfo>): { name: string; emoji?: string; color?: string; worker?: WorkerInfo; helper: boolean } {
  const member = s.member ? TEAM_BY_ID.get(s.member) : undefined;
  const worker = s.workerId ? workers.get(s.workerId) : undefined;
  return { name: member?.name ?? s.workerName ?? s.role, emoji: member?.emoji, color: worker?.color ?? member?.color, worker, helper: !member };
}

/** A recap's first heading is its headline; the rest is the body. */
export function splitRecap(md: string): { headline?: string; body: string } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0 && /^#{1,3}\s+/.test(lines[i])) return { headline: lines[i].replace(/^#{1,3}\s+/, '').trim(), body: lines.slice(i + 1).join('\n').trim() };
  return { body: md.trim() };
}

/** Markdown in the meeting room's reading type. */
export function prose(src: string, extra = ''): HTMLElement {
  const el = h('div.a-prose.a-mtg-prose', { class: extra || undefined });
  if (src.trim()) el.append(markdown(src));
  return el;
}

/** A name without the 📱 the app adds to whoever is on a phone. */
const stripPhone = (s: string) => s.replace(/\s*📱\s*$/u, '');

/** "Risk Manager", "Risk Manager & Critic", "Risk Manager, Critic & Chart Artist". */
function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** "Today", "Yesterday" or the date. */
function dayWord(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return shortDate(at);
}

/** The conversation room inside the Meetings segment (see makeTalk). */
interface TalkRoom {
  el: HTMLElement;
  paint(m: Meeting): void;
  destroy(): void;
}

const EMOJI_LEAD =/^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s]+/u;

// =================================================================================================
// The reader: the whole meeting, full screen
// =================================================================================================

/**
 * Opens the file the office saved for a meeting (recap, question, final write-up, and what each
 * agent said, round by round) in a full-screen sheet, with a strip of its sections to jump between
 * and a thin progress line as you read.
 */
export function openReader(floor: string, saved: string, title: string, meta?: string) {
  const url = `/api/reports/file?floor=${encodeURIComponent(floor)}&path=${encodeURIComponent(saved)}`;
  const s = sheet({ label: 'The whole meeting', className: 'a-mtg-reader' });
  const titleId = `a-mtg-reader-title-${Date.now().toString(36)}`;
  s.dialog.setAttribute('aria-labelledby', titleId);
  s.dialog.removeAttribute('aria-label');
  const progress = h('span.a-mtg-reader__progress', { 'aria-hidden': 'true' });
  const toc = h('nav.a-mtg-reader__toc', { 'aria-label': 'Sections', hidden: true });
  const body = h(
    'div.a-sheet__body.a-mtg-reader__body',
    { tabindex: '-1' },
    h('div.a-mtg-reader__loading', { 'aria-busy': 'true', 'aria-label': 'Loading the meeting' }, skeleton('line', { width: '70%' }), skeleton('line', { width: '92%' }), skeleton('line', { width: '84%' }), skeleton('line', { width: '60%' }), skeleton('block', { height: 120 }), skeleton('line', { width: '88%' })),
  );
  const open = h('a.a-icon-btn', { href: url, target: '_blank', rel: 'noopener', 'aria-label': 'Open the file in a new tab', title: 'Open the file in a new tab' }, icon('external', 22));
  s.root.append(
    h(
      'header.a-sheet__head.a-mtg-reader__head',
      {},
      h('div.a-mtg-reader__titles', {}, h('p.a-mtg-over', {}, glyph('book', 14), 'The whole meeting'), h('h2.a-sheet__title.a-mtg-reader__title', { id: titleId }, title), meta ? h('p.a-mtg-reader__meta', {}, meta) : null),
      open,
      iconButton('close', 'Close', () => s.close()),
    ),
    toc,
    progress,
    body,
  );
  body.addEventListener(
    'scroll',
    () => {
      const max = body.scrollHeight - body.clientHeight;
      progress.style.setProperty('--p', String(max > 0 ? Math.min(1, body.scrollTop / max) : 0));
    },
    { passive: true },
  );
  void (async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 401) return signInAgain();
      if (!res.ok) throw new Error(res.status === 404 ? 'That meeting’s notes aren’t there any more.' : 'Couldn’t open the meeting’s notes just now. Try again in a moment.');
      const text = await res.text();
      // The file's own first heading repeats the title in the header, so it starts at the line under it.
      const src = text.replace(/^\s*#\s+[^\n]*\n/, '');
      const doc = prose(src, 'a-mtg-prose--reader');
      body.replaceChildren(h('article.a-mtg-reader__doc', {}, doc), h('p.a-mtg-reader__foot', {}, 'Saved as ', h('code', {}, saved), ', and kept in Reports.'));
      // The sections, for the strip: the file's ## parts and each ### turn.
      const heads = [...doc.querySelectorAll<HTMLElement>('h2, h3')].filter((x) => x.textContent?.trim());
      heads.forEach((el, i) => (el.id = `a-mtg-sec-${i}`));
      // The office marks its own sections with an emoji (📋 Recap, 📄 Final write-up…); the agents'
      // headings inside the write-up don't get a chip, or the strip would be as long as the file.
      const own = heads.filter((el) => el.tagName === 'H2' && EMOJI_LEAD.test(el.textContent!));
      const chips = heads
        .filter((el) => (own.length ? own.includes(el) : el.tagName === 'H2') || (el.tagName === 'H3' && /^Round\b/i.test(el.textContent!.replace(EMOJI_LEAD, ''))))
        .slice(0, 24)
        .map((el) => {
          const label = el.textContent!.replace(EMOJI_LEAD, '').replace(/\s*\(.*\)\s*$/, '').trim();
          return h('button.a-mtg-chip', { type: 'button', 'data-level': el.tagName === 'H2' ? '2' : '3', onclick: () => el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }, label.length > 34 ? `${label.slice(0, 33)}…` : label);
        });
      if (chips.length > 1) {
        toc.replaceChildren(...chips);
        toc.hidden = false;
      }
    } catch (err) {
      body.replaceChildren(h('div.a-mtg-reader__error', {}, h('p', {}, (err as Error).message || 'Couldn’t open the meeting’s notes just now.'), h('a.a-btn.a-btn--secondary.a-btn--md', { href: url, target: '_blank', rel: 'noopener' }, 'Open the file instead')));
    }
  })();
  return s;
}

// =================================================================================================
// The segment
// =================================================================================================

const TURN_WORDS: Record<MeetingTurn['state'] | 'idle', string> = { waiting: 'Up next', sent: 'Handed over', working: 'On it', done: 'Written', idle: 'Listening' };

/** Replaces a slot's content only when its key changes. */
function keep(slot: HTMLElement, key: string, make: () => Node | null) {
  if (slot.dataset.k === key) return;
  slot.dataset.k = key;
  const n = make();
  slot.replaceChildren(...(n ? [n] : []));
}

const pct = (m: Pick<Meeting, 'tokens' | 'budget'>) => Math.min(1, m.tokens / Math.max(1, m.budget));

/** The spend as a bar: the tokens so far against the budget, with the cost when it's known. */
function budgetBar(m: Meeting, running: boolean): HTMLElement {
  const f = pct(m);
  const level = f > 0.9 ? 'hot' : f > 0.7 ? 'warm' : 'ok';
  const cost = m.costKnown ? fmtCost(m.cost) : m.cost > 0 ? `${fmtCost(m.cost)}+` : '';
  return h(
    'div.a-mtg-budget',
    { 'data-level': level, 'data-running': running ? 'true' : undefined },
    h('div.a-mtg-budget__top', {}, h('span.a-mtg-budget__label', {}, running ? 'Token budget' : 'What it used'), h('span.a-mtg-budget__nums', {}, h('b', {}, fmtTokens(m.tokens)), ` of ${fmtTokens(m.budget)}`)),
    h(
      'div.a-mtg-budget__track',
      { role: 'progressbar', 'aria-label': 'Token budget used', 'aria-valuemin': '0', 'aria-valuemax': String(m.budget), 'aria-valuenow': String(Math.min(m.tokens, m.budget)), 'aria-valuetext': `${fmtTokens(m.tokens)} of ${fmtTokens(m.budget)} tokens` },
      h('span.a-mtg-budget__fill', { style: `--f:${f.toFixed(4)}` }),
    ),
    h('div.a-mtg-budget__foot', {}, h('span', {}, `${Math.round(f * 100)}% used`), cost ? h('span', {}, `${cost}${running ? ' so far' : ''}`) : null),
  );
}

export const meetingsView: View = (root, ctx, route) => {
  if (!('floor' in route)) return;
  const floor = route.floor;
  const callHref = hrefOf({ view: 'meeting', floor });

  const now = h('div.a-mtg-now');
  const past = h('section.a-mtg-past', { 'aria-labelledby': 'a-mtg-past-h' });
  root.append(h('div.a-mtg', {}, now, past));

  let mode = '';
  /** The fixed slots of the room's current look. */
  let slots: Record<string, HTMLElement> = {};
  /** The write-up card stays opened (or not) across updates. */
  let writeupOpen = false;
  /** The conversation on screen, when the meeting is one. */
  let talk: TalkRoom | null = null;

  const current = (): Meeting | null => {
    const m = ctx.store.meeting.current;
    return m && !m.cleared ? m : null;
  };

  const build = (want: string, m: Meeting | null) => {
    mode = want;
    slots = {};
    talk?.destroy();
    talk = null;
    const slot = (name: string, tag: 'div' | 'section' = 'div') => (slots[name] = h(`${tag}.a-mtg-slot`, { 'data-slot': name }) as HTMLElement);
    if (!m) {
      now.replaceChildren(emptyRoom());
      return;
    }
    if (m.pattern === 'talk') {
      talk = makeTalk(m);
      now.replaceChildren(talk.el);
      return;
    }
    if (m.status === 'running') {
      now.replaceChildren(
        h('article.a-mtg-live', { 'aria-labelledby': 'a-mtg-title', style: '--i:0' }, slot('head'), slot('table'), slot('budget')),
        slot('followups', 'section'),
        slot('writeup', 'section'),
        slot('seats', 'section'),
        slot('actions'),
      );
    } else {
      now.replaceChildren(slot('head'), slot('recap'), slot('followups', 'section'), slot('follow'), slot('seats', 'section'), slot('budget'), slot('output'), slot('actions'));
    }
  };

  // ---- Empty room ---------------------------------------------------------------------------------
  const emptyRoom = () => {
    // A conversation is the invitation; the structured meetings are listed under it.
    const ways = (Object.keys(PATTERN_WORDS) as MeetingPattern[]).filter((p) => p !== 'talk' && (p !== 'review' || !!ctx.store.project?.remote));
    return h(
      'div.a-mtg-empty',
      {},
      h(
        'section.a-mtg-invite',
        { 'aria-labelledby': 'a-mtg-invite-h' },
        h('div.a-mtg-invite__table', { 'aria-hidden': 'true' }, h('span.a-mtg-invite__oval'), ...[0, 1, 2, 3, 4].map((i) => h('span.a-mtg-invite__chair', { style: `--k:${i}` }))),
        h('p.a-mtg-over', {}, 'The meeting room'),
        h('h2.a-mtg-invite__title', { id: 'a-mtg-invite-h' }, 'The room is ', h('em', {}, 'free'), '.'),
        h('p.a-mtg-invite__text', {}, 'Bring teammates to the table and talk it over. Talk to all of them or just a few: they keep up with each other through a shared memory, and when you’re done you get a short recap.'),
        (() => {
          const cta = btn({ label: 'Start a conversation', icon: 'add', variant: 'primary', size: 'lg', href: callHref, cls: 'a-mtg-invite__cta' });
          cta.addEventListener('click', (e) => rememberPattern(e, 'talk'));
          return cta;
        })(),
      ),
      h(
        'section.a-mtg-ways',
        { 'aria-labelledby': 'a-mtg-ways-h' },
        h('h3.a-mtg-section-h', { id: 'a-mtg-ways-h' }, 'Or run a structured meeting'),
        h(
          'div.a-mtg-ways__list',
          {},
          ...ways.map((p, i) =>
            h(
              'a.a-mtg-way',
              { href: callHref, style: `--i:${Math.min(i, 5)}`, onclick: (e: Event) => rememberPattern(e, p) },
              patternTile(p, 'md'),
              h('span.a-mtg-way__text', {}, h('span.a-mtg-way__name', {}, PATTERN_WORDS[p].name), h('span.a-mtg-way__line', {}, PATTERN_WORDS[p].line), h('span.a-mtg-way__meta', {}, patternBounds(p))),
              h('span.a-mtg-way__chev', { 'aria-hidden': 'true' }, icon('forward', 18)),
            ),
          ),
        ),
      ),
    );
  };

  /** A way-of-meeting card opens the sheet on that pattern (the sheet reads it once, then forgets). */
  const rememberPattern = (e: Event, p: MeetingPattern) => {
    e.preventDefault();
    try {
      sessionStorage.setItem(`hearth.mtg.pattern.${floor}`, p);
    } catch {
      // storage blocked: the sheet opens on its last pattern
    }
    ctx.go({ view: 'meeting', floor });
  };

  // ---- Running ------------------------------------------------------------------------------------
  const paintRunning = (m: Meeting) => {
    const def = PATTERN_WORDS[m.pattern];
    const minute = Math.floor(Date.now() / 60_000);
    keep(slots.head, `${m.id}|${m.title}|${m.followup ?? 0}|${minute}`, () =>
      h(
        'header.a-mtg-live__head',
        {},
        h('p.a-mtg-over.a-mtg-over--live', {}, h('span.a-mtg-live-dot', { 'aria-hidden': 'true' }), m.followup ? `${def.name} · follow-up ${m.followup}` : `${def.name} · in session`),
        h('h2.a-mtg-live__title', { id: 'a-mtg-title', title: m.prompt }, m.title),
        h('p.a-mtg-live__meta', {}, `Called by ${m.calledBy.replace(/\s*📱\s*$/u, '')} · ${timeAgo(m.startedAt)}`),
      ),
    );
    const w = ctx.store.workers;
    const tableKey = JSON.stringify([m.round, m.rounds, m.followup ?? 0, m.step, m.turns.map((t) => [t.seat, t.state, t.doing]), m.seats.map((s) => [s.role, s.member, s.workerId, s.workerId ? w.get(s.workerId)?.status : null])]);
    keep(slots.table, tableKey, () => roundTable(m));
    keep(slots.budget, `${m.tokens}|${m.budget}|${m.cost}|${m.costKnown}`, () => budgetBar(m, true));
    keep(slots.followups, followKey(m), () => followThread(m));
    const writing = m.turns.some((t) => t.file === m.output && t.state !== 'done');
    keep(slots.writeup, `${m.preview ?? ''}|${writing}`, () => writeup(m, writing));
    keep(slots.seats, `${tableKey}|${m.seats.map((s) => s.tokens ?? 0).join(',')}`, () => seatList(m, true));
    keep(slots.actions, m.id, () =>
      h(
        'div.a-mtg-actions',
        {},
        btn({
          label: 'Stop the meeting',
          variant: 'danger-quiet',
          size: 'lg',
          block: true,
          cls: 'a-mtg-stop',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Stop the meeting?',
              body: `Everyone stops where they are and stays at the table, so you can still read their terminals. ${m.output.split('/').pop()} is only there if it was already written.`,
              action: 'Stop the meeting',
              danger: true,
              cancel: 'Keep going',
            });
            if (!ok) return;
            buzz();
            ctx.net.send({ t: 'meeting.stop' });
            ctx.toast('Stopping the meeting…');
          },
        }),
        h('p.a-mtg-actions__note', {}, 'Everyone stays at the table after it ends, so you can read their terminals.'),
      ),
    );
  };

  /** The table seen from above: the head of the table at the top, the rest round the far side. */
  const roundTable = (m: Meeting): HTMLElement => {
    const n = m.seats.length;
    const rest = n - 1;
    // Angles in degrees, 0 = right, 90 = bottom: the lead at the top, the others along the lower arc.
    // Up to six round the far side; past that, everyone round the whole table.
    const crowded = n > 7;
    const angles = crowded
      ? [-90, ...Array.from({ length: rest }, (_, k) => -90 + (360 * (k + 1)) / n)]
      : [-90, ...Array.from({ length: rest }, (_, k) => (rest === 1 ? 90 : 12 + (156 * k) / (rest - 1)))];
    const doing = [...new Set(m.turns.filter((t) => t.state !== 'done').map((t) => t.doing))];
    const fu = m.followup;
    const round = fu ? Math.min(Math.max(1, m.step), 3) : Math.min(Math.max(1, m.round), Math.max(1, m.rounds));
    const of = fu ? 3 : m.rounds;
    const seats = m.seats.map((s, i) => {
      const who = seatWho(s, ctx.store.workers);
      const t = m.turns.find((x) => x.seat === i);
      const state = t?.state ?? 'idle';
      const a = (angles[i] * Math.PI) / 180;
      // A crowded table spreads everyone round a wider oval, centred, so the round fits in the middle.
      const x = crowded ? 50 + 41 * Math.cos(a) : 50 + 37 * Math.cos(a);
      const y = crowded ? 49 + 41 * Math.sin(a) : 52 + 37 * Math.sin(a);
      const inner = [
        h('span.a-mtg-seat__ring', {}, avatar({ emoji: who.emoji, color: who.color, name: who.name, status: 'ready' }, crowded ? 32 : 48), i === 0 ? h('span.a-mtg-seat__crown', { title: 'Leads' }, glyph('crown', 12)) : null, state === 'done' ? h('span.a-mtg-seat__tick', {}, icon('check', 12)) : null),
        h('span.a-mtg-seat__name', {}, who.name),
        h('span.a-mtg-seat__state', {}, TURN_WORDS[state]),
      ];
      const label = `${who.name}${who.helper ? ' (a helper)' : ''}, ${s.role}${i === 0 ? ', leads' : ''}. ${TURN_WORDS[state]}${t && state !== 'done' ? `: ${t.doing}` : ''}.`;
      const style = `left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--i:${Math.min(i, 8)}`;
      return who.worker
        ? h('a.a-mtg-seat', { href: hrefOf({ view: 'terminal', floor, worker: who.worker.id }), 'data-turn': state, style, 'aria-label': `${label} Open their terminal.` }, ...inner)
        : h('span.a-mtg-seat', { 'data-turn': state, style, role: 'img', 'aria-label': label }, ...inner);
    });
    const steps = Array.from({ length: Math.max(1, of) }, (_, i) => h('span.a-mtg-steps__dot', { 'data-state': i + 1 < round ? 'done' : i + 1 === round ? 'now' : 'next' }));
    return h(
      'div.a-mtg-table',
      { 'data-seats': n, class: crowded ? 'is-crowded' : '', role: 'group', 'aria-label': fu ? `At the table, follow-up ${fu}, step ${round} of 3` : `At the table, round ${round} of ${m.rounds}` },
      h(
        'div.a-mtg-table__top',
        {},
        fu
          ? h('span.a-mtg-table__round', { 'aria-live': 'polite' }, h('span.a-mtg-table__roundword', {}, 'Follow-up'), h('span.a-mtg-table__roundnum', {}, String(fu)))
          : h('span.a-mtg-table__round', { 'aria-live': 'polite' }, h('span.a-mtg-table__roundword', {}, 'Round'), h('span.a-mtg-table__roundnum', {}, String(round), h('span.a-mtg-table__of', {}, ` of ${m.rounds}`))),
        h('span.a-mtg-table__doing', {}, doing.length ? doing.join(' · ') : fu ? 'Passing it on' : 'Between rounds'),
        h('span.a-mtg-steps', { 'aria-hidden': 'true' }, ...steps),
      ),
      ...seats,
    );
  };

  /** The output file as it's being written: the board on the meeting room's wall. */
  const writeup = (m: Meeting, writing: boolean): HTMLElement => {
    const text = m.preview?.trim() ?? '';
    const file = m.output.split('/').pop() ?? m.output;
    const card = h(
      'div.a-mtg-card.a-mtg-writeup',
      { 'data-open': writeupOpen ? 'true' : undefined, 'data-empty': text ? undefined : 'true' },
      h(
        'div.a-mtg-card__head',
        {},
        h('span.a-mtg-card__icon', { 'aria-hidden': 'true' }, glyph('pen', 18)),
        h('div.a-mtg-card__titles', {}, h('h3.a-mtg-card__title', {}, 'The write-up'), h('p.a-mtg-card__sub', {}, h('code', { title: m.output }, file))),
        writing ? h('span.a-mtg-writing', {}, h('span.a-mtg-writing__dot', { 'aria-hidden': 'true' }), 'Being written') : null,
      ),
      text
        ? h('div.a-mtg-writeup__body', {}, prose(text), h('span.a-mtg-writeup__fade', { 'aria-hidden': 'true' }))
        : h('p.a-mtg-writeup__none', {}, writing ? 'The first lines will show up here as they’re written.' : 'Nothing written yet. It fills in during the last round, when the lead writes it up.'),
    );
    if (text) {
      const more = btn({
        label: writeupOpen ? 'Show less' : 'Show all',
        variant: 'ghost',
        size: 'sm',
        icon: 'down',
        cls: 'a-mtg-writeup__more',
        attrs: { 'aria-expanded': String(writeupOpen) },
        onClick: () => {
          writeupOpen = !writeupOpen;
          card.toggleAttribute('data-open', writeupOpen);
          more.setAttribute('aria-expanded', String(writeupOpen));
          more.querySelector('.a-btn__label')!.textContent = writeupOpen ? 'Show less' : 'Show all';
        },
      });
      card.append(more);
    }
    return card;
  };

  /** Everyone at the table in rows: who, their job, what they're on, what they've used, their terminal. */
  const seatList = (m: Meeting, running: boolean): HTMLElement => {
    const rows = m.seats.map((s, i) => {
      const who = seatWho(s, ctx.store.workers);
      const t = m.turns.find((x) => x.seat === i);
      const state = t?.state ?? 'idle';
      const status: UiStatus = who.worker ? uiStatus(who.worker) : 'resting';
      const job = `${i === 0 ? 'Leads · ' : ''}${who.helper && who.name === s.role ? 'A general helper' : s.role}`;
      const line = running ? (t && state !== 'done' ? `${TURN_WORDS[state]} · ${t.doing}` : TURN_WORDS[state]) : who.worker ? 'Still at the table' : 'Gone home';
      return h(
        'div.a-mtg-row',
        { 'data-turn': running ? state : undefined, style: `--i:${Math.min(i, 5)}` },
        h('span.a-mtg-row__lead', {}, avatar({ emoji: who.emoji, color: who.color, name: who.name, status: running ? status : who.worker ? 'ready' : 'resting' }, 40)),
        h(
          'span.a-mtg-row__text',
          {},
          h('span.a-mtg-row__name', {}, who.name, i === 0 ? h('span.a-mtg-row__crown', { 'aria-hidden': 'true' }, glyph('crown', 13)) : null),
          h('span.a-mtg-row__job', {}, h('span.a-mtg-row__jobtext', {}, job), s.tokens ? h('span.a-mtg-row__tokens', {}, `${fmtTokens(s.tokens)} tokens`) : null),
          h('span.a-mtg-row__line', {}, h('span.a-mtg-row__state', {}, line)),
        ),
        who.worker
          ? h('a.a-mtg-term', { href: hrefOf({ view: 'terminal', floor, worker: who.worker.id }), 'aria-label': `${who.name}’s terminal`, title: 'Terminal' }, glyph('terminal', 18), h('span', {}, 'Terminal'))
          : null,
      );
    });
    return h('div.a-mtg-seats', {}, h('h3.a-mtg-section-h', {}, 'At the table', h('span.a-mtg-section-h__count', {}, String(m.seats.length))), h('div.a-mtg-group', {}, ...rows));
  };

  // ---- Done ---------------------------------------------------------------------------------------
  const paintDone = (m: Meeting) => {
    const def = PATTERN_WORDS[m.pattern];
    const when = m.finishedAt ?? m.startedAt;
    keep(slots.head, `${m.id}|${m.status}|${m.round}|${m.reason ?? ''}|${m.followups?.length ?? 0}|${Math.floor(Date.now() / 60_000)}`, () =>
      h(
        'header.a-mtg-done__head',
        { style: '--i:0' },
        h(
          'p.a-mtg-over',
          {},
          patternTile(m.pattern, 'sm'),
          `${def.name} · `,
          m.status === 'done' ? h('span.a-mtg-over__ok', {}, `Finished in ${plural(m.round, 'round')}${m.followups?.length ? ` · ${plural(m.followups.length, 'follow-up')}` : ''}`) : h('span.a-mtg-over__warn', {}, m.followups?.length && m.followups[m.followups.length - 1].status === 'stopped' ? 'The follow-up stopped' : `Stopped in round ${m.round} of ${m.rounds}`),
        ),
        h('p.a-mtg-ask', { title: m.prompt }, h('span.a-mtg-ask__mark', { 'aria-hidden': 'true' }, glyph('quote', 16)), h('span.a-mtg-ask__text', {}, m.prompt)),
        m.attachments?.length ? h('p.a-mtg-fu__files', {}, `📎 ${m.attachments.length === 1 ? 'A file came' : `${m.attachments.length} files came`} with the question`) : null,
        h('p.a-mtg-done__meta', {}, `Asked by ${m.calledBy.replace(/\s*📱\s*$/u, '')} · ${timeAgo(when)}${m.status === 'stopped' && m.reason ? ` · ${m.reason}` : ''}`),
      ),
    );
    keep(slots.followups, followKey(m), () => followThread(m));
    const lead = seatWho(m.seats[0], ctx.store.workers);
    keep(slots.follow, `${m.id}|${lead.name}|${m.seats[0]?.role}`, () => followBox(m));
    keep(slots.recap, `${m.id}|${m.recapState ?? ''}|${m.recap ?? ''}|${m.saved ?? ''}|${m.recap ? '' : (m.preview ?? '')}`, () => recapCard(m));
    const w = ctx.store.workers;
    keep(slots.seats, JSON.stringify(m.seats.map((s) => [s.member, s.workerId, s.workerId ? w.has(s.workerId) : 0, s.tokens ?? 0])), () => seatList(m, false));
    keep(slots.budget, `${m.tokens}|${m.budget}|${m.cost}`, () => budgetBar(m, false));
    const head = m.seats[0]?.workerId ? w.get(m.seats[0].workerId) : undefined;
    keep(slots.output, JSON.stringify([m.output, m.worktree?.branch, m.commit, m.review, head?.id, head?.pr?.number, !!ctx.store.project?.remote]), () => outputCard(m, head));
    keep(slots.actions, `${m.id}|${!!m.saved}`, () =>
      h(
        'div.a-mtg-actions.a-mtg-actions--done',
        {},
        btn({ label: 'Call another meeting', icon: 'add', variant: 'primary', size: 'lg', block: true, href: callHref }),
        btn({
          label: 'Clear the room',
          variant: 'secondary',
          size: 'lg',
          block: true,
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Clear the room?',
              body: m.saved ? 'Everyone at the table goes home. The whole meeting stays saved, and you can read it any time from Earlier meetings or Reports.' : 'Everyone at the table goes home. Anything they committed stays on its branch.',
              action: 'Clear the room',
            });
            if (!ok) return;
            buzz();
            ctx.net.send({ t: 'meeting.clear' });
            ctx.toast('Clearing the room');
          },
        }),
      ),
    );
  };

  const readButton = (saved: string, title: string, meta: string, variant: 'secondary' | 'ghost' = 'secondary', label = 'Read the whole meeting') =>
    btn({ label, variant, size: variant === 'ghost' ? 'sm' : 'md', cls: 'a-mtg-read', onClick: () => openReader(floor, saved, title, meta) });

  /** The recap (Sonnet's, or Haiku's for a conversation): the hero once it's over. */
  const recapCard = (m: Meeting): HTMLElement => {
    const writer = m.pattern === 'talk' ? 'Haiku' : 'Sonnet';
    const meta = `${PATTERN_WORDS[m.pattern].name} · ${shortDate(m.finishedAt ?? m.startedAt)}, ${clockTime(m.finishedAt ?? m.startedAt)}`;
    const read = m.saved ? readButton(m.saved, m.title, meta) : null;
    if (m.recap?.trim()) {
      const { headline, body } = splitRecap(m.recap);
      return h(
        'article.a-mtg-recap',
        { 'aria-labelledby': 'a-mtg-recap-h', style: '--i:1' },
        h('p.a-mtg-over.a-mtg-recap__over', {}, 'The recap', h('span.a-mtg-recap__by', {}, m.pattern === 'talk' ? ` · by ${writer}` : ` · by ${writer}, from everything said at the table`)),
        h('h2.a-mtg-recap__headline', { id: 'a-mtg-recap-h' }, headline ?? m.title),
        body ? prose(body, 'a-mtg-prose--recap') : null,
        read ? h('div.a-mtg-recap__foot', {}, read) : null,
      );
    }
    if (m.recapState === 'writing') {
      return h(
        'article.a-mtg-recap.a-mtg-recap--writing',
        { 'aria-busy': 'true', 'aria-labelledby': 'a-mtg-recap-h', style: '--i:1' },
        h('p.a-mtg-over.a-mtg-recap__over', {}, 'The recap'),
        h('h2.a-mtg-recap__headline.a-mtg-shimmer-text', { id: 'a-mtg-recap-h', 'aria-live': 'polite' }, `${writer} is writing the recap…`),
        h('div.a-mtg-recap__lines', { 'aria-hidden': 'true' }, ...['92%', '78%', '86%', '64%', '81%'].map((w, i) => h('span.a-mtg-shimmer-line', { style: `width:${w};--k:${i}` }))),
        h('p.a-mtg-recap__note', {}, 'It reads every note from the table and sums it up in a few lines. It usually takes under a minute.'),
        read ? h('div.a-mtg-recap__foot', {}, read) : null,
      );
    }
    // No recap (it failed, or an older meeting): the write-up itself carries the screen.
    const text = m.preview?.trim() ?? '';
    return h(
      'article.a-mtg-recap.a-mtg-recap--plain',
      { 'aria-labelledby': 'a-mtg-recap-h', style: '--i:1' },
      h('p.a-mtg-over.a-mtg-recap__over', {}, m.pattern === 'talk' ? 'The recap' : 'The write-up'),
      h('h2.a-mtg-recap__headline', { id: 'a-mtg-recap-h' }, m.title),
      text ? prose(text, 'a-mtg-prose--recap') : h('p.a-mtg-recap__note', {}, m.pattern === 'talk' ? 'There’s no recap for this one, but every word is saved.' : m.status === 'done' ? 'There’s no recap for this one.' : 'It stopped before anything was written.'),
      read ? h('div.a-mtg-recap__foot', {}, read) : null,
    );
  };

  /** Where the result went: the file, its branch, the PR review, and a pull request to open. */
  const outputCard = (m: Meeting, head: WorkerInfo | undefined): HTMLElement => {
    const canPr = !!(m.commit && head?.worktree && ctx.store.project?.remote);
    return h(
      'div.a-mtg-card.a-mtg-output',
      {},
      h(
        'div.a-mtg-card__head',
        {},
        h('span.a-mtg-card__icon', { 'aria-hidden': 'true' }, glyph('file', 18)),
        h(
          'div.a-mtg-card__titles',
          {},
          h('h3.a-mtg-card__title', {}, m.status === 'done' ? 'What it wrote' : 'What it was writing'),
          h('p.a-mtg-card__sub', {}, h('code', {}, m.output)),
          m.worktree ? h('p.a-mtg-card__sub', {}, m.commit ? `Committed on ${m.worktree.branch}` : `On ${m.worktree.branch}`) : null,
        ),
      ),
      m.review?.url
        ? h('a.a-mtg-link', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, glyph('pull', 16), `The review on PR #${m.pr}`, icon('external', 16))
        : m.review?.error
          ? h('p.a-mtg-card__warn', {}, `Couldn’t post the review: ${m.review.error}`)
          : null,
      canPr ? btn({ label: head!.pr ? `Pull request #${head!.pr.number}` : 'Open a pull request', variant: 'secondary', size: 'sm', href: hrefOf({ view: 'changes', floor, worker: head!.id }) }) : null,
    );
  };

  // ---- Follow-ups ------------------------------------------------------------------------------------
  /** What she typed for a follow-up, kept while the screen redraws. */
  let followDraft = '';

  const followKey = (m: Meeting) =>
    JSON.stringify([m.id, m.status, m.step, m.followup ?? 0, m.turns.map((t) => t.state), (m.followups ?? []).map((f) => [f.status, f.helpers?.join(','), f.preview?.length ?? 0, f.reason])]);

  /** Where a follow-up is, in words. */
  const followStage = (m: Meeting, f: MeetingFollowup): string => {
    const lead = seatWho(m.seats[0], ctx.store.workers).name;
    if (m.step <= 1) return `${lead} is reading it and working out who does what…`;
    if (m.step === 2) return f.helpers?.length ? `${namesList(f.helpers)} ${f.helpers.length === 1 ? 'is' : 'are'} on it…` : `${lead} is taking it on alone…`;
    return `${lead} is writing the answer…`;
  };

  /** Every follow-up put to this table, oldest first: the question, who the lead brought in, the answer. */
  const followThread = (m: Meeting): HTMLElement | null => {
    const list = m.followups ?? [];
    if (!list.length) return null;
    const lead = seatWho(m.seats[0], ctx.store.workers);
    return h(
      'div.a-mtg-fu-list',
      {},
      h('h3.a-mtg-section-h', {}, 'Follow-ups', h('span.a-mtg-section-h__count', {}, String(list.length))),
      ...list.map((f, i) => {
        const live = f.status === 'running' && m.followup === i + 1;
        let open = i === list.length - 1;
        const answer = f.preview?.trim() ? h('div.a-mtg-fu__answer', { hidden: !open }, prose(f.preview, 'a-mtg-prose--small')) : null;
        const more =
          answer && list.length > 1
            ? btn({
                label: open ? 'Hide the answer' : 'Show the answer',
                variant: 'ghost',
                size: 'sm',
                icon: 'down',
                attrs: { 'aria-expanded': String(open) },
                onClick: () => {
                  open = !open;
                  answer.hidden = !open;
                  more!.setAttribute('aria-expanded', String(open));
                  more!.querySelector('.a-btn__label')!.textContent = open ? 'Hide the answer' : 'Show the answer';
                },
              })
            : null;
        return h(
          'article.a-mtg-fu',
          { 'data-status': f.status, style: `--i:${Math.min(i, 5)}` },
          h('div.a-mtg-fu__ask', {}, h('span.a-mtg-fu__who', {}, `${f.by.replace(/\s*📱\s*$/u, '')} · ${timeAgo(f.at)}`), h('p.a-mtg-fu__q', {}, f.text), f.attachments?.length ? h('span.a-mtg-fu__files', {}, `📎 ${f.attachments.length === 1 ? '1 file' : `${f.attachments.length} files`}`) : null),
          h(
            'div.a-mtg-fu__reply',
            {},
            h(
              'div.a-mtg-fu__from',
              {},
              avatar({ emoji: lead.emoji, color: lead.color, name: lead.name, status: live ? 'working' : f.status === 'stopped' ? 'resting' : 'ready' }, 32),
              h(
                'span.a-mtg-fu__fromtext',
                {},
                h('b', {}, lead.name),
                f.helpers?.length ? h('small', {}, `brought in ${namesList(f.helpers)}`) : f.status === 'done' ? h('small', {}, 'answered on their own') : null,
              ),
            ),
            live
              ? h('p.a-mtg-fu__working.a-mtg-shimmer-text', { 'aria-live': 'polite' }, followStage(m, f))
              : f.status === 'stopped'
                ? h('p.a-mtg-fu__stopped', {}, `It stopped: ${f.reason ?? 'stopped'}`)
                : answer ?? h('p.a-mtg-fu__none', {}, 'Answered: it’s in the meeting’s write-up.'),
            more,
          ),
        );
      }),
    );
  };

  /** The box for a follow-up: the head of the table takes it and brings in whoever it needs. */
  const followBox = (m: Meeting): HTMLElement => {
    const lead = seatWho(m.seats[0], ctx.store.workers);
    const role = m.seats[0]?.role ?? 'lead';
    const ta = h('textarea.a-mtg-fu__input', { rows: 3, placeholder: `Ask ${lead.name} a follow-up…`, 'aria-label': `Your follow-up for ${lead.name}`, maxlength: 20000 }) as HTMLTextAreaElement;
    ta.value = followDraft;
    const files = filePicker({ pasteInto: ta, dropOn: ta, label: 'Add files', toast: (t, l) => ctx.toast(t, l), onChange: () => send.toggleAttribute('disabled', !ta.value.trim()) });
    let sending = false;
    const send = btn({
      label: 'Send',
      icon: 'send',
      variant: 'primary',
      size: 'md',
      cls: 'a-mtg-fu__send',
      onClick: async () => {
        const text = ta.value.trim();
        if (!text) return ta.focus();
        if (sending) return;
        sending = true;
        let attachments: string[] | undefined;
        if (files.count()) {
          try {
            ctx.toast(`Uploading ${files.count() === 1 ? 'your file' : `${files.count()} files`}…`);
            attachments = await files.upload(floor);
          } catch (err) {
            sending = false;
            ctx.toast(`Couldn't upload: ${(err as Error).message}`, 'error');
            return;
          }
        }
        sending = false;
        buzz();
        ctx.net.send({ t: 'meeting.followup', text, attachments });
        followDraft = '';
        ta.value = '';
        files.clear();
        send.toggleAttribute('disabled', true);
        ctx.toast(`${lead.name} has it`);
      },
    });
    send.toggleAttribute('disabled', !ta.value.trim());
    ta.addEventListener('input', () => {
      followDraft = ta.value;
      send.toggleAttribute('disabled', !ta.value.trim());
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (send as HTMLButtonElement).click();
    });
    const away = m.seats.filter((s) => !s.workerId || !ctx.store.workers.has(s.workerId)).length;
    return h(
      'section.a-mtg-card.a-mtg-fu-box',
      { 'aria-labelledby': 'a-mtg-fu-h' },
      h(
        'div.a-mtg-fu-box__head',
        {},
        avatar({ emoji: lead.emoji, color: lead.color, name: lead.name, status: 'ready' }, 40),
        h(
          'div',
          {},
          h('h3.a-mtg-card__title', { id: 'a-mtg-fu-h' }, `Keep going with ${lead.name}`),
          h('p.a-mtg-card__sub', {}, `They lead this table (${role}): they read your follow-up, hand the others their parts, and add the answer to the meeting.${away ? ` ${plural(away, 'teammate')} who went home will sit back down.` : ''}`),
        ),
      ),
      ta,
      files.chips,
      h('div.a-mtg-fu-box__foot', {}, files.button, h('span.a-mtg-fu-box__hint', {}, 'Builds on everything said so far'), send),
    );
  };

  // ---- A conversation (pattern 'talk') ---------------------------------------------------------------
  //
  // A group chat with the table: who's at it along the top, the thread, a "thinking…" row for each seat
  // that owes a reply, and a composer that sticks to the bottom with a "To" row (everyone, or the seats
  // she taps). Haiku's shared memory sits beside the thread on a wide screen and in a sheet on a phone.
  // The thread can run to hundreds of messages and the meeting updates many times a minute, so each
  // message's element is made once and kept; only the rows whose look changed are made again.

  /** What she's typing to the table, and who it's for: kept while the screen redraws. */
  const talkDraft = { id: '', text: '', to: [] as number[] };

  const makeTalk = (first: Meeting): TalkRoom => {
    let m = first;
    if (talkDraft.id !== m.id) Object.assign(talkDraft, { id: m.id, text: '', to: [] });
    const to = new Set<number>(talkDraft.to.filter((i) => i < m.seats.length));
    /** Set when she quick-addressed a seat from its reply: the field says "Reply to …". */
    let replyTo: number | null = null;
    const offs: (() => void)[] = [];

    // ---- Who's who -------------------------------------------------------------------------------
    const myName = () => stripPhone(ctx.store.profile.name);
    const isMine = (x: MeetingMessage) => x.from === 'you' && !x.system && (!x.by || stripPhone(x.by) === myName());
    const face = (i: number) => {
      const s = m.seats[i];
      const who = s ? seatWho(s, ctx.store.workers) : { name: `Seat ${i + 1}`, helper: true, emoji: undefined, color: undefined, worker: undefined };
      const here = !!who.worker && who.worker.status !== 'exited';
      const job = s && s.role !== who.name ? s.role : who.helper ? 'A general helper' : undefined;
      return { ...who, here, job };
    };
    /** Where a seat's reply has got to: the furthest along of the replies it owes. */
    const owes = (i: number): MeetingReply['state'] | undefined => {
      const rs = (m.replying ?? []).filter((r) => r.seat === i);
      return rs.find((r) => r.state === 'working')?.state ?? rs.find((r) => r.state === 'sent')?.state ?? rs[0]?.state;
    };
    const running = () => m.status === 'running';
    const seatAvatar = (i: number, size: 24 | 32 | 40 | 48 | 72, live = true) => {
      const f = face(i);
      const st = owes(i);
      const status: UiStatus = !f.here ? 'resting' : live && running() && (st === 'working' || st === 'sent') ? 'working' : 'ready';
      return avatar({ emoji: f.emoji, color: f.color, name: f.name, status }, size);
    };

    // ---- The skeleton ----------------------------------------------------------------------------
    const head = h('header.a-mtg-talk__head');
    const thread = h('div.a-mtg-thread', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'The conversation' });
    const typing = h('div.a-mtg-typing', { 'aria-live': 'polite' });
    const ended = h('div.a-mtg-talk__ended');
    const end = h('div.a-mtg-talk__end', { 'aria-hidden': 'true' });
    const aside = h('aside.a-mtg-mem.a-mtg-mem--aside', { 'aria-labelledby': 'a-mtg-mem-h' });
    const newPill = h('button.a-mtg-newpill', { type: 'button', hidden: true }, icon('arrow-down', 16), h('span', {}, 'New messages'));
    const composer = h('div.a-mtg-composer');
    // The header is in the same column as the thread so the composer, sticky inside it, stays pinned
    // over the tab bar for as long as any of the conversation is on screen.
    const main = h('div.a-mtg-talk__main', {}, head, thread, typing, ended, end, composer);
    const el = h('div.a-mtg-talk', { 'data-live': running() ? 'true' : undefined }, h('div.a-mtg-talk__grid', {}, main, aside));

    // ---- Following the newest message --------------------------------------------------------------
    /** She's at (or near) the newest message, so new ones scroll into view; else a pill says they came. */
    const atEnd = () => {
      const r = end.getBoundingClientRect();
      const c = composer.getBoundingClientRect();
      return r.top <= c.top + 140;
    };
    const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior;
    const toEnd = (behavior: ScrollBehavior = smooth()) => {
      end.scrollIntoView({ block: 'end', behavior });
      newPill.hidden = true;
    };
    newPill.addEventListener('click', () => toEnd());
    const onScroll = () => {
      if (!newPill.hidden && atEnd()) newPill.hidden = true;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    offs.push(() => window.removeEventListener('scroll', onScroll));
    // The composer's height, for where "the end" is when scrolling to it.
    const ro = new ResizeObserver(() => el.style.setProperty('--a-mtg-composer-h', `${Math.ceil(composer.getBoundingClientRect().height)}px`));
    ro.observe(composer);
    offs.push(() => ro.disconnect());

    // ---- The header: who's at the table ----------------------------------------------------------
    const paintHead = () => {
      const key = JSON.stringify([m.memory ?? '', m.title, m.status, m.calledBy, Math.floor(Date.now() / 60_000), m.tokens > 0 ? meetingSpend(m) : '', m.memoryState, m.seats.map((_, i) => [face(i).name, face(i).here, face(i).color, owes(i)])]);
      if (head.dataset.k === key) return;
      head.dataset.k = key;
      const live = running();
      const seats = m.seats.map((_, i) => {
        const f = face(i);
        const st = owes(i);
        const state = !f.here ? 'Gone home' : live && st === 'waiting' ? 'Up next' : live && st ? 'Thinking' : '';
        const b = h(
          'button.a-mtg-seatbtn',
          { type: 'button', 'data-state': !f.here ? 'away' : live && st ? (st === 'waiting' ? 'queued' : 'thinking') : 'here', 'aria-label': `${f.name}${f.job ? `, ${f.job}` : ''}${state ? `. ${state}` : ''}. More`, style: `--i:${Math.min(i, 8)}` },
          seatAvatar(i, 48),
          h('span.a-mtg-seatbtn__name', {}, f.name),
          h('span.a-mtg-seatbtn__state', {}, state || (f.job && f.job !== 'A general helper' ? f.job : ' ')),
        );
        b.addEventListener('click', () => seatSheet(i));
        return b;
      });
      // The memory's first line, as a teaser for the card that opens it.
      const gist = (m.memory ?? '')
        .split('\n')
        .map((l) => l.replace(/^\s*(?:#+|[-*]|\d+\.)\s*/, '').replace(/[*_`]/g, '').trim())
        .filter((l) => l && l !== m.title && !/^(where things stand|decided|still open|open questions|who.s doing what)$/i.test(l))[0];
      const writing = m.memoryState === 'writing';
      const memBtn = h(
        'button.a-mtg-membtn',
        { type: 'button', 'data-writing': writing ? 'true' : undefined, 'aria-label': `What the table knows${writing ? ': Haiku is updating it' : ''}` },
        h('span.a-mtg-membtn__icon', { 'aria-hidden': 'true' }, glyph('bulb', 18)),
        h('span.a-mtg-membtn__text', {}, h('span.a-mtg-membtn__title', {}, 'What the table knows', writing ? h('span.a-mtg-membtn__dot', { 'aria-hidden': 'true' }) : null), h('span.a-mtg-membtn__gist', {}, writing ? 'Haiku is updating it…' : (gist ?? 'The shared memory everyone reads before they answer'))),
        h('span.a-mtg-membtn__chev', { 'aria-hidden': 'true' }, icon('forward', 18)),
      );
      memBtn.addEventListener('click', () => memorySheet());
      const endBtn = live ? h('button.a-mtg-endbtn', { type: 'button', 'aria-label': 'End the meeting' }, glyph('hangup', 16), h('span', {}, 'End')) : null;
      endBtn?.addEventListener('click', () => void endMeeting());
      head.replaceChildren(
        h(
          'div.a-mtg-talk__top',
          {},
          h('div.a-mtg-talk__overrow', {}, h('p.a-mtg-over', { class: live ? 'a-mtg-over--live' : undefined }, live ? h('span.a-mtg-live-dot', { 'aria-hidden': 'true' }) : patternTile('talk', 'sm'), live ? 'Conversation · live' : `Conversation · ${m.status === 'stopped' && m.reason && !/ended by|stopped by/i.test(m.reason) ? 'stopped' : 'ended'}`), endBtn),
          h('h2.a-mtg-talk__title', { id: 'a-mtg-title', title: m.title }, m.title),
          h('p.a-mtg-talk__meta', {}, [`Started by ${stripPhone(m.calledBy)} · ${timeAgo(m.startedAt)}`, m.tokens > 0 ? meetingSpend(m) : ''].filter(Boolean).join(' · ')),
        ),
        h('div.a-mtg-talk__table', { role: 'group', 'aria-label': `At the table: ${plural(m.seats.length, 'person', 'people')}` }, ...seats),
        h('div.a-mtg-talk__bar', {}, memBtn),
      );
    };

    /** A seat's card: who they are, and the ways to reach them. */
    const seatSheet = (i: number) => {
      const f = face(i);
      const s = sheet({ label: f.name, className: 'a-mtg-seatsheet' });
      const st = owes(i);
      const line = !f.here ? 'Gone home. Saying something to them brings them back to the table.' : running() && st === 'waiting' ? 'Up next: they answer as soon as they’ve finished the last thing.' : running() && st ? 'Thinking about an answer now.' : 'At the table, listening.';
      const talkTo = btn({
        label: `Talk to just ${f.name}`,
        icon: 'send',
        variant: 'primary',
        size: 'lg',
        block: true,
        onClick: () => {
          s.close();
          address([i], true);
        },
      });
      const tokens = m.seats[i]?.tokens;
      s.root.append(
        h('header.a-sheet__head', {}, h('span'), iconButton('close', 'Close', () => s.close())),
        h(
          'div.a-sheet__body.a-mtg-seatsheet__body',
          {},
          seatAvatar(i, 72),
          h('h2.a-mtg-seatsheet__name', {}, f.name),
          f.job ? h('p.a-mtg-seatsheet__job', {}, f.job) : null,
          h('p.a-mtg-seatsheet__line', {}, line),
          tokens ? h('p.a-mtg-seatsheet__meta', {}, `${fmtTokens(tokens)} tokens in this meeting`) : null,
          h(
            'div.a-mtg-seatsheet__actions',
            {},
            talkTo,
            f.worker && f.here ? btn({ label: 'Open their terminal', variant: 'secondary', size: 'lg', block: true, href: hrefOf({ view: 'terminal', floor, worker: f.worker.id }), cls: 'a-mtg-seatsheet__term' }) : null,
          ),
        ),
      );
      s.root.querySelector<HTMLElement>('.a-mtg-seatsheet__term')?.prepend(glyph('terminal', 18));
    };

    const endMeeting = async () => {
      const ok = await confirmDialog({
        title: 'End the meeting?',
        body: 'Everyone stops where they are. The office saves the whole conversation and Haiku writes a short recap. You can pick it up again any time by saying something.',
        action: 'End meeting',
        danger: true,
        cancel: 'Keep talking',
      });
      if (!ok) return;
      buzz();
      ctx.net.send({ t: 'meeting.stop' });
      ctx.toast('Ending the meeting…');
    };

    // ---- What the table knows ----------------------------------------------------------------------
    let asideOpen = (() => {
      try {
        return localStorage.getItem('hearth.mtg.memory') !== 'closed';
      } catch {
        return true;
      }
    })();
    /** The memory, as the aside and the sheet show it. */
    const memoryBody = (): HTMLElement => {
      const writing = m.memoryState === 'writing';
      const text = (m.memory ?? '').replace(/^\s*#\s+[^\n]*\n/, '').trim();
      return h(
        'div.a-mtg-mem__inner',
        {},
        h(
          'p.a-mtg-mem__state',
          { 'data-state': writing ? 'writing' : m.memoryState === 'failed' ? 'failed' : 'ok', 'aria-live': 'polite' },
          h('span.a-mtg-mem__dot', { 'aria-hidden': 'true' }),
          writing ? 'Haiku is updating it…' : m.memoryState === 'failed' ? 'Couldn’t update it just now. It tries again after the next exchange.' : m.memoryState === 'done' ? 'Up to date' : 'Haiku keeps it as you talk',
        ),
        text ? prose(text, `a-mtg-prose--small a-mtg-mem__prose${writing ? ' is-writing' : ''}`) : h('p.a-mtg-mem__none', {}, 'Nothing yet. After the first answers, Haiku writes down where things stand.'),
        h('p.a-mtg-mem__foot', {}, 'Everyone at the table reads this before they answer, so whoever you talk to next knows what’s been said.'),
      );
    };
    const paintAside = () => {
      const key = `${m.memory ?? ''}|${m.memoryState ?? ''}|${asideOpen}`;
      if (aside.dataset.k === key) return;
      aside.dataset.k = key;
      aside.toggleAttribute('data-closed', !asideOpen);
      const toggle = h('button.a-mtg-mem__toggle', { type: 'button', 'aria-expanded': String(asideOpen), 'aria-controls': 'a-mtg-mem-body' }, h('span.a-mtg-mem__icon', { 'aria-hidden': 'true' }, glyph('bulb', 18)), h('span.a-mtg-mem__title', { id: 'a-mtg-mem-h' }, 'What the table knows'), m.memoryState === 'writing' ? h('span.a-mtg-membtn__dot', { 'aria-hidden': 'true' }) : null, h('span.a-mtg-mem__chev', { 'aria-hidden': 'true' }, icon('down', 18)));
      toggle.addEventListener('click', () => {
        asideOpen = !asideOpen;
        try {
          localStorage.setItem('hearth.mtg.memory', asideOpen ? 'open' : 'closed');
        } catch {
          // storage blocked: it stays as she left it for this visit
        }
        paintAside();
      });
      aside.replaceChildren(toggle, ...(asideOpen ? [h('div.a-mtg-mem__body', { id: 'a-mtg-mem-body' }, memoryBody())] : []));
    };
    /** On a phone: the memory in a sheet, kept up to date while it's open. */
    let memSheet: { body: HTMLElement; close(): void; key: string } | null = null;
    const memorySheet = () => {
      const s = sheet({ label: 'What the table knows', className: 'a-mtg-memsheet', onClose: () => (memSheet = null) });
      const body = h('div.a-sheet__body.a-mtg-mem', {}, memoryBody());
      s.root.append(h('header.a-sheet__head', {}, h('div.a-mtg-memsheet__titles', {}, h('p.a-mtg-over', {}, glyph('bulb', 14), 'Shared memory'), h('h2.a-sheet__title.a-mtg-memsheet__title', {}, 'What the table knows')), iconButton('close', 'Close', () => s.close())), body);
      memSheet = { body, close: s.close, key: `${m.memory ?? ''}|${m.memoryState ?? ''}` };
    };
    const paintMemSheet = () => {
      if (!memSheet) return;
      const key = `${m.memory ?? ''}|${m.memoryState ?? ''}`;
      if (memSheet.key === key) return;
      memSheet.key = key;
      memSheet.body.replaceChildren(memoryBody());
    };
    offs.push(() => memSheet?.close());

    // ---- The thread ----------------------------------------------------------------------------------
    const cache = new Map<string, { key: string; el: HTMLElement }>();
    /** The rows in the thread now, in order. */
    let shown: HTMLElement[] = [];
    const toWords = (ids: number[] | undefined) => {
      if (!ids?.length || ids.length >= m.seats.length) return 'everyone';
      const names = ids.map((i) => face(i).name);
      return names.length <= 3 ? andList(names) : `${names.slice(0, 2).join(', ')} & ${names.length - 2} others`;
    };
    const fileChips = (paths: string[] | undefined, mine: boolean) =>
      paths?.length
        ? h(
            'div.a-mtg-files',
            { class: mine ? 'is-mine' : undefined },
            ...paths.map((p) => {
              const name = p.split(/[/\\]/).pop() ?? p;
              return h('span.a-mtg-file', { title: name }, icon(/\.pdf$/i.test(name) ? 'file' : 'photo', 14), h('span.a-mtg-file__name', {}, name));
            }),
          )
        : null;
    /** A long answer is folded to a screenful, with a way to open it. */
    const foldable = (bubble: HTMLElement, text: string) => {
      if (text.length < 1400 && text.split('\n').length < 26) return bubble;
      bubble.dataset.folded = 'true';
      const more = h('button.a-mtg-bubble__more', { type: 'button', 'aria-expanded': 'false' }, h('span', {}, 'Show all'), icon('down', 16));
      more.addEventListener('click', () => {
        const open = bubble.dataset.folded === 'true';
        bubble.dataset.folded = open ? 'false' : 'true';
        more.setAttribute('aria-expanded', String(open));
        more.querySelector('span')!.textContent = open ? 'Show less' : 'Show all';
      });
      bubble.append(more);
      return bubble;
    };

    const timeSep = (at: number) => h('div.a-mtg-time', {}, h('span', {}, `${dayWord(at)} · ${clockTime(at)}`));

    const messageEl = (x: MeetingMessage, pos: { first: boolean; last: boolean; quote?: string }): HTMLElement => {
      if (x.system) return h('p.a-mtg-sys', {}, h('span', {}, x.text));
      if (x.from === 'you') {
        const mine = isMine(x);
        const who = stripPhone(x.by ?? 'Someone');
        const bubble = foldable(h('div.a-mtg-bubble', { class: mine ? 'a-mtg-bubble--me' : 'a-mtg-bubble--person' }, h('p.a-mtg-bubble__text', {}, x.text)), x.text);
        return h(
          'div.a-mtg-msg',
          { class: mine ? 'a-mtg-msg--me' : 'a-mtg-msg--person', 'data-first': pos.first ? 'true' : undefined, 'data-last': pos.last ? 'true' : undefined },
          !mine ? h('span.a-mtg-msg__gutter', {}, pos.last ? avatar({ name: who, status: 'ready' }, 32) : null) : null,
          h(
            'div.a-mtg-msg__col',
            {},
            pos.first ? h('p.a-mtg-msg__to', {}, mine ? null : h('b', {}, who), mine ? null : ' · ', glyph('reply', 13), `to ${toWords(x.to)}`, h('span.a-mtg-msg__at', {}, clockTime(x.at))) : null,
            bubble,
            fileChips(x.attachments, mine),
          ),
        );
      }
      const i = x.from;
      const f = face(i);
      const reply = (e: Event) => {
        e.preventDefault();
        address([i], true);
      };
      const faceBtn = h('button.a-mtg-msg__face', { type: 'button', 'aria-label': `Reply to ${f.name}`, title: `Reply to ${f.name}` }, seatAvatar(i, 32, false));
      faceBtn.addEventListener('click', reply);
      const nameBtn = h('button.a-mtg-msg__name', { type: 'button', title: `Reply to ${f.name}` }, h('b', {}, f.name), f.job && f.job !== 'A general helper' ? h('span.a-mtg-msg__job', {}, f.job) : null);
      nameBtn.addEventListener('click', reply);
      const bubble = foldable(h('div.a-mtg-bubble.a-mtg-bubble--seat', {}, prose(x.text)), x.text);
      return h(
        'div.a-mtg-msg.a-mtg-msg--seat',
        { style: f.color ? `--a-who:${f.color}` : undefined, 'data-first': pos.first ? 'true' : undefined, 'data-last': pos.last ? 'true' : undefined },
        h('span.a-mtg-msg__gutter', {}, pos.last ? faceBtn : null),
        h(
          'div.a-mtg-msg__col',
          {},
          pos.first ? h('p.a-mtg-msg__who', {}, nameBtn, h('span.a-mtg-msg__at', {}, clockTime(x.at))) : null,
          pos.quote ? h('p.a-mtg-msg__re', {}, glyph('reply', 12), h('span', {}, pos.quote)) : null,
          bubble,
        ),
      );
    };

    const paintThread = () => {
      const list = m.thread ?? [];
      const seatKey = m.seats.map((_, i) => `${face(i).name}:${face(i).color}`).join(',');
      const kids: HTMLElement[] = [];
      const fresh = new Set<string>();
      /** The newest message from the office's side so far: a reply to anything older says what it answers. */
      let lastAsk: MeetingMessage | undefined;
      const sender = (x: MeetingMessage | undefined) => (!x ? '' : x.system ? 'sys' : x.from === 'you' ? `you:${stripPhone(x.by ?? '')}:${(x.to ?? []).join('.')}` : `seat:${x.from}`);
      for (let k = 0; k < list.length; k++) {
        const x = list[k];
        const prev = list[k - 1];
        const next = list[k + 1];
        const gap = !prev || x.at - prev.at > 15 * 60_000;
        if (gap) {
          const sk = `t:${x.id}`;
          let c = cache.get(sk);
          if (!c) cache.set(sk, (c = { key: sk, el: timeSep(x.at) }));
          kids.push(c.el);
          fresh.add(sk);
        }
        const first = gap || sender(prev) !== sender(x) || x.at - prev!.at > 5 * 60_000;
        const last = !next || sender(next) !== sender(x) || next.at - x.at > 5 * 60_000 || next.at - x.at > 15 * 60_000;
        let quote: string | undefined;
        if (typeof x.from === 'number' && x.re && lastAsk && x.re !== lastAsk.id) {
          const asked = list.find((y) => y.id === x.re);
          if (asked) quote = asked.text.replace(/\s+/g, ' ').slice(0, 90) + (asked.text.length > 90 ? '…' : '');
        }
        if (x.from === 'you' && !x.system) lastAsk = x;
        const key = `${first}|${last}|${quote ?? ''}|${seatKey}|${myName()}`;
        let c = cache.get(x.id);
        if (!c || c.key !== key) cache.set(x.id, (c = { key, el: messageEl(x, { first, last, quote }) }));
        kids.push(c.el);
        fresh.add(x.id);
      }
      for (const k of [...cache.keys()]) if (!fresh.has(k)) cache.delete(k);
      // Only touch the DOM when a row was added or made again (most updates are tokens and states).
      if (kids.length === shown.length && kids.every((k, i) => k === shown[i])) return false;
      const grew = kids.length > shown.length;
      shown = kids;
      thread.replaceChildren(...kids);
      return grew;
    };

    // ---- Who's typing ------------------------------------------------------------------------------
    const paintTyping = () => {
      const live = running();
      const seats = live ? [...new Set((m.replying ?? []).map((r) => r.seat))].filter((i) => i < m.seats.length) : [];
      const key = JSON.stringify(seats.map((i) => [i, owes(i), face(i).name, face(i).color]));
      if (typing.dataset.k === key) return;
      typing.dataset.k = key;
      // The ones thinking first, then the queue.
      seats.sort((a, b) => Number(owes(a) === 'waiting') - Number(owes(b) === 'waiting'));
      typing.replaceChildren(
        ...seats.map((i) => {
          const f = face(i);
          const queued = owes(i) === 'waiting';
          return h(
            'div.a-mtg-msg.a-mtg-msg--seat.a-mtg-msg--typing',
            { 'data-state': queued ? 'queued' : 'thinking', style: f.color ? `--a-who:${f.color}` : undefined, 'data-first': 'true', 'data-last': 'true' },
            h('span.a-mtg-msg__gutter', {}, seatAvatar(i, 32)),
            h(
              'div.a-mtg-msg__col',
              {},
              h('p.a-mtg-msg__who', {}, h('span.a-mtg-msg__name', {}, h('b', {}, f.name)), h('span.a-mtg-msg__at', {}, queued ? 'up next' : 'thinking…')),
              queued
                ? h('div.a-mtg-bubble.a-mtg-bubble--queued', {}, glyph('clock', 14), h('span', {}, 'Answers when they’re free'))
                : h('div.a-mtg-bubble.a-mtg-bubble--dots', { role: 'img', 'aria-label': `${f.name} is thinking` }, h('span'), h('span'), h('span')),
            ),
          );
        }),
      );
    };

    // ---- Once it's over ----------------------------------------------------------------------------
    const paintEnded = () => {
      const key = running() ? '' : JSON.stringify([m.status, m.finishedAt, m.reason, m.recapState, m.recap?.length ?? 0, m.saved]);
      if (ended.dataset.k === key) return;
      ended.dataset.k = key;
      if (running()) return ended.replaceChildren();
      const when = m.finishedAt ?? Date.now();
      ended.replaceChildren(
        h('div.a-mtg-time.a-mtg-time--end', {}, h('span', {}, `${m.status === 'stopped' && m.reason ? `The meeting ended: ${m.reason}` : 'The meeting ended'} · ${clockTime(when)}`)),
        recapCard(m),
        h(
          'div.a-mtg-talk__after',
          {},
          btn({ label: 'Call a new meeting', icon: 'add', variant: 'secondary', size: 'md', href: callHref }),
          btn({
            label: 'Clear the room',
            variant: 'ghost',
            size: 'md',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Clear the room?',
                body: m.saved ? 'Everyone at the table goes home. The whole conversation stays saved, and you can read it any time from Earlier meetings or Reports.' : 'Everyone at the table goes home.',
                action: 'Clear the room',
              });
              if (!ok) return;
              buzz();
              ctx.net.send({ t: 'meeting.clear' });
              ctx.toast('Clearing the room');
            },
          }),
        ),
      );
    };

    // ---- The composer ------------------------------------------------------------------------------
    const field = h('textarea.a-composer__field.a-mtg-composer__field', { rows: 1, maxlength: 20000, autocapitalize: 'sentences', spellcheck: 'true', enterkeyhint: 'send' }) as HTMLTextAreaElement;
    field.value = talkDraft.text;
    const files = filePicker({ pasteInto: field, dropOn: composer, compact: true, label: 'Attach', toast: (t, l) => ctx.toast(t, l), onChange: () => paintSend() });
    const sendBtn = h('button.a-composer__send.a-mtg-composer__send', { type: 'button', 'aria-label': 'Send' }, icon('send', 18)) as HTMLButtonElement;
    const toRow = h('div.a-mtg-to', { role: 'group', 'aria-label': 'Who it’s for' });
    const hint = h('p.a-mtg-composer__hint');
    composer.append(newPill, hint, toRow, files.chips, h('div.a-composer__row.a-mtg-composer__row', {}, files.button, field, sendBtn));

    const grow = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight + 2, 164)}px`;
    };
    const paintSend = () => {
      sendBtn.disabled = !field.value.trim() || sending;
    };
    const paintTo = () => {
      const ids = [...to].sort((a, b) => a - b);
      toRow.replaceChildren(
        h('span.a-mtg-to__label', { 'aria-hidden': 'true' }, 'To'),
        (() => {
          const b = h('button.a-mtg-to__chip.a-mtg-to__all', { type: 'button', 'aria-pressed': String(!ids.length) }, glyph('users', 16), h('span', {}, 'Everyone'));
          b.addEventListener('click', () => address([]));
          return b;
        })(),
        ...m.seats.map((_, i) => {
          const f = face(i);
          const on = to.has(i);
          const b = h('button.a-mtg-to__chip', { type: 'button', 'aria-pressed': String(on), 'data-away': f.here ? undefined : 'true', style: f.color ? `--a-who:${f.color}` : undefined }, avatar({ emoji: f.emoji, color: f.color, name: f.name, status: f.here ? 'ready' : 'resting' }, 24), h('span', {}, f.name), on ? h('span.a-mtg-to__check', { 'aria-hidden': 'true' }, icon('check', 12)) : null);
          b.addEventListener('click', () => {
            if (on) to.delete(i);
            else to.add(i);
            // Everyone picked one by one is everyone.
            if (to.size >= m.seats.length) to.clear();
            replyTo = null;
            buzz();
            remember();
            paintTo();
          });
          return b;
        }),
      );
      const words = ids.length ? toWords(ids) : 'everyone';
      field.placeholder = replyTo !== null && ids.length === 1 && ids[0] === replyTo ? `Reply to ${face(replyTo).name}` : running() ? `Message ${words}` : ids.length ? `Keep talking with ${words}` : 'Keep talking…';
      field.setAttribute('aria-label', `Your message to ${words}`);
    };
    const remember = () => {
      talkDraft.text = field.value;
      talkDraft.to = [...to];
    };
    /** Puts the composer on these seats (none = everyone) and, from a reply or a seat's card, into the field. */
    const address = (ids: number[], focus = false) => {
      to.clear();
      for (const i of ids) to.add(i);
      if (to.size >= m.seats.length) to.clear();
      replyTo = focus && ids.length === 1 ? ids[0] : null;
      remember();
      paintTo();
      buzz();
      if (focus) {
        field.focus({ preventScroll: true });
        composer.scrollIntoView({ block: 'nearest', behavior: smooth() });
      }
    };
    field.addEventListener('input', () => {
      remember();
      grow();
      paintSend();
    });
    field.addEventListener('keydown', (e) => {
      // A keyboard sends with Enter (Shift+Enter for a new line); a phone's Enter is a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (matchMedia('(pointer: fine)').matches || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    });
    let sending = false;
    const send = async () => {
      const text = field.value.trim();
      if (!text || sending) return;
      sending = true;
      paintSend();
      let attachments: string[] | undefined;
      if (files.count()) {
        try {
          ctx.toast(`Uploading ${files.count() === 1 ? 'your file' : `${files.count()} files`}…`);
          attachments = await files.upload(floor);
        } catch (err) {
          sending = false;
          paintSend();
          ctx.toast(`Couldn't upload: ${(err as Error).message}`, 'error');
          return;
        }
      }
      const ids = [...to].sort((a, b) => a - b);
      const reopening = !running();
      ctx.net.send({ t: 'meeting.say', text, ...(ids.length ? { to: ids } : {}), ...(attachments?.length ? { attachments } : {}) });
      sending = false;
      field.value = '';
      files.clear();
      replyTo = null;
      remember();
      grow();
      paintSend();
      paintTo();
      buzz();
      if (reopening) ctx.toast('Opening the meeting again');
      // Her own message always scrolls into view once the office echoes it back.
      followNext = true;
    };
    sendBtn.addEventListener('click', () => void send());
    let followNext = false;

    const paintComposer = () => {
      const live = running();
      hint.hidden = live;
      hint.textContent = live ? '' : 'It’s ended. Say something to pick it back up: anyone who went home sits back down.';
      paintTo();
      paintSend();
    };

    // ---- Paint -----------------------------------------------------------------------------------------
    let painted = false;
    const paint = (next: Meeting) => {
      m = next;
      el.toggleAttribute('data-live', running());
      const wasAtEnd = painted && atEnd();
      paintHead();
      const grew = paintThread();
      paintTyping();
      paintEnded();
      paintAside();
      paintMemSheet();
      if (composer.dataset.k !== `${m.status}|${m.seats.length}|${m.seats.map((_, i) => `${face(i).here}${face(i).color}`).join('')}`) {
        composer.dataset.k = `${m.status}|${m.seats.length}|${m.seats.map((_, i) => `${face(i).here}${face(i).color}`).join('')}`;
        paintComposer();
      }
      if (!painted) {
        painted = true;
        grow();
        // The newest message first, once the page has laid out.
        requestAnimationFrame(() => requestAnimationFrame(() => (running() ? toEnd('auto') : ended.firstElementChild?.scrollIntoView({ block: 'start', behavior: 'auto' }))));
        return;
      }
      if (grew || followNext) {
        if (wasAtEnd || followNext) requestAnimationFrame(() => toEnd());
        else newPill.hidden = false;
        followNext = false;
      }
    };

    return {
      el,
      paint,
      destroy: () => offs.forEach((off) => off()),
    };
  };

  // ---- Earlier meetings -----------------------------------------------------------------------------
  const paintPast = () => {
    const recs: MeetingRecord[] = [...ctx.store.meeting.past];
    const cur = ctx.store.meeting.current;
    // A cleared meeting that the server hasn't archived yet still belongs on the list.
    if (cur?.cleared && !recs.some((r) => r.id === cur.id)) recs.unshift(meetingRecord(cur));
    const on = current();
    const list = recs.filter((r) => r.id !== on?.id);
    keep(past, JSON.stringify(list.map((r) => [r.id, r.status, r.recap?.length ?? 0, r.saved])), () => {
      if (!list.length) return null;
      return h(
        'div',
        {},
        h('h3.a-mtg-section-h', { id: 'a-mtg-past-h' }, 'Earlier meetings', h('span.a-mtg-section-h__count', {}, String(list.length))),
        h('div.a-mtg-past__list', {}, ...list.map((r, i) => pastCard(r, i))),
      );
    });
  };

  const pastCard = (r: MeetingRecord, i: number): HTMLElement => {
    const headline = r.recap ? splitRecap(r.recap).headline : undefined;
    const spend = /([\d.]+[kM]?) tokens(?: · (\$[\d.,]+\+?))?/.exec(r.summary);
    const meta = [PATTERN_WORDS[r.pattern]?.name ?? r.pattern, `${shortDate(r.finishedAt)}, ${clockTime(r.finishedAt)}`, spend ? `${spend[1]} tokens${spend[2] ? ` · ${spend[2]}` : ''}` : ''].filter(Boolean).join(' · ');
    const recapBody = r.recap ? splitRecap(r.recap).body : '';
    let opened = false;
    const detail = h('div.a-mtg-pastcard__recap', { hidden: true });
    const toggle = recapBody
      ? btn({
          label: 'Recap',
          variant: 'ghost',
          size: 'sm',
          icon: 'down',
          cls: 'a-mtg-pastcard__toggle',
          attrs: { 'aria-expanded': 'false' },
          onClick: () => {
            opened = !opened;
            if (opened && !detail.childElementCount) detail.append(prose(recapBody, 'a-mtg-prose--small'));
            detail.hidden = !opened;
            toggle!.setAttribute('aria-expanded', String(opened));
          },
        })
      : null;
    return h(
      'article.a-mtg-pastcard',
      { 'data-status': r.status, style: `--i:${Math.min(i, 5)}` },
      h(
        'div.a-mtg-pastcard__top',
        {},
        patternTile(r.pattern, 'sm'),
        h('span.a-mtg-pastcard__status', { 'data-status': r.status }, r.status === 'done' ? 'Finished' : r.status === 'stopped' ? 'Stopped' : 'On now'),
        h('span.a-mtg-pastcard__when', {}, timeAgo(r.finishedAt)),
      ),
      h('h4.a-mtg-pastcard__headline', {}, headline ?? r.title),
      headline ? h('p.a-mtg-pastcard__asked', { title: r.title }, r.title) : null,
      h('p.a-mtg-pastcard__meta', {}, meta),
      detail,
      toggle || r.saved ? h('div.a-mtg-pastcard__actions', {}, toggle, r.saved ? readButton(r.saved, r.title, meta, 'ghost', 'Read') : null) : null,
    );
  };

  // ---- Paint ----------------------------------------------------------------------------------------
  const paint = () => {
    const m = current();
    // A conversation keeps one screen whether it's on or ended: saying something reopens it in place.
    const want = !m ? 'empty' : m.pattern === 'talk' ? `talk:${m.id}` : `${m.status === 'running' ? 'running' : 'done'}:${m.id}`;
    if (want !== mode) build(want, m);
    if (m?.pattern === 'talk') talk?.paint(m);
    else if (m?.status === 'running') paintRunning(m);
    else if (m) paintDone(m);
    paintPast();
  };

  const timer = setInterval(() => document.visibilityState === 'visible' && paint(), 30_000);
  ctx.on('meeting', paint);
  ctx.on('workers', paint);
  ctx.on('project', paint);
  paint();
  return () => {
    clearInterval(timer);
    talk?.destroy();
  };
};

