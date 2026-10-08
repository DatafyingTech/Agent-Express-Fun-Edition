// Notes segment of a space (route `memory`, DESIGN.md §6.3): "What the team knows". The space's
// shared memory as she'd read it: the summary everyone works from (CURRENT.md), the dated notes
// (newest first, a day at a time), the files the team keeps (a CSV opens as a table), and a box to
// tell the whole team something, which lands in today's notes for every teammate to read.

import type { View } from '../context';
import type { MemoryFile, MemoryNoteRequest, MemoryResponse } from '../../../shared/app-api';
import { icon } from '../icons';
import { clockTime, dayLabel, emptyState, fileSize, h, lateSkeleton, setBusy, shortDate, signInAgain, skeleton, spaceName } from '../ui';
import { ago, baseName, errorBlock, extOf, getJson, glyph, kindOf, openDocViewer, prose } from './reports';

/** Days of notes shown before "Show older". */
const DAYS_PAGE = 20;
const FILES_PAGE = 12;
const NOTE_MAX = 4000;
/** A summary longer than this starts folded (about 12 lines on a phone). */
const FOLD_LINES = 14;
const FOLD_CHARS = 900;

interface Entry {
  /** "4:12 PM", when the heading said. */
  time?: string;
  who?: string;
  body: string;
}

/**
 * A day's log as separate notes, newest first. Entries are `## HH:MM · who …` headings (the app's
 * own notes are "## 16:12 · note from Sam (via the app)"); a file without them is one note.
 */
export function parseDay(text: string): Entry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let lead: string[] = [];
  const HEAD = /^#{2,3}\s+(?:\d{4}-\d{2}-\d{2}[T ,]*)?(\d{1,2}):(\d{2})\b\s*[·•\-–—:,]?\s*(.*)$/;
  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      const d = new Date();
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      const who = m[3]
        .replace(/^note from\s+/i, '')
        .replace(/\s*\(via the app\)\s*$/i, '')
        .trim();
      cur = { time: clockTime(d.getTime()), who: who || undefined, body: '' };
      continue;
    }
    if (cur) cur.body += `${line}\n`;
    else lead.push(line);
  }
  if (cur) entries.push(cur);
  if (!entries.length) return [{ body: text }];
  // What came before the first timed note, minus a bare "# 2026-09-29" title.
  const before = lead.filter((l) => !/^#\s/.test(l)).join('\n').trim();
  if (before) entries.unshift({ body: before });
  lead = [];
  return entries.reverse();
}

/** "log/2026-09-29.md" → that day at noon (ms), or the file's time when the name isn't a date. */
function dayOf(f: MemoryFile): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(f.name);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime() : f.modified;
}

const noteKey = (floor: string) => `hearth.note.${floor}`;

