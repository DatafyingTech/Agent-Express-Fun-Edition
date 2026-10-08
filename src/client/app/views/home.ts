// Home (DESIGN.md §6.1, REDESIGN.md §2.1): the date and a serif greeting with one sentence about the
// house, then who needs her (cards, like notes left on the kitchen table), what's happening right now
// (teammates at work, a meeting in the room), her spaces as a bento of cards in each space's color,
// and what today has cost. No header bar: the greeting is the header.

import type { View } from '../context';
import { fmtCost, type PlanWindow } from '../../../shared/protocol';
import { MEETING_PATTERNS } from '../../../shared/meetings';
import { icon } from '../icons';
import {
  avatar,
  avatarStack,
  button,
  byStatus,
  doingLine,
  firstName,
  genericLine,
  glassCard,
  h,
  hrefOf,
  lateSkeleton,
  meter,
  needsHer,
  onTeam,
  plural,
  skeleton,
  spaceColor,
  spaceEmoji,
  spaceName,
  SPACES_EVENT,
  splitSpaceName,
  teamFloors,
  teamReady,
  timeShort,
  uiStatus,
  visibleSpaces,
  type TeamEntry,
} from '../ui';

const MAX_CARDS = 5;
const MAX_NOW = 8;

function greeting(now = new Date()): string {
  const hr = now.getHours();
  return hr >= 5 && hr < 12 ? 'Good morning' : hr >= 12 && hr < 17 ? 'Good afternoon' : 'Good evening';
}

type Placed = TeamEntry & { floor: string; floorName: string };

/** The one sentence under the greeting (§6.1), first rule that applies. */
function summaryLine(all: Placed[]): string {
  const needs = all.filter((w) => uiStatus(w) === 'needs');
  const done = all.filter((w) => uiStatus(w) === 'done');
  const working = all.filter((w) => uiStatus(w) === 'working');
  if (needs.length === 1) return `${needs[0].name} needs you.${working.length ? ' Everyone else is humming along.' : ''}`;
  if (needs.length > 1) return `${needs.length} teammates need you.${working.length ? ` ${plural(working.length, 'other')} ${working.length === 1 ? 'is' : 'are'} busy.` : ''}`;
  if (done.length === 1) return `${done[0].name} finished something for you.`;
  if (done.length > 1) return `${done.length} things are ready for you.`;
  if (working.length) return `${plural(working.length, 'teammate')} ${working.length === 1 ? 'is' : 'are'} working on things.`;
  return 'All quiet. Nothing needs you right now.';
}

function inboxLine(w: TeamEntry): string {
  const line = doingLine(w);
  if (uiStatus(w) === 'done') return line === genericLine(w) ? line : `Finished: ${line}`;
  return line;
}

