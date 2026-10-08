// Reports segment of a space (route `reports`, DESIGN.md §6.3): what the team made for her to look at
// (budget dashboards, PDFs, charts), newest first. Tapping one opens it right here, in a full-screen
// viewer on a phone or a large dialog on a wide screen, with a button to open it in a new tab.
//
// This file also holds the few pieces the other Space screens by the same author share (notes.ts,
// hire.ts, meeting.ts): the document viewer, the CSV table, "Updated 2 hours ago", and fetching JSON.

import type { View } from '../context';
import { TEAM_BY_ID } from '../../../shared/team';
import { markdown } from '../../ui/markdown';
import { icon, type IconName } from '../icons';
import { dayLabel, emptyState, fileSize, h, iconButton, lateSkeleton, onTeam, saveDraft, sheet, shortDate, signInAgain, skeleton, teamOn, teamReady, timeAgo } from '../ui';

// ------------------------------------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------------------------------------

/**
 * A few icons the shared set (icons.ts) doesn't have, drawn on the same 24 grid with the same
 * 1.75 stroke (Lucide geometry), for the space screens only.
 */
const GLYPHS = {
  office:
    '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  leave: '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/>',
  cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  changes: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  seat: '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sparkle:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  helper: '<path d="M2 21a8 8 0 0 1 13.292-6"/><circle cx="10" cy="8" r="5"/><path d="M19 16v6"/><path d="M22 19h-6"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName, size = 20): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `a-icon a-glyph--${name}` }))
    svg.setAttribute(k, v);
  svg.innerHTML = GLYPHS[name];
  return svg;
}

/** A light haptic tap on phones that have one (Android); silently nothing elsewhere. */
export function tap(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // not allowed here
  }
}

/** GET some JSON. Never throws: `ok` false carries the HTTP status (0 when offline or aborted). */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal });
    if (res.status === 401) {
      signInAgain();
      return { ok: false, status: 401 };
    }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** How long since something changed, for "Updated …": "just now", "5 min ago", "2 hours ago", "yesterday", "on Monday", "on Sep 22". */
export function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return timeAgo(t);
  const day = dayLabel(t);
  if (day === 'Today') {
    const hrs = Math.floor(s / 3600);
    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  }
  if (day === 'Yesterday') return 'yesterday';
  return `on ${day}`;
}

/** A file's name without its folders, and its extension. */
export const baseName = (p: string) => p.split('/').pop() ?? p;
export const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

/** "2026-09-29_weekly-budget.html" → "Weekly budget". Falls back to the name as it is. */
export function prettyName(p: string): string {
  const raw = baseName(p).replace(/\.[a-z0-9]+$/i, '');
  const words = raw
    .replace(/^\d{4}-\d{2}-\d{2}(?:[T_ -]\d{2}[-:]?\d{2})?[_ -]*/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return raw;
  return words[0].toUpperCase() + words.slice(1);
}

/** A comma-separated file as rows of cells (quotes, doubled quotes and newlines inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const NUMERIC = /^[-−+]?[($€£]?[-−]?[\d,]*\.?\d+\)?%?$/;
const MAX_ROWS = 500;

/** A CSV as a readable table: a sticky header row, numbers right-aligned in tabular figures. */
export function csvTable(text: string, label: string): HTMLElement {
  const rows = parseCsv(text);
  if (!rows.length) return h('p.a-docview__note', {}, 'This file is empty.');
  const [head, ...body] = rows;
  const cols = Math.max(...rows.slice(0, 200).map((r) => r.length));
  const numeric = Array.from({ length: cols }, (_, c) => {
    const vals = body.slice(0, 200).map((r) => (r[c] ?? '').trim()).filter(Boolean);
    return vals.length > 0 && vals.filter((v) => NUMERIC.test(v.replace(/\s/g, ''))).length / vals.length >= 0.8;
  });
  const table = h(
    'table.a-csv',
    {},
    h('caption.a-sr-only', {}, label),
    h('thead', {}, h('tr', {}, ...Array.from({ length: cols }, (_, c) => h('th', { scope: 'col', class: numeric[c] ? 'is-num' : undefined }, head[c] ?? '')))),
    h('tbody', {}, ...body.slice(0, MAX_ROWS).map((r) => h('tr', {}, ...Array.from({ length: cols }, (_, c) => h('td', { class: numeric[c] ? 'is-num a-num' : undefined }, r[c] ?? ''))))),
  );
  // Focusable so a keyboard can scroll it sideways.
  const wrap = h('div.a-csv-wrap', { tabindex: 0, role: 'region', 'aria-label': `${label}, table` }, table);
  const note =
    body.length > MAX_ROWS
      ? `Showing the first ${MAX_ROWS} of ${body.length.toLocaleString('en-US')} rows. Open it in a new tab to see them all.`
      : `${body.length.toLocaleString('en-US')} row${body.length === 1 ? '' : 's'}`;
  return h('div.a-csv-block', {}, wrap, h('p.a-docview__note', {}, note));
}

/** Markdown, sanitized (ui/markdown.ts), in the reading style. */
export function prose(src: string): HTMLElement {
  const el = h('div.a-prose');
  if (src.trim()) el.append(markdown(src));
  return el;
}

export type DocKind = 'html' | 'pdf' | 'image' | 'csv' | 'markdown' | 'text';

/** The viewer kind for a file name. */
export function kindOf(p: string): DocKind {
  const e = extOf(p);
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(e)) return 'image';
  if (e === 'csv') return 'csv';
  if (e === 'md') return 'markdown';
  return 'text';
}

