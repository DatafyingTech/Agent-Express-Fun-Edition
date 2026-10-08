// Chats (DESIGN.md §6.2): every teammate she's talked with, across her spaces, newest first
// (Messages-style), with whoever needs her in their own group at the top. Pills filter by "Needs you"
// or by space once the list is long. Also lends its rows to the wide chat screen's left column
// (views/chat.ts).

import type { View } from '../context';
import {
  avatar,
  badge,
  byStatus,
  doingLine,
  emptyState,
  h,
  hrefOf,
  lateSkeleton,
  needsHer,
  onTeam,
  pillTabs,
  plural,
  skeletonRows,
  spaceColor,
  spaceEmoji,
  SPACES_EVENT,
  splitSpaceName,
  teamFloors,
  teamReady,
  timeShort,
  uiStatus,
  visibleSpaces,
  type SegmentedControl,
  type TeamEntry,
} from '../ui';

export type ChatEntry = TeamEntry & { floor: string; floorName: string };

/** Everyone with a conversation (or who needs her) in the visible spaces: needs-you first, then newest. */
export function chatEntries(): ChatEntry[] {
  const shown = new Set(visibleSpaces().map((f) => f.id));
  const all = teamFloors()
    .filter((f) => shown.has(f.id))
    .flatMap((f) => f.workers.map((w) => ({ ...w, floor: f.id, floorName: splitSpaceName(f.name).title })))
    .filter((w) => w.lastMessageAt || needsHer(w));
  return all.sort((a, b) => {
    const na = needsHer(a) ? 0 : 1;
    const nb = needsHer(b) ? 0 : 1;
    if (na !== nb) return na - nb;
    if (na === 0) return byStatus(a, b);
    return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
  });
}

/** One conversation row: avatar, name + time, space, preview + an ember dot when she's needed. */
export function chatRow(w: ChatEntry, opts: { compact?: boolean; current?: boolean; showSpace?: boolean } = {}): HTMLElement {
  const needs = needsHer(w);
  const when = w.lastMessageAt ?? w.waitingSince;
  return h(
    'a.a-row.a-chat-row',
    {
      href: hrefOf({ view: 'chat', floor: w.floor, worker: w.id }),
      'data-id': w.id,
      'aria-current': opts.current ? 'page' : undefined,
      class: `${opts.compact ? 'a-row--compact' : ''}${needs ? ' is-needs' : ''}`,
      style: `--a-space:${spaceColor(w.floor)}`,
    },
    h('span.a-row__lead', {}, avatar(w, opts.compact ? 40 : 48)),
    h(
      'span.a-row__text',
      {},
      h('span.a-row__top', {}, h('span.a-row__title', {}, w.name), when ? h('span.a-row__meta', {}, timeShort(when)) : null),
      opts.showSpace !== false ? h('span.a-caption.a-chat-row__space', {}, w.floorName) : null,
      h(
        'span.a-row__line',
        {},
        h('span.a-row__sub', {}, h('span.a-sr-only', {}, needs ? (uiStatus(w) === 'needs' ? 'Needs you. ' : 'Finished. ') : ''), doingLine(w)),
        needs ? badge() : null,
      ),
    ),
  );
}

/** Pills show once there are enough chats to want sorting. */
const FILTER_AT = 6;

