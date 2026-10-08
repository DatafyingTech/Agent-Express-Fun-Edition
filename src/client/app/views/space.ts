// A space (an office floor; DESIGN.md §6.3, REDESIGN.md §2.2). A large editorial title in the space's
// own color with a live line under it ("3 working · 1 needs you"), then a row of glass pills for its
// parts: Team · Meetings · Tasks · Notes · Reports · GitHub (only when the floor is on GitHub). Six
// don't fit a segmented control on a phone, so the row scrolls sideways and sticks under the header,
// with an indicator that slides to the part on screen.
//
// Switching parts changes the route (so the URL, Back and a reload all work) but only the panel under
// the pills changes. This file draws the frame and the Team part; the others are their own views
// (PANELS), each given a context whose subscriptions end when the panel changes. The shell keeps this
// screen mounted while a sheet (Add teammates, Call a meeting, The office) is open over it.

import type { AppContext, Route, View } from '../context';
import type { Topic } from '../../state';
import type { WorkerInfo } from '../../../shared/protocol';
import { TEAM_BY_ID } from '../../../shared/team';
import { CLAUDE_MODEL_LABEL, EFFORT_LABEL } from '../../ui/provider';
import { icon } from '../icons';
import {
  avatar,
  backButton,
  button,
  byStatus,
  confirmDialog,
  doingLine,
  emptyState,
  h,
  hrefOf,
  isResting,
  openMenu,
  plural,
  roleTitle,
  setAvatarStatus,
  spaceColor,
  spaceEmoji,
  spaceName,
  spaceSubtitle,
  statusWords,
  timeShort,
  uiStatus,
  type MenuItem,
} from '../ui';
import { notesView } from './notes';
import { glyph, reportsView, tap } from './reports';
import { meetingsView } from './meetings';
import { tasksView } from './tasks';
import { githubView } from './github';
import { edition } from '../../../shared/edition';

export interface SpaceHandle {
  /** The route moved within this space (another segment). */
  update(route: Route): void;
  cleanup(): void;
}

type Segment = 'team' | 'meetings' | 'tasks' | 'notes' | 'reports' | 'github';
const segOf = (r: Route): Segment => (r.view === 'memory' ? 'notes' : r.view === 'reports' || r.view === 'meetings' || r.view === 'tasks' || r.view === 'github' ? r.view : 'team');
const routeOf = (floor: string, s: Segment): Route => (s === 'notes' ? { view: 'memory', floor } : s === 'team' ? { view: 'space', floor } : { view: s, floor });
/** Each segment's panel but Team, which this file draws itself. */
const PANELS: Record<Exclude<Segment, 'team'>, View> = { notes: notesView, reports: reportsView, meetings: meetingsView, tasks: tasksView, github: githubView };
const LABELS: Record<Segment, string> = { team: 'Team', meetings: 'Meetings', tasks: 'Tasks', notes: 'Notes', reports: 'Reports', github: 'GitHub' };

/** A context for a panel: its subscriptions end when the panel changes. */
function childCtx(ctx: AppContext): { ctx: AppContext; drop: () => void } {
  const subs: (() => void)[] = [];
  return {
    ctx: {
      ...ctx,
      on: (topic: Topic, fn: () => void) => {
        const off = ctx.store.on(topic, fn);
        subs.push(off);
        return off;
      },
    },
    drop: () => subs.splice(0).forEach((off) => off()),
  };
}

const teammates = (ctx: AppContext) => [...ctx.store.workers.values()].filter((w) => w.kind !== 'shell');

/** "Opus", "Sonnet 5 · High" for the tooltip: what a teammate runs on (their own pick, else their role's). */
function modelOf(w: WorkerInfo): { short: string; long: string; key: string } | null {
  if (w.kind === 'shell') return null;
  const member = w.role ? TEAM_BY_ID.get(w.role) : undefined;
  const model = w.model ?? member?.model;
  if (!model) return null;
  const effort = w.effort ?? (w.model ? undefined : member?.effort);
  const label = model in CLAUDE_MODEL_LABEL ? CLAUDE_MODEL_LABEL[model as keyof typeof CLAUDE_MODEL_LABEL] : (model.split('/').pop() ?? model);
  return { short: label.split(' ')[0], long: effort ? `${label} · ${EFFORT_LABEL[effort]} effort` : label, key: model in CLAUDE_MODEL_LABEL ? model : 'other' };
}