export interface DocViewerOptions {
  title: string;
  /** Under the title, e.g. "Report · Sep 28". */
  meta?: string;
  /** Where the file lives: the frame or picture loads it, and "Open in a new tab" goes there. */
  url: string;
  kind: DocKind;
  /** Offer a download too, under this file name. */
  download?: string;
}

/**
 * Opens a file over the screen: full screen on a phone, a large dialog on a wide screen (ui.ts's
 * sheet, restyled by .a-docview in views.css). Returns a function that closes it.
 */
export function openDocViewer(o: DocViewerOptions): () => void {
  const s = sheet({ label: o.title, className: 'a-docview' });
  const titleId = `a-docview-t-${Math.random().toString(36).slice(2, 8)}`;
  s.dialog.setAttribute('aria-labelledby', titleId);
  s.dialog.removeAttribute('aria-label');
  s.dialog.dataset.kind = o.kind;
  const body = h('div.a-sheet__body.a-docview__body', { 'aria-busy': 'true' });
  const close = iconButton('close', 'Close', () => s.close());
  s.root.append(
    h(
      'header.a-sheet__head.a-docview__head',
      {},
      h('div.a-docview__titles', {}, h('h2.a-sheet__title.a-docview__title', { id: titleId }, o.title), o.meta ? h('p.a-docview__meta', {}, o.meta) : null),
      h(
        'div.a-docview__tools',
        {},
        o.download ? h('a.a-icon-btn', { href: o.url, download: o.download, 'aria-label': 'Download', title: 'Download' }, icon('download', 22)) : null,
        h('a.a-icon-btn', { href: o.url, target: '_blank', rel: 'noopener', 'aria-label': 'Open in a new tab', title: 'Open in a new tab' }, icon('external', 22)),
        close,
      ),
    ),
    body,
  );
  close.focus();

  const done = () => body.removeAttribute('aria-busy');
  const fail = () => {
    done();
    body.replaceChildren(
      emptyState({ icon: 'warning', title: 'Couldn’t open this one', text: 'Try opening it in a new tab, or come back in a moment.', action: { label: 'Open in a new tab', icon: 'external', href: o.url, variant: 'secondary' } }),
    );
    body.querySelector('a.a-btn')?.setAttribute('target', '_blank');
  };

  if (o.kind === 'image') {
    const img = h('img.a-docview__img', { src: o.url, alt: o.title, decoding: 'async' });
    img.addEventListener('load', done);
    img.addEventListener('error', fail);
    body.append(h('div.a-docview__stage', {}, img));
  } else if (o.kind === 'html' || o.kind === 'pdf') {
    // An HTML report may draw its charts with scripts: it runs sandboxed, never on the app's own
    // origin (the server sends a sandbox CSP as well). A PDF needs the browser's own viewer, which a
    // sandboxed frame blocks, so it only gets the server's CSP.
    const frame = h('iframe.a-docview__frame', {
      src: o.url,
      title: o.title,
      referrerpolicy: 'no-referrer',
      sandbox: o.kind === 'html' ? 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads' : undefined,
    });
    frame.addEventListener('load', done);
    body.append(frame);
  } else {
    void (async () => {
      try {
        const res = await fetch(o.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (o.kind === 'csv') body.append(csvTable(text, o.title));
        else if (o.kind === 'markdown') {
          const page = prose(text);
          page.classList.add('a-sp-prose', 'a-sp-prose--page');
          body.append(h('div.a-docview__page', {}, page));
        }
        else body.append(h('div.a-docview__page', {}, h('pre.a-docview__pre', {}, text)));
        done();
      } catch {
        fail();
      }
    })();
  }
  return () => s.close();
}

/** A friendly error block with a Try again button. */
export function errorBlock(title: string, text: string, retry: () => void): HTMLElement {
  const el = emptyState({ icon: 'offline', title, text, action: { label: 'Try again', icon: 'retry', variant: 'secondary', onClick: retry } });
  el.setAttribute('role', 'alert');
  return el;
}

// ------------------------------------------------------------------------------------------------
// The Reports segment
// ------------------------------------------------------------------------------------------------

interface ReportFile {
  /** reports/… or charts/…, relative to the space's folder. */
  path: string;
  size: number;
  modified: number;
}

const TYPE: Record<DocKind, { icon: IconName; word: string }> = {
  html: { icon: 'reports', word: 'Report' },
  pdf: { icon: 'file', word: 'PDF' },
  image: { icon: 'photo', word: 'Picture' },
  csv: { icon: 'file', word: 'Spreadsheet' },
  markdown: { icon: 'notes', word: 'Write-up' },
  text: { icon: 'file', word: 'Text' },
};

/** The roster teammate who makes reports (shared/team.ts). */
const REPORTS_MATE = 'reports';
const ASK_REPORT = 'Make me a one-page report of this month’s spending.';
/** hire.ts reads this to start with someone picked. */
export const HIRE_PICK_KEY = 'hearth.hire.pick';

/** Where the meeting room saves each meeting (server/meetings.ts MEETINGS_SAVED_DIR). */
const MEETINGS_DIR = 'reports/meetings/';
/** How many meeting records are opened for their recap headline (older ones show their question). */
const MEETINGS_READ = 12;

/** What a saved meeting says about itself, read from its first lines (server/meetings.ts save()). */
export interface MeetingRecord {
  title: string;
  /** "Debate", "Lead & team", … */
  kind?: string;
  kindIcon?: string;
  when?: string;
  stopped?: boolean;
  /** The recap's own headline (its first heading or line). */
  headline?: string;
  /** Who sat at the table, as the record names them. */
  table?: string;
}

/** Reads "# 🤝 title", the "🗣️ Debate meeting · … · ✅ done" line, "**At the table:** …" and the recap's first line. */
export function parseMeetingRecord(text: string): MeetingRecord {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const strip = (s: string) =>
    s
      .replace(/^#+\s*/, '')
      .replace(/[*_`]+/g, '')
      .replace(/^\p{Extended_Pictographic}️?\s*/u, '')
      .trim();
  const titleLine = lines.find((l) => /^#\s/.test(l)) ?? '';
  const rec: MeetingRecord = { title: strip(titleLine) || 'A meeting' };
  const meta = lines.find((l) => / meeting · /.test(l));
  if (meta) {
    const parts = meta.split(' · ');
    const m = /^(\p{Extended_Pictographic}️?)?\s*(.+?) meeting$/u.exec(parts[0].trim());
    if (m) {
      rec.kindIcon = m[1];
      rec.kind = m[2];
    }
    rec.when = parts[1]?.trim();
    rec.stopped = /stopped/i.test(meta);
  }
  const table = lines.find((l) => /^\*\*At the table:\*\*/.test(l));
  if (table) rec.table = table.replace(/^\*\*At the table:\*\*\s*/, '').trim();
  const at = lines.findIndex((l) => /^##\s.*Recap/i.test(l));
  if (at >= 0) {
    for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      const l = lines[i].trim();
      if (!l || /^_.*_$/.test(l)) continue;
      rec.headline = strip(l.replace(/^[-*]\s+/, ''));
      break;
    }
  }
  return rec;
}

export const reportsView: View = (root, ctx, route) => {
  if (!('floor' in route)) return;
  const floor = route.floor;
  const abort = new AbortController();
  let closeViewer: (() => void) | null = null;
  const offs: (() => void)[] = [];
  const records = new Map<string, MeetingRecord>();
  const fileUrl = (p: string) => `/api/reports/file?floor=${encodeURIComponent(floor)}&path=${encodeURIComponent(p)}`;

  const list = h('div.a-reports__list.a-sp-reports');
  root.replaceChildren(
    h(
      'section.a-v.a-reports',
      { 'aria-labelledby': 'a-reports-h' },
      h('header.a-v-head.a-sp-vhead', {}, h('h2.a-sp-vtitle', { id: 'a-reports-h' }, 'Made ', h('em', {}, 'for you')), h('p.a-sp-vsub', {}, 'Reports, charts and the record of every meeting.')),
      list,
    ),
  );

  const ghost = () =>
    h(
      'div.a-sp-rgrid',
      { 'aria-hidden': 'true' },
      ...[0, 1, 2].map(() => h('div.a-sp-rcard.a-sp-rcard--ghost', {}, skeleton('block', { height: 48, width: '48px' }), h('span.a-sp-rcard__text', {}, skeleton('line', { width: '60%' }), skeleton('line', { width: '40%' })))),
    );

  const open = (f: ReportFile, title: string, meta: string) => {
    const kind = kindOf(f.path);
    closeViewer = openDocViewer({ title, meta, url: fileUrl(f.path), kind, download: kind === 'html' ? undefined : baseName(f.path) });
  };

  const card = (f: ReportFile) => {
    const kind = kindOf(f.path);
    const t = TYPE[kind];
    const title = prettyName(f.path);
    const word = f.path.startsWith('charts/') && kind === 'image' ? 'Chart' : t.word;
    return h(
      'button.a-sp-rcard',
      { type: 'button', 'data-kind': kind, onclick: () => open(f, title, `${word} · ${shortDate(f.modified)}`) },
      h('span.a-sp-rcard__tile', { 'aria-hidden': 'true' }, icon(t.icon, 20), h('span.a-sp-rcard__ext', {}, extOf(f.path) || kind)),
      h(
        'span.a-sp-rcard__text',
        {},
        h('span.a-sp-rcard__title', {}, title),
        h('span.a-sp-rcard__meta', {}, `${word} · `, h('time', { datetime: new Date(f.modified).toISOString() }, timeAgo(f.modified)), ` · ${fileSize(f.size)}`),
      ),
      h('span.a-sp-rcard__chev', { 'aria-hidden': 'true' }, icon('forward', 18)),
    );
  };

  /** A meeting's record: its recap headline set large, the question under it, who sat at the table. */
  const meetingCard = (f: ReportFile) => {
    const r = records.get(`${f.path}:${f.modified}`);
    const title = r?.title ?? prettyName(f.path);
    const question = title.length > 140 ? `${title.slice(0, 139).trimEnd()}…` : title;
    const headline = r?.headline;
    return h(
      'button.a-sp-mcard',
      { type: 'button', 'data-state': r?.stopped ? 'stopped' : 'done', onclick: () => open(f, headline ?? title, `${r?.kind ? `${r.kind} meeting` : 'Meeting'} · ${shortDate(f.modified)}`) },
      h(
        'span.a-sp-mcard__top',
        {},
        h('span.a-sp-mcard__kind', {}, r?.kindIcon ? h('span', { 'aria-hidden': 'true' }, r.kindIcon) : null, r?.kind ?? 'Meeting'),
        h('time.a-sp-mcard__when', { datetime: new Date(f.modified).toISOString() }, timeAgo(f.modified)),
        r?.stopped ? h('span.a-sp-mcard__stopped', {}, 'Stopped early') : null,
      ),
      headline
        ? h('span.a-sp-mcard__headline', {}, headline)
        : r
          ? null
          : h('span.a-sp-mcard__headline.is-loading', { 'aria-hidden': 'true' }, skeleton('line', { width: '85%' }), skeleton('line', { width: '55%' })),
      h('span.a-sp-mcard__q', {}, headline ? h('span.a-sp-mcard__qlabel', {}, 'Asked') : null, h('span', {}, question)),
      h(
        'span.a-sp-mcard__foot',
        {},
        r?.table ? h('span.a-sp-mcard__table', {}, h('span.a-sp-mcard__tlabel', {}, 'At the table'), h('span', {}, r.table)) : h('span'),
        h('span.a-sp-mcard__read', {}, 'Read it', icon('forward', 16)),
      ),
    );
  };

  /** Nothing yet: invite her to ask the teammate who makes them (or to add them first). */
  const renderEmpty = () => {
    const maker = teamOn(floor).find((m) => m.role === REPORTS_MATE);
    const roster = TEAM_BY_ID.get(REPORTS_MATE);
    const el = maker
      ? emptyState({
          icon: 'reports',
          title: 'Nothing here yet',
          text: 'Ask a teammate for one — for example, “Make me a chart of this month’s spending.” Meetings leave their record here too.',
          action: {
            label: `Ask ${maker.name}`,
            variant: 'primary',
            onClick: () => {
              saveDraft(maker.id, ASK_REPORT);
              ctx.go({ view: 'chat', floor, worker: maker.id });
            },
          },
        })
      : roster
        ? emptyState({
            icon: 'reports',
            title: 'Nothing here yet',
            text: `${roster.name} turns the budget and your spending into one-page reports. Add them here, then ask for one.`,
            action: {
              label: `Add ${roster.name}`,
              icon: 'add',
              variant: 'secondary',
              onClick: () => {
                try {
                  sessionStorage.setItem(HIRE_PICK_KEY, JSON.stringify([REPORTS_MATE]));
                } catch {
                  // she picks them herself
                }
                ctx.go({ view: 'hire', floor });
              },
            },
          })
        : emptyState({ icon: 'reports', title: 'Nothing here yet', text: 'Ask a teammate for one — for example, “Make me a chart of this month’s spending.”' });
    list.replaceChildren(el);
  };

  let files: ReportFile[] | null = null;
  let lastKey = '';
  const isMeeting = (f: ReportFile) => f.path.startsWith(MEETINGS_DIR) && kindOf(f.path) === 'markdown';

  const draw = () => {
    if (!files) return;
    const meetings = files.filter(isMeeting);
    const rest = files.filter((f) => !isMeeting(f));
    const section = (id: string, title: string, count: number, kids: HTMLElement[], cls: string) =>
      h('section.a-sp-rsec', { 'aria-labelledby': id }, h('h3.a-sp-h3', { id }, title, h('span.a-sp-h3__count.a-num', {}, String(count))), h(`div.${cls}`, {}, ...kids));
    list.replaceChildren(
      ...(meetings.length ? [section('a-reports-meetings', 'Meetings', meetings.length, meetings.map(meetingCard), 'a-sp-mgrid')] : []),
      ...(rest.length ? [section('a-reports-files', 'Reports', rest.length, rest.map(card), 'a-sp-rgrid')] : []),
    );
  };

  /** Opens the newest meeting records for their recap headline, then redraws once. */
  const readMeetings = async () => {
    const todo = (files ?? []).filter((f) => isMeeting(f) && !records.has(`${f.path}:${f.modified}`)).slice(0, MEETINGS_READ);
    if (!todo.length) return;
    await Promise.all(
      todo.map(async (f) => {
        try {
          const res = await fetch(fileUrl(f.path), { cache: 'no-store', signal: abort.signal });
          if (!res.ok) throw new Error(String(res.status));
          records.set(`${f.path}:${f.modified}`, parseMeetingRecord(await res.text()));
        } catch {
          if (!abort.signal.aborted) records.set(`${f.path}:${f.modified}`, { title: prettyName(f.path) });
        }
      }),
    );
    if (!abort.signal.aborted) draw();
  };

  const load = async (quiet = false) => {
    const stop = quiet ? () => {} : lateSkeleton(list, ghost());
    if (!quiet) list.setAttribute('aria-busy', 'true');
    const r = await getJson<{ files?: ReportFile[] }>(`/api/reports?floor=${encodeURIComponent(floor)}`, abort.signal);
    stop();
    list.removeAttribute('aria-busy');
    if (abort.signal.aborted) return;
    if (!r.ok || !Array.isArray(r.data.files)) {
      if (!quiet) list.replaceChildren(errorBlock('Couldn’t load the reports', 'Something went wrong on our side. Try again in a moment.', () => void load()));
      return;
    }
    files = [...r.data.files].sort((a, b) => b.modified - a.modified);
    const key = files.map((f) => `${f.path}:${f.modified}`).join('|');
    if (quiet && key === lastKey) return;
    lastKey = key;
    if (!files.length) {
      // Wait for the team list before choosing Ask vs Add.
      if (teamReady()) renderEmpty();
      return;
    }
    draw();
    list.querySelectorAll('.a-sp-mgrid, .a-sp-rgrid').forEach((g) => g.classList.add('a-v-stagger'));
    void readMeetings();
  };

  // The empty state names the teammate who's here, so it follows the team list.
  offs.push(
    onTeam(() => {
      if (files && !files.length) renderEmpty();
    }),
  );
  // A meeting that just finished saves its record: show it without a reload.
  let meetingSig = '';
  offs.push(
    ctx.on('meeting', () => {
      const m = ctx.store.meeting.current;
      const sig = `${m?.id}:${m?.status}:${m?.saved}:${m?.recapState}`;
      if (sig !== meetingSig) {
        meetingSig = sig;
        void load(true);
      }
    }),
  );
  // Back from asking for a report: show the new one without a reload.
  const onVisible = () => {
    if (document.visibilityState === 'visible') void load(true);
  };
  document.addEventListener('visibilitychange', onVisible);
  void load();

  return () => {
    abort.abort();
    document.removeEventListener('visibilitychange', onVisible);
    offs.forEach((off) => off());
    closeViewer?.();
  };
};