export const chatsView: View = (root, ctx) => {
  /** 'all', 'needs', or a space id. */
  let filter = 'all';
  const title = h('h1.a-large-title', {}, 'Chats');
  const sub = h('p.a-callout.a-chats__sub');
  const filterBox = h('div.a-chats__filter');
  const listBox = h('div.a-chats__list', { 'aria-live': 'polite' });
  root.append(h('div.a-page.a-page--read.a-page--top.a-chats', {}, h('header.a-chats__head', {}, title, sub), filterBox, listBox));

  let doneLoading: (() => void) | null = teamReady() ? null : lateSkeleton(listBox, skeletonRows(5));
  let lastSig = '';
  let lastPillsSig = '';
  let pills: SegmentedControl | null = null;
  let firstPaint = true;

  const group = (label: string | null, rows: ChatEntry[], multiSpace: boolean, needCount: number) => {
    const g = h('div.a-group', { role: 'list', 'aria-label': label ?? (needCount ? `Chats, ${needCount} need you` : 'Chats') });
    g.append(...rows.map((w, i) => h('div.a-row-wrap', { role: 'listitem', style: `--i:${i}` }, chatRow(w, { showSpace: multiSpace }))));
    if (firstPaint) g.classList.add('a-stagger');
    return label ? h('section', {}, h('h2.a-overline.a-chats__group-label', {}, label), g) : g;
  };

  const render = () => {
    if (!teamReady() && !ctx.store.workers.size) return;
    if (doneLoading) {
      doneLoading();
      doneLoading = null;
    }
    const all = chatEntries();
    const spaces = visibleSpaces();
    const multiSpace = new Set(all.map((w) => w.floor)).size > 1 || spaces.length > 1;
    const needCount = all.filter(needsHer).length;
    sub.textContent = all.length ? `${needCount ? `${needCount} need${needCount === 1 ? 's' : ''} you · ` : ''}${plural(all.length, 'conversation')}` : '';

    // ---- Filter pills: All · Needs you · each space that has chats ----
    const withChats = spaces.filter((f) => all.some((w) => w.floor === f.id));
    const pillsSig = all.length > FILTER_AT ? `${needCount}|${withChats.map((f) => f.id).join(',')}` : '';
    if (pillsSig !== lastPillsSig) {
      lastPillsSig = pillsSig;
      if (!pillsSig) {
        pills = null;
        filter = 'all';
        filterBox.replaceChildren();
      } else {
        if (filter !== 'all' && filter !== 'needs' && !withChats.some((f) => f.id === filter)) filter = 'all';
        pills = pillTabs({
          label: 'Show',
          value: filter,
          items: [
            { value: 'all', label: 'All' },
            { value: 'needs', label: 'Needs you', count: needCount || undefined },
            ...(multiSpace ? withChats.map((f) => ({ value: f.id, label: `${spaceEmoji(f)} ${splitSpaceName(f.name).title}` })) : []),
          ],
          onChange: (v) => {
            filter = v;
            lastSig = '';
            render();
          },
        });
        filterBox.replaceChildren(pills);
      }
    }

    const shown = filter === 'needs' ? all.filter(needsHer) : filter === 'all' ? all : all.filter((w) => w.floor === filter);
    const sig = `${filter}|${multiSpace}|` + shown.map((w) => `${w.id}:${w.status}:${w.acked}:${w.lastMessageAt ?? ''}:${doingLine(w)}`).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    if (!shown.length) {
      listBox.replaceChildren(
        filter === 'needs'
          ? emptyState({ icon: 'check', title: "You're all caught up", text: 'Nobody needs you right now.' })
          : emptyState({ icon: 'chats', title: 'No chats yet', text: 'Open a space and tap a teammate to start.', action: { label: 'Go to your spaces', variant: 'secondary', href: '#/home' } }),
      );
      return;
    }
    const focusedId = (document.activeElement as HTMLElement | null)?.closest?.('.a-chat-row')?.getAttribute('data-id');
    // Whoever needs her gets a group of their own at the top; the rest are the recent conversations.
    const waiting = shown.filter(needsHer);
    const rest = shown.filter((w) => !needsHer(w));
    // Filtered to one space, the rows needn't say which space they're in.
    const showSpace = multiSpace && (filter === 'all' || filter === 'needs');
    const parts: HTMLElement[] = [];
    if (filter === 'needs' || !waiting.length || !rest.length) parts.push(group(null, shown, showSpace, needCount));
    else parts.push(group('Needs you', waiting, showSpace, needCount), group('Recent', rest, showSpace, needCount));
    listBox.replaceChildren(...parts);
    firstPaint = false;
    if (focusedId) listBox.querySelector<HTMLElement>(`.a-chat-row[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  };

  render();
  const offTeam = onTeam(render);
  ctx.on('floors', render);
  ctx.on('workers', render);
  window.addEventListener(SPACES_EVENT, render);
  const tick = setInterval(() => {
    lastSig = '';
    render();
  }, 60_000);
  return () => {
    offTeam();
    clearInterval(tick);
    window.removeEventListener(SPACES_EVENT, render);
  };
};