// =================================================================================================
// The glass pill row: tabs that scroll sideways, with an indicator that slides to the chosen one.
// =================================================================================================

interface PillTabs {
  el: HTMLElement;
  track: HTMLElement;
  select(value: Segment, smooth?: boolean): void;
  /** A quiet count after a tab's name, and an ember dot when something there needs her. */
  mark(value: Segment, count?: number, needs?: boolean): void;
  /** Re-measure (fonts arrived, the window changed). */
  place(): void;
}

function pillTabs(o: { items: Segment[]; value: Segment; label: string; controls: string; onChange: (v: Segment) => void }): PillTabs {
  const ind = h('span.a-sp-tabs__ind', { 'aria-hidden': 'true' });
  const tabs = o.items.map((v) =>
    h(
      'button.a-sp-tabs__tab',
      { type: 'button', role: 'tab', id: `a-sp-tab-${v}`, 'aria-controls': o.controls, 'data-value': v },
      h('span.a-sp-tabs__label', {}, LABELS[v]),
      h('span.a-sp-tabs__count.a-num', { 'aria-hidden': 'true' }),
    ),
  );
  const track = h('div.a-sp-tabs__track', { role: 'tablist', 'aria-label': o.label }, ind, ...tabs);
  const el = h('nav.a-sp-tabs', { 'aria-label': o.label }, track);
  let cur = Math.max(0, o.items.indexOf(o.value));

  const place = () => {
    const t = tabs[cur];
    if (!t || !t.offsetWidth) return;
    ind.style.width = `${t.offsetWidth}px`;
    ind.style.transform = `translateX(${t.offsetLeft}px)`;
  };
  const reveal = (smooth: boolean) => {
    const t = tabs[cur];
    if (!t || !track.clientWidth) return;
    const left = t.offsetLeft - (track.clientWidth - t.offsetWidth) / 2;
    track.scrollTo({ left: Math.max(0, left), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  };
  const select = (v: Segment, smooth = true) => {
    cur = Math.max(0, o.items.indexOf(v));
    tabs.forEach((t, i) => {
      t.setAttribute('aria-selected', String(i === cur));
      t.tabIndex = i === cur ? 0 : -1;
    });
    place();
    reveal(smooth);
  };
  const choose = (i: number, focus = false) => {
    if (i === cur) return;
    select(o.items[i]);
    if (focus) tabs[i].focus({ preventScroll: true });
    tap();
    o.onChange(o.items[i]);
  };
  tabs.forEach((t, i) => t.addEventListener('click', () => choose(i)));
  track.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = tabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(next, true);
  });
  // Soft fades at whichever edge has more to scroll to.
  const edges = () => {
    const max = track.scrollWidth - track.clientWidth;
    el.classList.toggle('has-left', track.scrollLeft > 2);
    el.classList.toggle('has-right', track.scrollLeft < max - 2);
  };
  track.addEventListener('scroll', edges, { passive: true });
  const ro = new ResizeObserver(() => {
    place();
    edges();
  });
  ro.observe(track);
  select(o.value, false);
  // The first measurement lands without the slide; after that it springs.
  requestAnimationFrame(() => {
    place();
    reveal(false);
    edges();
    requestAnimationFrame(() => el.classList.add('is-ready'));
  });
  void document.fonts?.ready.then(() => {
    place();
    edges();
  });

  return {
    el,
    track,
    select,
    place,
    mark(v, count, needs) {
      const t = tabs[o.items.indexOf(v)];
      if (!t) return;
      const c = t.querySelector<HTMLElement>('.a-sp-tabs__count')!;
      const text = count ? String(count) : '';
      if (c.textContent !== text) {
        c.textContent = text;
        place();
      }
      t.toggleAttribute('data-needs', !!needs);
      t.setAttribute('aria-label', `${LABELS[v]}${count ? `, ${plural(count, 'teammate')}` : ''}${needs ? ', someone needs you' : ''}`);
    },
  };
}

// =================================================================================================
// The screen
// =================================================================================================