/** "in 12 min", "in 2 hr 5 min", or "Tue 5:00 AM" once it's more than a day away. */
function resetIn(at: number, now = Date.now()): string {
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ''}`;
  return new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** A plan window's name in plain words. */
function windowName(w: PlanWindow): string {
  if (/^5h/i.test(w.label)) return 'This 5-hour stretch';
  if (/^week$/i.test(w.label)) return 'This week';
  return w.label.replace(/\bweek\b/i, 'this week');
}

export const homeView: View = (root, ctx) => {
  const date = h('p.a-overline.a-home__date');
  const hello = h('h1.a-greeting');
  const summary = h('p.a-home__summary');
  const needsTitle = h('h2.a-section-title', { id: 'a-home-needs' }, 'Needs you');
  const needsBox = h('div.a-home__needs');
  const nowBox = h('div.a-now', { role: 'list', 'aria-labelledby': 'a-home-now' });
  const nowSection = h('section.a-home__now', { 'aria-labelledby': 'a-home-now', hidden: true }, h('h2.a-section-title', { id: 'a-home-now' }, 'Happening now'), nowBox);
  const spacesBox = h('div.a-home__spaces');
  const todayBox = h('div');
  const todaySection = h('section.a-home__today', { 'aria-labelledby': 'a-home-today', hidden: true }, h('h2.a-section-title', { id: 'a-home-today' }, 'Today'), todayBox);

  const page = h(
    'div.a-page.a-page--top.a-home',
    {},
    h('section.a-home__hello', {}, date, hello, summary),
    h('section.a-home__inbox', { 'aria-labelledby': 'a-home-needs' }, needsTitle, needsBox),
    nowSection,
    h('section.a-home__your-spaces', { 'aria-labelledby': 'a-home-spaces' }, h('h2.a-section-title', { id: 'a-home-spaces' }, 'Your spaces'), spacesBox),
    todaySection,
  );
  root.append(page);

  let doneLoading: (() => void) | null = teamReady()
    ? null
    : lateSkeleton(needsBox, h('div.a-home__skeleton', { 'aria-busy': 'true' }, skeleton('block', { height: 96 }), skeleton('block', { height: 96 })));
  let firstPaint = true;
  let lastNeedsSig = '';
  let lastNowSig = '';
  let lastSpacesSig = '';
  let lastTodaySig = '';
  let lastHello = '';

  const everyone = (): Placed[] => {
    const shown = new Set(visibleSpaces().map((f) => f.id));
    return teamFloors()
      .filter((f) => shown.has(f.id))
      .flatMap((f) => f.workers.map((w) => ({ ...w, floor: f.id, floorName: splitSpaceName(f.name).title })));
  };

  const renderHello = () => {
    const name = firstName();
    const now = new Date();
    date.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const sig = `${greeting(now)}|${name}`;
    if (sig === lastHello) return;
    lastHello = sig;
    // The name sits on its own line in italics: a word of emphasis, set like a letter.
    hello.replaceChildren(name ? `${greeting(now)},` : `${greeting(now)}.`, name ? h('br') : '', name ? h('em', {}, `${name}.`) : '');
  };

  // ---- Happening now: teammates at work, and a meeting in the room ------------------------------
  const renderNow = (all: Placed[]) => {
    const working = all.filter((w) => uiStatus(w) === 'working').sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    const m = ctx.store.meeting.current;
    const mFloor = ctx.store.floor;
    const shown = new Set(visibleSpaces().map((f) => f.id));
    const meetingLive = m && m.status === 'running' && mFloor && shown.has(mFloor) ? m : null;
    const sig = `${meetingLive ? `${meetingLive.id}:${meetingLive.round}/${meetingLive.rounds}:${meetingLive.title}` : ''}|` + working.slice(0, MAX_NOW).map((w) => `${w.id}:${doingLine(w)}`).join('|');
    if (sig === lastNowSig) return;
    lastNowSig = sig;
    const chips: HTMLElement[] = [];
    if (meetingLive && mFloor) {
      const p = MEETING_PATTERNS[meetingLive.pattern];
      const progress = meetingLive.rounds ? Math.min(1, Math.max(0, (meetingLive.round - 1) / meetingLive.rounds + 0.5 / meetingLive.rounds)) : 0;
      chips.push(
        h(
          'a.a-now__chip.a-now__chip--meeting',
          { href: hrefOf({ view: 'meetings', floor: mFloor }), role: 'listitem', style: `--a-space:${spaceColor(mFloor)}` },
          h('span.a-now__mark', { style: `--a-p:${progress.toFixed(3)}`, 'aria-hidden': 'true' }, icon('group', 18)),
          h(
            'span.a-now__text',
            {},
            h('span.a-now__name', {}, meetingLive.title || p?.label || 'Meeting'),
            h('span.a-now__line', {}, h('span.a-now__live', {}, 'Meeting'), ` · Round ${meetingLive.round} of ${meetingLive.rounds} · ${spaceName(mFloor)}`),
          ),
        ),
      );
    }
    for (const w of working.slice(0, MAX_NOW)) {
      chips.push(
        h(
          'a.a-now__chip',
          { href: hrefOf({ view: 'chat', floor: w.floor, worker: w.id }), role: 'listitem' },
          avatar(w, 40),
          h('span.a-now__text', {}, h('span.a-now__name', {}, w.name), h('span.a-now__line', {}, doingLine(w) === genericLine(w) ? w.floorName : doingLine(w))),
        ),
      );
    }
    nowSection.hidden = !chips.length;
    nowBox.replaceChildren(...chips);
  };

  // ---- Today: what the office has spent, and how much of the plan is left -----------------------
  const renderToday = () => {
    const u = ctx.store.usage;
    const lim = ctx.store.limits;
    const has = u.total.calls > 0 || u.budget !== undefined || lim.windows.length > 0;
    const sig = has ? `${u.today.cost.toFixed(2)}|${u.budget ?? ''}|${lim.windows.map((w) => `${w.label}:${Math.round(w.pct)}:${w.resetsAt ? resetIn(w.resetsAt) : ''}`).join(',')}` : '';
    if (sig === lastTodaySig) return;
    lastTodaySig = sig;
    todaySection.hidden = !has;
    if (!has) return todayBox.replaceChildren();
    // Nothing spent (the plan pays): the headline is how much of the current stretch is used instead.
    const byMoney = u.today.cost > 0 || u.budget !== undefined || !lim.windows.length;
    const lead = byMoney ? null : lim.windows[0];
    const headline = lead ? `${Math.round(lead.pct)}%` : u.today.costKnown === false ? '—' : fmtCost(u.today.cost);
    const headlineSub = lead ? `of ${windowName(lead).replace(/^This/, 'this')} used` : u.budget !== undefined ? `spent of ${fmtCost(u.budget)} today` : 'spent today';
    const rows: HTMLElement[] = [];
    if (u.budget !== undefined) {
      const pct = u.budget > 0 ? (u.today.cost / u.budget) * 100 : 0;
      rows.push(
        h(
          'div.a-today__row',
          {},
          h('span.a-today__label', {}, h('span', {}, "Today's budget"), h('b', {}, `${Math.round(pct)}%`)),
          meter(pct, "Today's budget used", pct >= 100 ? 'over' : pct >= 80 ? 'near' : undefined),
        ),
      );
    }
    for (const w of lim.windows.slice(0, 3)) {
      rows.push(
        h(
          'div.a-today__row',
          {},
          h('span.a-today__label', {}, h('span', {}, windowName(w), w.resetsAt ? h('span', {}, ` · starts over ${resetIn(w.resetsAt)}`) : ''), h('b', {}, `${Math.round(w.pct)}%`)),
          meter(w.pct, `${windowName(w)} used`, w.pct >= 90 ? 'over' : w.pct >= 75 ? 'near' : undefined),
        ),
      );
    }
    todayBox.replaceChildren(
      glassCard(
        [
          h(
            'div.a-today',
            {},
            h('div.a-today__top', {}, h('span.a-today__spent.a-num', {}, headline), h('span.a-today__of', {}, headlineSub)),
            rows.length ? h('div.a-today__rows', {}, ...rows) : null,
          ),
        ],
        { glass: false },
      ),
    );
  };

  const render = () => {
    renderHello();
    renderToday();
    if (!teamReady() && !ctx.store.floors.length) return;
    if (teamReady() && doneLoading) {
      doneLoading();
      doneLoading = null;
    }
    const all = everyone();
    summary.textContent = summaryLine(all);

    // ---- Needs you ----
    const needs = all.filter(needsHer).sort(byStatus);
    const multiSpace = new Set(all.map((w) => w.floor)).size > 1;
    const needsSig = needs.map((w) => `${w.id}:${w.status}:${w.acked}:${inboxLine(w)}:${w.waitingSince ?? ''}`).join('|') + `#${multiSpace}`;
    if (needsSig !== lastNeedsSig && (teamReady() || needs.length)) {
      lastNeedsSig = needsSig;
      needsTitle.replaceChildren('Needs you', needs.length ? h('span.a-section-title__count', {}, String(needs.length)) : '');
      if (!needs.length) {
        needsBox.replaceChildren(h('p.a-home__caught-up', {}, h('span.a-home__check', { 'aria-hidden': 'true' }, icon('check', 18)), "You're all caught up."));
      } else {
        const cards = needs.slice(0, MAX_CARDS).map((w, i) =>
          h(
            'a.a-card.a-card--needs.a-inbox-card',
            { href: hrefOf({ view: 'chat', floor: w.floor, worker: w.id }), style: `--i:${i}` },
            avatar(w, 48),
            h('span.a-inbox-card__top', {}, h('span.a-inbox-card__name', {}, w.name), w.waitingSince ? h('span.a-caption.a-inbox-card__time.a-num', {}, timeShort(w.waitingSince)) : null),
            h('span.a-inbox-card__line', {}, h('span.a-sr-only', {}, uiStatus(w) === 'needs' ? 'Needs you: ' : ''), inboxLine(w)),
            multiSpace ? h('span.a-inbox-card__space', {}, w.floorName) : null,
          ),
        );
        const list = h('div.a-home__cards', { class: firstPaint ? 'a-stagger' : '' }, ...cards);
        needsBox.replaceChildren(list);
        if (needs.length > MAX_CARDS) needsBox.append(button({ label: `See all ${needs.length}`, variant: 'ghost', href: '#/chats' }));
      }
    }

    renderNow(all);

    // ---- Your spaces: a bento, the first space large ----
    const spaces = visibleSpaces();
    const cards = spaces.map((f) => {
      const people = all.filter((w) => w.floor === f.id).sort(byStatus);
      const known = people.length > 0 || teamReady();
      const need = known ? people.filter(needsHer).length : f.waiting;
      // Asking her something comes first; something finished for her to look at says so.
      const asking = known ? people.filter((w) => uiStatus(w) === 'needs').length : need;
      const finished = need - asking;
      const working = known ? people.filter((w) => uiStatus(w) === 'working').length : f.busy;
      const status = asking
        ? `${asking} need${asking === 1 ? 's' : ''} you`
        : finished
          ? `${finished} finished for you`
          : working
            ? `${working} working`
            : people.length || f.workers
              ? 'All quiet'
              : 'No one here yet';
      return { f, people, need, working, status };
    });
    const spacesSig = cards.map((c) => `${c.f.id}:${c.f.name}:${c.status}:${c.people.length}:${c.people.slice(0, 6).map((w) => `${w.id}${uiStatus(w)}`).join(',')}`).join('|');
    if (spacesSig !== lastSpacesSig) {
      lastSpacesSig = spacesSig;
      if (!spaces.length) {
        spacesBox.replaceChildren(h('p.a-home__caught-up', {}, ctx.store.floors.length ? 'All your spaces are turned off. Turn them on in Settings.' : 'No spaces yet.'));
      } else {
        // One large card, then pairs; an odd one out at the end spans the row (on a phone).
        const tailWide = cards.length > 1 && (cards.length - 1) % 2 === 1;
        spacesBox.replaceChildren(
          h(
            'div.a-home__grid',
            { class: firstPaint ? 'a-stagger' : '' },
            ...cards.map(({ f, people, need, working, status }, i) => {
              const { title, sub } = splitSpaceName(f.name);
              const hero = i === 0;
              const cls = ['a-card', 'a-space-card', 'a-bento', hero ? 'is-hero' : '', !hero && tailWide && i === cards.length - 1 ? 'is-tail-wide' : '', working ? 'is-live' : '', need ? 'is-needs' : '']
                .filter(Boolean)
                .join(' ');
              return h(
                'a',
                { class: cls, href: hrefOf({ view: 'space', floor: f.id }), style: `--a-space:${spaceColor(f.id)};--i:${i}` },
                // The big card points onward; the small ones show who's there where the arrow would be.
                h(
                  'span.a-bento__head',
                  {},
                  h('span.a-space-card__tile', { 'aria-hidden': 'true' }, spaceEmoji(f)),
                  hero || !people.length ? h('span.a-bento__arrow', { 'aria-hidden': 'true' }, icon('external', 16)) : avatarStack(people, 3),
                ),
                h('span.a-space-card__name', {}, title),
                sub ? h('span.a-space-card__sub', {}, h('span.a-sr-only', {}, ', '), sub) : null,
                h(
                  'span.a-bento__foot',
                  {},
                  h('span.a-space-card__status', { class: need ? 'is-needs' : working ? 'is-working' : '' }, h('span.a-sr-only', {}, ', '), status),
                  hero && people.length ? avatarStack(people, 5) : null,
                ),
              );
            }),
          ),
        );
      }
    }
    if (all.length || teamReady()) firstPaint = false;
  };

  render();
  const offTeam = onTeam(render);
  ctx.on('floors', render);
  ctx.on('workers', render);
  ctx.on('me', render);
  ctx.on('meeting', render);
  ctx.on('usage', render);
  ctx.on('limits', render);
  window.addEventListener(SPACES_EVENT, render);
  // The greeting turns from morning to afternoon without a reload; times stay fresh.
  const tick = setInterval(() => {
    lastNeedsSig = '';
    lastTodaySig = '';
    render();
  }, 60_000);
  return () => {
    offTeam();
    clearInterval(tick);
    window.removeEventListener(SPACES_EVENT, render);
  };
};