export const notesView: View = (root, ctx, route) => {
  if (!('floor' in route)) return;
  const floor = route.floor;
  const abort = new AbortController();
  const closers = new Set<() => void>();
  const fileUrl = (p: string) => `/api/memory/file?floor=${encodeURIComponent(floor)}&path=${encodeURIComponent(p)}`;
  const space = spaceName(floor);

  const updated = h('p.a-sp-vsub', {});
  const summary = h('div.a-notes__summary');
  const composer = h('div.a-notes__tell');
  const timeline = h('div.a-notes__days');
  const files = h('div.a-notes__files');
  const body = h('div.a-notes__body', { 'aria-live': 'polite' });

  root.replaceChildren(
    h('section.a-notes.a-sp-notes', { 'aria-labelledby': 'a-notes-h' }, h('header.a-v-head.a-sp-vhead', {}, h('h2.a-sp-vtitle', { id: 'a-notes-h' }, 'What the team ', h('em', {}, 'knows')), updated), body),
  );

  // ---------------------------------------------------------------------------------------------
  // Tell the team something
  // ---------------------------------------------------------------------------------------------
  const ta = h('textarea.a-field__control.a-notes__input', {
    id: 'a-notes-input',
    rows: 3,
    maxlength: NOTE_MAX,
    placeholder: 'Something everyone should know, like “Grandma visits on the 12th”…',
    autocapitalize: 'sentences',
    spellcheck: 'true',
    'aria-describedby': 'a-notes-help',
  }) as HTMLTextAreaElement;
  try {
    ta.value = sessionStorage.getItem(noteKey(floor)) ?? '';
  } catch {
    // storage blocked
  }
  const help = h('p.a-notes__help', { id: 'a-notes-help' }, `Every teammate in ${space} reads it before they answer.`);
  const err = h('p.a-field__error', { id: 'a-notes-err', role: 'alert', hidden: true });
  const share = h('button.a-btn.a-btn--primary', { type: 'submit' }, h('span.a-btn__label', {}, 'Share with the team')) as HTMLButtonElement;
  const form = h(
    'form.a-notes__form',
    {},
    h('label.a-notes__label', { for: 'a-notes-input' }, glyph('quote', 16), 'Tell the team something'),
    ta,
    help,
    err,
    h('div.a-notes__actions', {}, share),
  ) as HTMLFormElement;
  form.noValidate = true;

  const paintShare = () => {
    const n = ta.value.trim().length;
    const empty = n === 0;
    share.setAttribute('aria-disabled', String(empty));
    share.classList.toggle('is-disabled', empty);
    help.textContent = n > NOTE_MAX - 500 ? `${(NOTE_MAX - ta.value.length).toLocaleString('en-US')} characters left` : `Every teammate in ${space} reads it before they answer.`;
  };
  ta.addEventListener('input', () => {
    try {
      sessionStorage.setItem(noteKey(floor), ta.value);
    } catch {
      // storage blocked
    }
    err.hidden = true;
    ta.removeAttribute('aria-invalid');
    paintShare();
  });

  const showError = (text: string) => {
    err.replaceChildren(icon('warning', 16), h('span', {}, text));
    err.hidden = false;
    ta.setAttribute('aria-invalid', 'true');
    ta.setAttribute('aria-describedby', 'a-notes-help a-notes-err');
  };

  const shared = (text: string) => {
    const again = h('button.a-btn.a-btn--ghost.a-btn--sm', { type: 'button' }, 'Write another');
    const done = h(
      'div.a-notes__shared',
      { role: 'status', tabindex: -1 },
      h('span.a-notes__shared-mark', {}, icon('check', 20)),
      h('div', {}, h('p.a-notes__shared-title', {}, 'Shared with the team'), h('p.a-notes__shared-text', {}, `“${text.length > 90 ? `${text.slice(0, 89)}…` : text}” is in today’s notes. Everyone in ${space} will see it.`)),
      again,
    );
    again.addEventListener('click', () => {
      composer.replaceChildren(form);
      ta.focus();
    });
    composer.replaceChildren(done);
    done.focus();
  };

  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (sending) return;
    if (!text) {
      showError('Write a note first.');
      ta.focus();
      return;
    }
    sending = true;
    setBusy(share, true);
    // Who it's from: her account, else the name this device goes by (without the app's "📱").
    const own = ctx.store.profile.name.replace(/\s*\p{Extended_Pictographic}+\s*$/u, '').trim();
    const by = ctx.store.me.account?.name ?? (own && own !== 'Guest' ? own : undefined);
    const req: MemoryNoteRequest = by ? { text, by } : { text };
    let status = 0;
    try {
      const res = await fetch(`/api/memory/note?floor=${encodeURIComponent(floor)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: abort.signal });
      status = res.status;
    } catch {
      status = 0;
    }
    sending = false;
    setBusy(share, false);
    if (abort.signal.aborted) return;
    if (status === 401) return signInAgain();
    if (status >= 200 && status < 300) {
      ta.value = '';
      try {
        sessionStorage.removeItem(noteKey(floor));
      } catch {
        // storage blocked
      }
      paintShare();
      shared(text);
      void load(true);
      return;
    }
    if (status === 413 || status === 400) showError(`That note is too long or empty. Keep it under ${NOTE_MAX.toLocaleString('en-US')} characters.`);
    else if (status === 404) showError('Notes can’t be saved in this space yet. Try again a little later.');
    else if (status === 0) showError('Couldn’t reach the team. Check your connection and try again.');
    else showError('Something went wrong on our side. Try again in a moment.');
  });
  paintShare();
  composer.replaceChildren(form);

  // ---------------------------------------------------------------------------------------------
  // The summary
  // ---------------------------------------------------------------------------------------------
  const renderSummary = (current: string) => {
    if (!current.trim()) {
      summary.replaceChildren(h('div.a-card.a-notes__card.a-notes__card--empty', {}, h('p', {}, 'No summary yet. Once the team has something worth keeping, it shows up here.')));
      return;
    }
    const long = current.split('\n').length > FOLD_LINES || current.length > FOLD_CHARS;
    const text = prose(current);
    text.id = 'a-notes-summary';
    text.classList.add('a-sp-prose');
    const card = h('article.a-card.a-notes__card.a-sp-doc', { 'aria-label': 'Where things stand' }, h('p.a-sp-doc__eyebrow', {}, glyph('sparkle', 14), 'Where things stand'), text);
    if (long) {
      card.classList.add('is-folded');
      const more = h('button.a-btn.a-btn--ghost.a-btn--sm.a-notes__more', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'a-notes-summary' }, 'Show all');
      more.addEventListener('click', () => {
        const open = card.classList.toggle('is-folded') === false;
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show less' : 'Show all';
        if (!open) card.scrollIntoView({ block: 'nearest' });
      });
      card.append(h('div.a-notes__fold', {}, more));
    }
    summary.replaceChildren(card);
  };

  // ---------------------------------------------------------------------------------------------
  // Recent notes: a day at a time, newest first. A day's notes load when it opens.
  // ---------------------------------------------------------------------------------------------
  const dayCache = new Map<string, string>();
  const dayBlock = (f: MemoryFile, open: boolean) => {
    const t = dayOf(f);
    const content = h('div.a-notes__entries');
    const details = h(
      'details.a-notes__day',
      {},
      h('summary.a-notes__daysum', {}, h('span.a-notes__daylabel', {}, dayLabel(t)), dayLabel(t) === shortDate(t) ? null : h('span.a-notes__daydate', {}, shortDate(t)), h('span.a-notes__chev', {}, icon('down', 18))),
      content,
    ) as HTMLDetailsElement;
    let loaded = false;
    const fill = async () => {
      if (loaded) return;
      loaded = true;
      const key = `${f.path}:${f.modified}`;
      let text = dayCache.get(key);
      if (text === undefined) {
        content.replaceChildren(h('div.a-notes__entry.a-notes__entry--ghost', { 'aria-hidden': 'true' }, skeleton('line', { width: '30%' }), skeleton('line', { width: '85%' }), skeleton('line', { width: '60%' })));
        try {
          const res = await fetch(fileUrl(f.path), { cache: 'no-store', signal: abort.signal });
          if (!res.ok) throw new Error();
          text = await res.text();
          dayCache.set(key, text);
        } catch {
          if (abort.signal.aborted) return;
          loaded = false;
          content.replaceChildren(h('p.a-notes__dayerr', {}, 'Couldn’t open these notes. Close and open the day to try again.'));
          return;
        }
      }
      const entries = parseDay(text);
      content.replaceChildren(
        ...entries.map((e) =>
          h(
            'article.a-notes__entry',
            {},
            e.time || e.who ? h('p.a-notes__entryhead', {}, e.time ? h('span.a-notes__time.a-num', {}, e.time) : null, e.who ? h('span.a-notes__who', {}, e.who) : null) : null,
            (() => {
              const p = prose(e.body);
              p.classList.add('a-sp-prose', 'a-sp-prose--small');
              return p;
            })(),
          ),
        ),
      );
    };
    details.addEventListener('toggle', () => {
      if (details.open) void fill();
    });
    if (open) {
      details.open = true;
      void fill();
    }
    return details;
  };

  let daysShown = DAYS_PAGE;
  const renderTimeline = (logs: MemoryFile[]) => {
    const sorted = [...logs].sort((a, b) => dayOf(b) - dayOf(a) || b.modified - a.modified);
    const head = h('h3.a-sp-h3', {}, 'Recent notes');
    if (!sorted.length) {
      timeline.replaceChildren(head, h('p.a-notes__none', {}, 'No notes yet. The team writes down what they learn as they go.'));
      return;
    }
    const list = h('div.a-notes__daylist', {}, ...sorted.slice(0, daysShown).map((f, i) => dayBlock(f, i === 0)));
    const older = sorted.length > daysShown ? h('button.a-btn.a-btn--ghost.a-notes__older', { type: 'button' }, 'Show older') : null;
    older?.addEventListener('click', () => {
      const from = daysShown;
      daysShown += DAYS_PAGE;
      const more = sorted.slice(from, daysShown).map((f) => dayBlock(f, false));
      list.append(...more);
      (more[0]?.querySelector('summary') as HTMLElement | null)?.focus();
      if (sorted.length <= daysShown) older.remove();
    });
    timeline.replaceChildren(head, list, older ?? '');
  };

  // ---------------------------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------------------------
  let filesShown = FILES_PAGE;
  const fileRow = (f: MemoryFile) => {
    const kind = kindOf(f.path);
    const folder = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : '';
    return h(
      'button.a-row.a-notes__file',
      {
        type: 'button',
        onclick: () => {
          const close = openDocViewer({ title: baseName(f.name), meta: `Updated ${shortDate(f.modified)} · ${fileSize(f.size)}`, url: fileUrl(f.path), kind, download: baseName(f.name) });
          closers.add(close);
        },
      },
      h('span.a-row__lead', {}, h('span.a-notes__filetile.a-sp-filetile', { 'data-ext': extOf(f.name), 'aria-hidden': 'true' }, icon(kind === 'markdown' ? 'notes' : 'file', 18), h('span.a-sp-filetile__ext', {}, extOf(f.name) || 'file'))),
      h('span.a-row__text', {}, h('span.a-row__title.a-notes__filename', {}, baseName(f.name)), h('span.a-row__meta', {}, `${folder ? `${folder} · ` : ''}Updated ${ago(f.modified)} · ${fileSize(f.size)}`)),
      h('span.a-row__trail', { 'aria-hidden': 'true' }, h('span.a-row__chev', {}, icon('forward', 18))),
    );
  };
  const renderFiles = (data: MemoryFile[]) => {
    if (!data.length) {
      files.replaceChildren();
      return;
    }
    const group = h('div.a-group.a-sp-files', {}, ...data.slice(0, filesShown).map(fileRow));
    const more = data.length > filesShown ? h('button.a-btn.a-btn--ghost.a-notes__older', { type: 'button' }, `Show all ${data.length}`) : null;
    more?.addEventListener('click', () => {
      filesShown = data.length;
      renderFiles(data);
    });
    files.replaceChildren(h('h3.a-sp-h3', {}, 'What they keep'), group, more ?? '');
  };

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------
  const ghost = () =>
    h(
      'div.a-notes__ghost',
      { 'aria-hidden': 'true' },
      h('div.a-card.a-notes__card', {}, ...['40%', '95%', '88%', '92%', '70%', '84%'].map((w) => skeleton('line', { width: w }))),
      h('div.a-notes__ghosthead', {}, skeleton('line', { width: '30%' })),
      h('div.a-card', {}, skeleton('line', { width: '50%' }), skeleton('line', { width: '80%' })),
    );

  let lastKey = '';
  const load = async (quiet = false) => {
    const stop = quiet ? () => {} : lateSkeleton(body, ghost());
    if (!quiet) body.setAttribute('aria-busy', 'true');
    const r = await getJson<MemoryResponse>(`/api/memory?floor=${encodeURIComponent(floor)}`, abort.signal);
    stop();
    body.removeAttribute('aria-busy');
    if (abort.signal.aborted) return;
    if (!r.ok) {
      if (quiet) return;
      updated.textContent = '';
      body.replaceChildren(
        r.status === 404
          ? errorBlock('Notes aren’t ready here yet', 'This space’s notes will show up here soon. Try again in a little while.', () => void load())
          : errorBlock('Couldn’t load the notes', 'Something went wrong on our side. Try again in a moment.', () => void load()),
      );
      return;
    }
    const m = r.data;
    const key = JSON.stringify([m.current, m.logs.map((f) => f.path + f.modified), m.data.map((f) => f.path + f.modified)]);
    if (quiet && key === lastKey) return;
    lastKey = key;
    const newest = Math.max(0, ...m.logs.map((f) => f.modified), ...m.data.map((f) => f.modified));
    updated.textContent = newest ? `Updated ${ago(newest)}` : '';
    const nothing = !m.current.trim() && !m.logs.length && !m.data.length;
    if (nothing) {
      body.replaceChildren(
        emptyState({ icon: 'notes', title: 'Nothing written down yet', text: 'As your team learns things about the house, they’ll keep notes here.' }),
        composer,
      );
      return;
    }
    renderSummary(m.current);
    renderTimeline(m.logs);
    renderFiles(m.data);
    body.replaceChildren(summary, composer, timeline, files);
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void load(true);
  };
  document.addEventListener('visibilitychange', onVisible);
  void load();

  return () => {
    abort.abort();
    document.removeEventListener('visibilitychange', onVisible);
    closers.forEach((c) => c());
  };
};