type Group = 'needs' | 'working' | 'ready' | 'resting';
const GROUPS: { key: Group; title: string; hint?: string }[] = [
  { key: 'needs', title: 'Needs you' },
  { key: 'working', title: 'Working' },
  { key: 'ready', title: 'Ready' },
  { key: 'resting', title: 'Resting', hint: 'Asleep: nothing runs until you wake them.' },
];
const groupOf = (w: WorkerInfo): Group => {
  const s = uiStatus(w);
  return s === 'needs' || s === 'done' ? 'needs' : s === 'working' ? 'working' : s === 'resting' ? 'resting' : 'ready';
};

export function mountSpace(root: HTMLElement, ctx: AppContext, first: Route): SpaceHandle {
  const floor = (first as { floor: string }).floor;
  const name = spaceName(floor);
  const about = spaceSubtitle(floor);
  let segment = segOf(first);

  // ---- Header: back, small title (after scrolling), more ----------------------------------------
  const moreBtn = h('button.a-icon-btn', { type: 'button', 'aria-label': `${name} options`, 'aria-haspopup': 'menu', title: 'More' }, icon('more', 22));
  const header = h(
    'header.a-header.a-sp-header',
    {},
    h('div.a-header__start', {}, backButton('Home', ctx.go, { view: 'home' })),
    h('div.a-header__title', { 'aria-hidden': 'true' }, name),
    h('div.a-header__end', {}, moreBtn),
  );

  // ---- Title: emoji tile + what it's about, the big name, and a live line -------------------------
  const summary = h('p.a-sp-hero__summary', { 'aria-live': 'polite' });
  const hero = h(
    'section.a-sp-hero',
    { 'aria-labelledby': 'a-sp-title' },
    h('div.a-sp-hero__eyebrow', {}, h('span.a-sp-hero__tile', { 'aria-hidden': 'true' }, spaceEmoji(floor)), about ? h('span.a-sp-hero__about', {}, about) : null),
    h('h1.a-sp-hero__title', { id: 'a-sp-title' }, name),
    summary,
  );

  const panelId = `a-space-panel-${floor}`;
  const segs: Segment[] = ['team', 'meetings', 'tasks', 'notes', 'reports', ...(ctx.store.project?.remote ? (['github'] as const) : [])];
  const tabs = pillTabs({ items: segs, value: segment, label: `${name} sections`, controls: panelId, onChange: (v) => ctx.go(routeOf(floor, v)) });
  const tabsSentinel = h('div.a-sp-tabs-sentinel', { 'aria-hidden': 'true' });

  const panel = h('div.a-sp-panel', { id: panelId, role: 'tabpanel', 'aria-labelledby': `a-sp-tab-${segment}` });
  const page = h('div.a-page.a-sp', {}, hero, tabsSentinel, tabs.el, panel);
  const sentinel = h('div.a-sentinel', { 'aria-hidden': 'true' });
  root.classList.add('a-sp-screen');
  root.style.setProperty('--a-space', spaceColor(floor));
  root.append(header, sentinel, page);

  // The header's small title appears once the big one scrolls away; the pills get their glass (and
  // the header gives up its hairline to them) once they're stuck under it.
  const io = new IntersectionObserver(([e]) => header.classList.toggle('is-scrolled', !e.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
  io.observe(hero.querySelector('h1')!);
  let stuckIo: IntersectionObserver | null = null;
  const watchStuck = () => {
    stuckIo?.disconnect();
    const top = header.getBoundingClientRect().height || 56;
    stuckIo = new IntersectionObserver(([e]) => tabs.el.classList.toggle('is-stuck', !e.isIntersecting && e.boundingClientRect.top < top + 1), { rootMargin: `-${Math.round(top) + 1}px 0px 0px 0px` });
    stuckIo.observe(tabsSentinel);
  };
  requestAnimationFrame(watchStuck);

  // ---- Actions on teammates -----------------------------------------------------------------------
  const wake = (w: WorkerInfo) => {
    ctx.net.send({ t: 'worker.resume', workerId: w.id });
    tap();
    ctx.toast(w.sessionId ? `Waking ${w.name}…` : `Waking ${w.name}. They’ll start fresh.`);
  };

  const sendHome = async (w: WorkerInfo) => {
    const m = ctx.store.meeting.current;
    const inMeeting = !!w.meeting && m?.id === w.meeting && m.status === 'running';
    const body = inMeeting
      ? `${w.name} is in the meeting on “${m!.title}”, which stops without them.`
      : w.worktree
        ? `They leave ${name} and their seat frees up. Their own branch (${w.worktree.branch}) is kept, so nothing is lost.`
        : `They leave ${name} and their seat frees up. You can add them again any time.`;
    const ok = await confirmDialog({ title: `Send ${w.name} home?`, body, action: 'Send home', danger: true });
    if (!ok) return;
    // With its own worktree, keep it: the 3D office's careful default while it checks the branch.
    ctx.net.send(w.worktree && !w.meeting ? { t: 'worker.kill', workerId: w.id, cleanup: 'keep' } : { t: 'worker.kill', workerId: w.id });
    tap();
    ctx.toast(`${w.name} is heading home`);
  };

  /** Long-press (or right-click) on a teammate: everything you can do with them. */
  const actionsFor = (w: WorkerInfo, anchor: HTMLElement) => {
    const items: MenuItem[] = [{ label: `Chat with ${w.name}`, icon: 'chats', onSelect: () => ctx.go({ view: 'chat', floor, worker: w.id }) }];
    if (isResting(w)) items.push({ label: 'Wake', icon: 'wake', onSelect: () => wake(w) });
    items.push({ label: 'Behind the scenes', icon: 'eye', onSelect: () => ctx.go({ view: 'terminal', floor, worker: w.id }) });
    if (w.worktree) items.push({ label: 'Their changes', icon: 'file', onSelect: () => ctx.go({ view: 'changes', floor, worker: w.id }) });
    items.push({ label: 'Send home', icon: 'remove', danger: true, divider: true, onSelect: () => void sendHome(w) });
    openMenu(anchor, items, w.name);
  };

  // ---- The Team panel -----------------------------------------------------------------------------
  const teamBox = h('div.a-sp-team');
  const bar = h('div.a-sp-team__bar');
  const addBtn = button({ label: 'Add teammates', icon: 'add', size: 'sm', href: hrefOf({ view: 'hire', floor }) });
  addBtn.classList.add('a-sp-chip', 'a-sp-chip--accent');
  const wakeAllBtn = button({ label: 'Wake everyone', icon: 'wake', size: 'sm', onClick: () => void wakeAll() });
  wakeAllBtn.classList.add('a-sp-chip');
  bar.append(addBtn, wakeAllBtn);
  const sections = new Map<Group, { el: HTMLElement; list: HTMLElement; count: HTMLElement }>();
  for (const g of GROUPS) {
    const count = h('span.a-sp-group__count.a-num');
    const list = h('div.a-sp-list', { role: 'list', 'aria-labelledby': `a-sp-g-${g.key}` });
    const el = h(
      'section.a-sp-group',
      { 'data-group': g.key },
      h('h2.a-sp-group__head', { id: `a-sp-g-${g.key}` }, h('span.a-sp-group__title', {}, g.title), count),
      g.hint ? h('p.a-sp-group__hint', {}, g.hint) : null,
      list,
    );
    sections.set(g.key, { el, list, count });
  }
  const groupsEl = h('div.a-sp-groups', {}, ...GROUPS.map((g) => sections.get(g.key)!.el));

  const rows = new Map<string, { el: HTMLElement; sig: string }>();

  const buildRow = (w: WorkerInfo): HTMLElement => {
    const s = uiStatus(w);
    const resting = s === 'resting';
    const role = roleTitle(w);
    const model = modelOf(w);
    const doing = resting ? null : doingLine(w);
    const plain = !doing || ['Working on it', 'Resting', 'Ready when you are', 'Getting settled…'].includes(doing) || doing === role;
    const since = (s === 'needs' || s === 'done') && w.waitingSince ? timeShort(w.waitingSince) : null;
    const link = h(
      'a.a-sp-mate__link',
      { href: hrefOf({ view: 'chat', floor, worker: w.id }), 'aria-describedby': `a-sp-m-${w.id}-d` },
      avatar(w, resting ? 40 : 48),
      h(
        'span.a-sp-mate__body',
        {},
        h('span.a-sp-mate__top', {}, h('span.a-sp-mate__name', {}, w.name), model ? h('span.a-sp-model', { 'data-model': model.key, title: model.long }, model.short) : null),
        h(
          'span.a-sp-mate__meta',
          { id: `a-sp-m-${w.id}-d` },
          // The group's heading already says "Ready" or "Resting": the words stay for screen readers.
          h('span.a-sp-mate__state', { 'data-status': s, class: s === 'ready' || s === 'resting' || (s === 'working' && w.status !== 'starting') ? 'a-sr-only' : undefined }, statusWords(w)),
          role ? h('span.a-sp-mate__role', {}, role) : null,
          w.worktree ? h('span.a-sp-mate__branch', { title: `Their own branch: ${w.worktree.branch}` }, glyph('branch', 13)) : null,
        ),
        !plain ? h('span.a-sp-mate__doing', {}, doing) : null,
      ),
      resting ? null : h('span.a-sp-mate__trail', { 'aria-hidden': 'true' }, since ? h('span.a-sp-mate__since.a-num', {}, since) : null, icon('forward', 18)),
    );
    const el = h('div.a-sp-mate', { role: 'listitem', 'data-id': w.id, 'data-status': s }, link);
    if (resting) {
      const b = button({ label: 'Wake', icon: 'wake', size: 'sm', onClick: () => wake(w), attrs: { 'aria-label': `Wake ${w.name}` } });
      b.classList.add('a-sp-mate__wake');
      el.append(b);
    }
    holdToAct(link, () => actionsFor(ctx.store.workers.get(w.id) ?? w, link));
    return el;
  };

  const sigOf = (w: WorkerInfo) => [w.name, w.status, w.acked, doingLine(w), w.role ?? '', w.model ?? '', w.effort ?? '', w.waitingSince ?? 0, !!w.worktree].join('|');

  let firstPaint = true;
  const renderTeam = () => {
    const all = teammates(ctx).sort(byStatus);
    const by = new Map<Group, WorkerInfo[]>(GROUPS.map((g) => [g.key, []]));
    for (const w of all) by.get(groupOf(w))!.push(w);
    const needs = by.get('needs')!.length;
    const working = by.get('working')!.length;
    const resting = by.get('resting')!;

    // The live line under the title, in words (colored dots only repeat them).
    const bits: HTMLElement[] = [];
    const bit = (s: string, text: string) => h('span.a-sp-sum', { 'data-s': s }, h('span.a-sp-sum__dot', { 'aria-hidden': 'true' }), text);
    if (needs) bits.push(bit('needs', `${needs} need${needs === 1 ? 's' : ''} you`));
    if (working) bits.push(bit('working', `${working} working`));
    if (!needs && !working) bits.push(bit('quiet', all.length ? 'All quiet' : 'No one here yet'));
    if (all.length) bits.push(h('span.a-sp-sum.a-sp-sum--total', {}, plural(all.length, 'teammate')));
    summary.replaceChildren(...bits);
    tabs.mark('team', all.length || undefined, needs > 0);

    if (segment !== 'team') return;
    if (!all.length) {
      rows.clear();
      teamBox.replaceChildren(
        emptyState({ emoji: spaceEmoji(floor), title: 'No one’s here yet', text: 'Add a few teammates and they’ll get to work.', action: { label: 'Add teammates', variant: 'primary', icon: 'add', href: hrefOf({ view: 'hire', floor }) } }),
      );
      return;
    }
    if (!teamBox.contains(groupsEl)) teamBox.replaceChildren(bar, groupsEl);
    wakeAllBtn.hidden = resting.length < 2;
    wakeAllBtn.querySelector('.a-btn__label')!.textContent = `Wake all ${resting.length}`;

    const focusedId = (document.activeElement?.closest('.a-sp-mate') as HTMLElement | null)?.dataset.id;
    const seen = new Set<string>();
    for (const g of GROUPS) {
      const sec = sections.get(g.key)!;
      const people = by.get(g.key)!;
      sec.el.hidden = !people.length;
      sec.count.textContent = people.length ? String(people.length) : '';
      const els = people.map((w) => {
        seen.add(w.id);
        const sig = sigOf(w);
        const have = rows.get(w.id);
        if (have && have.sig === sig) return have.el;
        const el = buildRow(w);
        if (have) {
          // Keep the avatar element when the size stays, so its ring can pulse when she's newly needed.
          const oldA = have.el.querySelector<HTMLElement>('.a-avatar');
          const newA = el.querySelector<HTMLElement>('.a-avatar');
          if (oldA && newA && oldA.dataset.size === newA.dataset.size) {
            newA.replaceWith(oldA);
            setAvatarStatus(oldA, uiStatus(w));
            oldA.style.setProperty('--a-who', w.color);
          }
        }
        rows.set(w.id, { el, sig });
        return el;
      });
      const same = els.length === sec.list.children.length && els.every((el, i) => sec.list.children[i] === el);
      if (!same) sec.list.replaceChildren(...els);
    }
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    if (focusedId && !document.activeElement?.closest('.a-sp-mate')) rows.get(focusedId)?.el.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    if (firstPaint) {
      firstPaint = false;
      groupsEl.classList.add('is-entering');
      setTimeout(() => groupsEl.classList.remove('is-entering'), 900);
    }
  };

  const wakeAll = async () => {
    const resting = teammates(ctx).filter(isResting);
    if (!resting.length) return ctx.toast('Everyone’s already awake');
    const n = resting.length;
    const ok = await confirmDialog({
      title: n === 1 ? `Wake ${resting[0].name}?` : `Wake all ${n} teammates?`,
      body: n === 1 ? 'They pick up where they left off.' : `They each pick up where they left off. ${n} awake at once use your plan faster, so wake only who you need if it’s busy.`,
      action: n === 1 ? 'Wake' : `Wake ${n}`,
    });
    if (!ok) return;
    for (const w of resting) ctx.net.send({ t: 'worker.resume', workerId: w.id });
    tap(12);
    ctx.toast(n === 1 ? `Waking ${resting[0].name}…` : `Waking ${n} teammates…`);
  };

  const sendEveryoneHome = async () => {
    const all = teammates(ctx);
    if (!all.length) return;
    const n = all.length;
    const running = ctx.store.meeting.current?.status === 'running' && all.some((w) => w.meeting === ctx.store.meeting.current?.id);
    const branches = all.filter((w) => w.worktree).length;
    const ok = await confirmDialog({
      title: n === 1 ? `Send ${all[0].name} home?` : `Send all ${n} teammates home?`,
      body: [
        `Everyone leaves ${name} and the seats free up.`,
        running ? 'The meeting in progress stops.' : '',
        branches ? `Anyone with their own branch keeps it.` : '',
        'You can add them again any time.',
      ]
        .filter(Boolean)
        .join(' '),
      action: n === 1 ? 'Send home' : `Send ${n} home`,
      danger: true,
    });
    if (!ok) return;
    for (const w of all) ctx.net.send(w.worktree && !w.meeting ? { t: 'worker.kill', workerId: w.id, cleanup: 'keep' } : { t: 'worker.kill', workerId: w.id });
    tap(12);
    ctx.toast(n === 1 ? `${all[0].name} is heading home` : `${n} teammates are heading home`);
  };

  // ---- Panels -----------------------------------------------------------------------------------
  let panelCleanup: (() => void) | null = null;

  const showPanel = (s: Segment, r: Route, animate: boolean) => {
    panelCleanup?.();
    panelCleanup = null;
    segment = s;
    panel.replaceChildren();
    panel.setAttribute('aria-labelledby', `a-sp-tab-${s}`);
    panel.classList.remove('is-fade');
    if (animate) {
      void panel.offsetWidth;
      panel.classList.add('is-fade');
    }
    page.dataset.segment = s;
    if (s === 'team') {
      rows.clear();
      for (const sec of sections.values()) sec.list.replaceChildren();
      firstPaint = true;
      panel.append(teamBox);
      renderTeam();
      return;
    }
    const view: View = PANELS[s as Exclude<Segment, 'team'>];
    const host = h('div.a-space__segment.a-sp-segment');
    panel.append(host);
    const child = childCtx(ctx);
    let done: (() => void) | void;
    try {
      done = view(host, child.ctx, r);
    } catch (err) {
      console.error(err);
      host.replaceChildren(emptyState({ icon: 'warning', title: 'Something went wrong', text: 'Something went wrong on our side. Try again in a moment.' }));
    }
    panelCleanup = () => {
      child.drop();
      try {
        done?.();
      } catch (err) {
        console.error(err);
      }
    };
  };

  /** Keeps the pills in view when switching parts from far down the page (no jump when they're already stuck). */
  const settleScroll = () => {
    const top = header.getBoundingClientRect().height;
    const y = tabsSentinel.getBoundingClientRect().top;
    if (y < top) window.scrollTo({ top: window.scrollY + y - top, behavior: 'auto' });
  };

  // ---- More menu ----------------------------------------------------------------------------------
  moreBtn.addEventListener('click', () => {
    const all = teammates(ctx);
    const resting = all.filter(isResting);
    const items: MenuItem[] = [
      { label: 'The office', icon: 'team', onSelect: () => ctx.go({ view: 'office', floor }) },
      { label: 'Add teammates', icon: 'add', onSelect: () => ctx.go({ view: 'hire', floor }) },
      { label: 'Call a meeting', icon: 'group', onSelect: () => ctx.go({ view: 'meeting', floor }) },
    ];
    if (resting.length) items.push({ label: resting.length === 1 ? `Wake ${resting[0].name}` : `Wake everyone (${resting.length})`, icon: 'wake', divider: true, onSelect: () => void wakeAll() });
    if (all.length) items.push({ label: 'Send everyone home', icon: 'remove', danger: true, divider: !resting.length, onSelect: () => void sendEveryoneHome() });
    if (edition.has3d) items.push({
      label: 'Open in the 3D office',
      icon: 'external',
      divider: true,
      onSelect: () => {
        try {
          localStorage.setItem('agent-office.3d', '1');
          localStorage.setItem('agent-office.floor', floor);
        } catch {
          // storage blocked
        }
        location.href = '/';
      },
    });
    openMenu(moreBtn, items, `${name} options`);
  });

  const offWorkers = ctx.store.on('workers', renderTeam);
  const offFloor = ctx.store.on('floor', renderTeam);
  const offMeeting = ctx.store.on('meeting', renderTeam);
  // "2 min" beside someone waiting keeps counting.
  const clock = setInterval(() => {
    if (segment === 'team') {
      for (const r of rows.values()) r.sig = '';
      renderTeam();
    }
  }, 60_000);
  showPanel(segment, first, false);
  // Arriving on another part: the line under the title still says who's here.
  if (segment !== 'team') renderTeam();

  return {
    update(r: Route) {
      const s = segOf(r);
      tabs.select(s);
      if (s !== segment) {
        showPanel(s, r, true);
        settleScroll();
      }
    },
    cleanup() {
      io.disconnect();
      stuckIo?.disconnect();
      clearInterval(clock);
      offWorkers();
      offFloor();
      offMeeting();
      panelCleanup?.();
    },
  };
}

/**
 * Press and hold (or right-click) for a teammate's actions. A hold that fires swallows the click
 * that follows, so letting go doesn't also open the chat; moving the finger (scrolling) cancels it.
 */
function holdToAct(el: HTMLElement, act: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let x = 0;
  let y = 0;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    el.classList.remove('is-holding');
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'mouse') return;
    fired = false;
    x = e.clientX;
    y = e.clientY;
    el.classList.add('is-holding');
    timer = setTimeout(() => {
      timer = undefined;
      fired = true;
      el.classList.remove('is-holding');
      tap(14);
      act();
    }, 480);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 8) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('click', (e) => {
    if (fired) {
      e.preventDefault();
      fired = false;
    }
  });
  // Android's own long-press also arrives as a contextmenu: whichever comes first acts, once.
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (fired) return;
    const touch = !!timer;
    cancel();
    if (touch) fired = true;
    act();
  });
}

/** The registry's View form of the space screen (the shell uses mountSpace to switch segments in place). */
export const spaceView: View = (root, ctx, route) => {
  const s = mountSpace(root, ctx, route);
  return () => s.cleanup();
};
