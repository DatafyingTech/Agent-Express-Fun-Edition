// Agent Express (/app), the app view: the shell. Signs in (or sends her to the door), opens the office's socket, turns
// the URL hash into a screen, keeps the server's floor in step with the space on screen, and draws
// the frame around it: bottom tabs on a phone, an icon rail on a tablet, a sidebar on a desktop.
//
// ROUTES (the hash is the source of truth, so Back, reload and shared links all work):
//   #/home  #/chats  #/settings
//   #/space/<floor>            Team segment          → views/space.ts
//   #/space/<floor>/notes      Notes segment (memory) → views/space.ts hosts views/notes.ts
//   #/space/<floor>/reports    Reports segment        → views/space.ts hosts views/reports.ts
//   #/space/<floor>/add        Add teammates (sheet)  → space underneath + views/hire.ts in a sheet
//   #/space/<floor>/group      Group chat (sheet)     → space underneath + views/meeting.ts in a sheet
//   #/chat/<floor>/<worker>    A conversation         → views/chat.ts
//
// SHEET ROUTES (hire, meeting): the space screen stays mounted underneath (on whatever segment it was
// on, Team when arriving fresh), and the shell opens a sheet (ui.sheet(), a native <dialog>) and calls
// the view with `root` = the sheet's content root. The view renders header.a-sheet__head (with its
// h2 and a close icon button), div.a-sheet__body and footer.a-sheet__foot into it. To close, the view
// calls ctx.go({ view: 'space', floor }); Esc, a scrim click, a swipe down or leaving the route close
// it too. Closing always runs the view's cleanup.
//
// FLOOR: a route that names a floor first moves this socket to it (floor.go) and waits for the
// floor.enter before mounting the screen, so store.workers is always that space's teammates.

import { Net } from '../net';
import { loadProfile, store, type Profile, type Topic } from '../state';
import { randomLook } from '../../shared/avatar';
import type { AppContext, Route, View } from './context';
import { icon } from './icons';
import { APP_NAME } from '../../shared/edition';
import {
  actionRows,
  actionSheet,
  applyTheme,
  avatar,
  badge,
  byStatus,
  button,
  emptyState,
  firstName,
  h,
  haptic,
  hiddenSpaces,
  hrefOf,
  iconButton,
  needsHer,
  onTeam,
  pillTabs,
  pokeTeam,
  routeToTerminal,
  setInAppSteps,
  setMyName,
  sheet,
  skeleton,
  skeletonRows,
  spaceColor,
  spaceEmoji,
  spaceName,
  SPACES_EVENT,
  splitSpaceName,
  statusWords,
  teamOn,
  toast,
  visibleSpaces,
  type ActionItem,
  type SheetHandle,
} from './ui';
import { homeView } from './views/home';
import { chatsView } from './views/chats';
import { mountSpace, type SpaceHandle } from './views/space';
import { chatView } from './views/chat';
import { hireView } from './views/hire';
import { meetingView } from './views/meeting';
import { settingsView } from './views/settings';
import { terminalView } from './views/terminal';
import { changesView } from './views/changes';
import { officeView } from './views/office';

applyTheme();

// ------------------------------------------------------------------------------------------------
// Signing in and the socket
// ------------------------------------------------------------------------------------------------

const saved = loadProfile();
const profile: Profile = { name: `${saved?.name ?? 'Guest'} 📱`, color: saved?.color ?? '#B4532A', look: saved?.look ?? randomLook() };
store.profile = profile;
const net = new Net(() => profile);

async function signedIn(): Promise<boolean> {
  try {
    const res = await fetch('/api/whoami', { cache: 'no-store' });
    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent('/app' + location.hash);
      return false;
    }
    const { me } = (await res.json()) as { me?: { account?: { name: string } } };
    if (me?.account?.name) {
      setMyName(me.account.name);
      profile.name = `${me.account.name} 📱`;
    }
  } catch {
    // offline: the socket keeps trying and the banner says so
  }
  return true;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

function parse(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  const [head, a, b] = parts;
  if (head === 'chats') return { view: 'chats' };
  if (head === 'settings') return { view: 'settings' };
  if (head === 'space' && a) {
    if (b === 'notes') return { view: 'memory', floor: a };
    if (b === 'reports') return { view: 'reports', floor: a };
    if (b === 'add') return { view: 'hire', floor: a };
    if (b === 'group') return { view: 'meeting', floor: a };
    if (b === 'meetings') return { view: 'meetings', floor: a };
    if (b === 'tasks') return { view: 'tasks', floor: a };
    if (b === 'github') return { view: 'github', floor: a };
    if (b === 'office') return { view: 'office', floor: a };
    return { view: 'space', floor: a };
  }
  if (head === 'chat' && a && b) return { view: 'chat', floor: a, worker: b };
  if (head === 'term' && a && b) return { view: 'terminal', floor: a, worker: b };
  if (head === 'changes' && a && b) return { view: 'changes', floor: a, worker: b };
  return { view: 'home' };
}

const floorOf = (r: Route): string | null => ('floor' in r ? r.floor : null);
const SPACE_FAMILY = new Set<Route['view']>(['space', 'memory', 'reports', 'meetings', 'tasks', 'github', 'hire', 'meeting', 'office']);
const SHEETS = new Set<Route['view']>(['hire', 'meeting', 'office']);
const isSpaceFamily = (r: Route) => SPACE_FAMILY.has(r.view);
const isSheet = (r: Route) => SHEETS.has(r.view);
const screenKey = (r: Route) => (isSpaceFamily(r) ? `space:${floorOf(r)}` : r.view === 'chat' || r.view === 'terminal' || r.view === 'changes' ? `${r.view}:${r.floor}:${r.worker}` : r.view);
const depth = (r: Route) => (r.view === 'terminal' || r.view === 'changes' ? 3 : r.view === 'chat' ? 2 : isSpaceFamily(r) ? 1 : 0);
const tabOf = (r: Route): 'home' | 'chats' | 'settings' => (r.view === 'chats' || r.view === 'chat' || r.view === 'terminal' || r.view === 'changes' ? 'chats' : r.view === 'settings' ? 'settings' : 'home');

/** The history index of each entry we made, so Back knows whether there's an in-app screen behind. */
let baseIndex = typeof history.state?.appNav === 'number' ? (history.state.appNav as number) : 0;
let curIndex = baseIndex;
if (typeof history.state?.appNav !== 'number') history.replaceState({ ...(history.state ?? {}), appNav: curIndex }, '');

let route: Route = parse(location.hash);
let prevRoute: Route | null = null;

function go(r: Route, opts: { replace?: boolean } = {}) {
  // Leaving a sheet for the space it's over: step back instead of stacking another entry.
  if (isSheet(route) && r.view === 'space' && r.floor === floorOf(route) && prevRoute && screenKey(prevRoute) === screenKey(route) && !isSheet(prevRoute) && curIndex > baseIndex) {
    history.back();
    return;
  }
  const href = hrefOf(r);
  if (href === location.hash && !opts.replace) return;
  if (opts.replace) history.replaceState({ appNav: curIndex }, '', href);
  else history.pushState({ appNav: ++curIndex }, '', href);
  onLocation();
}

function onLocation() {
  const st = history.state?.appNav;
  if (typeof st === 'number') curIndex = st;
  else {
    // A plain link (<a href="#/…">) made this entry: number it.
    curIndex++;
    history.replaceState({ ...(history.state ?? {}), appNav: curIndex }, '');
  }
  if (curIndex < baseIndex) baseIndex = curIndex;
  setInAppSteps(curIndex - baseIndex);
  const next = parse(location.hash);
  prevRoute = route;
  route = next;
  render();
}
window.addEventListener('hashchange', onLocation);

// ------------------------------------------------------------------------------------------------
// The frame: nav (rail / sidebar), stage, tab bar
// ------------------------------------------------------------------------------------------------

const shell = document.getElementById('a-shell')!;
const main = document.getElementById('a-main')!;
const bannerSlot = h('div.a-banner-slot', { role: 'status', 'aria-live': 'polite' });
const stage = h('div.a-stage', {}, bannerSlot);
const nav = h('nav.a-nav', { 'aria-label': APP_NAME });
const tabbar = h('nav.a-tabbar', { 'aria-label': APP_NAME });
// The tab bar's sliding pill stays put across redraws so it can glide from tab to tab.
const tabPill = h('span.a-tabbar__pill', { 'aria-hidden': 'true' });
const tabItems = h('div', { style: 'display:contents' });
tabbar.append(tabPill, tabItems);
// Frosted glass under the phone's status bar (viewport-fit=cover), so text never runs under the clock.
const statusbar = h('div.a-statusbar', { 'aria-hidden': 'true' });
main.replaceChildren();
stage.append(main);
shell.replaceChildren(nav, stage, tabbar, statusbar);

// ------------------------------------------------------------------------------------------------
// The aura follows the space on screen: --a-space on <html> (tokens.css derives --a-aura-1 from it,
// and fades between spaces). Home, Chats and Settings fall back to the ember glow.
// ------------------------------------------------------------------------------------------------

function paintAura() {
  const f = floorOf(route);
  const root = document.documentElement;
  if (f && store.floors.some((x) => x.id === f)) root.style.setProperty('--a-space', spaceColor(f));
  else root.style.removeProperty('--a-space');
}

// ------------------------------------------------------------------------------------------------
// Create (the tab bar's ✚): message a teammate, call a meeting, add a teammate, add a task, in the
// space on screen or the last one she was in, with a row of pills to pick another.
// ------------------------------------------------------------------------------------------------

/** The space Create acts on: the one on screen, else the one the socket last went to, else the first. */
function createSpace(): string | null {
  const spaces = visibleSpaces();
  const f = floorOf(route) ?? store.floor;
  if (f && spaces.some((s) => s.id === f)) return f;
  return spaces[0]?.id ?? null;
}

let createOpen: SheetHandle | null = null;

function openCreate(opener?: HTMLElement) {
  if (createOpen) return;
  const spaces = visibleSpaces();
  let floor = createSpace();
  if (!floor || !spaces.length) {
    toast('Turn on a space in Settings first.', 'info');
    return;
  }
  haptic();
  opener?.setAttribute('aria-expanded', 'true');
  const pick = (f: string): ActionItem[] => [
    { label: 'Message a teammate', hint: 'Pick someone and start talking', icon: 'chats', tone: 'accent', onSelect: () => openPickTeammate(f) },
    { label: 'Call a meeting', hint: 'A few teammates, one question', icon: 'group', tone: 'working', href: hrefOf({ view: 'meeting', floor: f }) },
    { label: 'Add a teammate', hint: 'From the roster, a crew, or a helper', icon: 'user-plus', tone: 'done', href: hrefOf({ view: 'hire', floor: f }) },
    { label: 'Add a task', hint: "Queued for whoever's free next", icon: 'task', tone: 'honey', href: hrefOf({ view: 'tasks', floor: f }) },
  ];
  const s = actionSheet({ title: 'Create', actions: pick(floor) });
  createOpen = s;
  s.dialog.addEventListener('close', () => {
    createOpen = null;
    opener?.setAttribute('aria-expanded', 'false');
  });
  // Which space it's for: pills when there's a choice.
  if (spaces.length > 1) {
    const body = s.root.querySelector('.a-sheet__body')!;
    const actions = body.querySelector('.a-actions')!;
    const pills = pillTabs({
      label: 'In which space',
      role: 'radiogroup',
      value: floor,
      items: spaces.map((f) => ({ value: f.id, label: `${spaceEmoji(f)} ${splitSpaceName(f.name).title}` })),
      onChange: (v) => {
        floor = v;
        // Redraw the choices for the new space (their links point into it).
        const fresh = actionRows(pick(v), () => s.close());
        actions.replaceChildren(...fresh);
      },
    });
    body.prepend(h('div.a-create__for', {}, h('span.a-overline', {}, 'In'), pills));
  }
}

/** Step two of "Message a teammate": everyone in that space, whoever needs her first. */
function openPickTeammate(floor: string) {
  const people = teamOn(floor).slice().sort(byStatus);
  const s = sheet({ label: 'Message a teammate' });
  const id = 'a-create-pick-title';
  s.dialog.setAttribute('aria-labelledby', id);
  s.dialog.removeAttribute('aria-label');
  const list = people.length
    ? h(
        'div.a-group',
        { role: 'list' },
        ...people.map((w) =>
          h(
            'div.a-row-wrap',
            { role: 'listitem' },
            h(
              'a.a-row',
              { href: hrefOf({ view: 'chat', floor, worker: w.id }), onclick: () => s.close() },
              h('span.a-row__lead', {}, avatar(w, 40)),
              h('span.a-row__text', {}, h('span.a-row__title', {}, w.name), h('span.a-row__sub', {}, statusWords(w))),
              h('span.a-row__trail', {}, icon('forward', 18)),
            ),
          ),
        ),
      )
    : emptyState({ emoji: spaceEmoji(floor), title: 'No one here yet', text: 'Add a teammate and they can get started.', action: { label: 'Add a teammate', variant: 'primary', href: hrefOf({ view: 'hire', floor }) } });
  s.root.append(
    h('header.a-sheet__head', {}, h('h2.a-sheet__title', { id }, `Message someone in ${spaceName(floor)}`), iconButton('close', 'Close', () => s.close())),
    h('div.a-sheet__body', {}, list),
  );
}

/** Teammates who need her across the visible spaces: the live copy for the space the socket is on. */
function needsCount(): number {
  const hidden = hiddenSpaces();
  let n = 0;
  for (const f of store.floors) {
    if (f.cloning || hidden.has(f.id)) continue;
    if (f.id === store.floor) n += [...store.workers.values()].filter((w) => w.kind !== 'shell' && needsHer(w)).length;
    else n += f.waiting;
  }
  return n;
}

function spaceNeeds(floorId: string): number {
  if (floorId === store.floor) return [...store.workers.values()].filter((w) => w.kind !== 'shell' && needsHer(w)).length;
  return store.floors.find((f) => f.id === floorId)?.waiting ?? 0;
}

/** What the nav last drew: it's redrawn on every teammate update, so only redraw when it changed (keeps keyboard focus put). */
let navSig = '';

function renderNav() {
  const tab = tabOf(route);
  const n = needsCount();
  const onFloor = floorOf(route);
  const cur = (on: boolean) => (on ? 'page' : undefined);
  const sig = JSON.stringify([tab, n, onFloor, route.view, firstName(), visibleSpaces().map((f) => [f.id, f.name, spaceEmoji(f), spaceNeeds(f.id), f.palette])]);
  if (sig === navSig) return;
  navSig = sig;

  const navItem = (href: string, iconName: 'home' | 'chats' | 'settings', label: string, current: boolean, count?: number) =>
    h(
      'a.a-nav__item',
      { href, 'aria-current': cur(current), 'aria-label': count ? `${label}, ${count} need${count === 1 ? 's' : ''} you` : label },
      icon(iconName, 22),
      h('span.a-nav__label', {}, label),
      h('span.a-nav__rail-label', {}, label),
      count ? badge(count) : null,
    );

  const spaces = visibleSpaces();
  const account = firstName();
  const createItem = h(
    'button.a-nav__item.a-nav__create',
    { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Create', onclick: (e: Event) => openCreate(e.currentTarget as HTMLElement) },
    h('span.a-nav__create-disc', { 'aria-hidden': 'true' }, icon('add', 20)),
    h('span.a-nav__label', {}, 'Create'),
    h('span.a-nav__rail-label', {}, 'Create'),
  );
  nav.replaceChildren(
    h('a.a-wordmark', { href: '#/home', 'aria-label': `${APP_NAME}, home` }, APP_NAME, h('span.a-wordmark__dot', { 'aria-hidden': 'true' })),
    createItem,
    navItem('#/home', 'home', 'Home', tab === 'home' && !onFloor),
    navItem('#/chats', 'chats', 'Chats', tab === 'chats', n),
    h('div.a-nav__divider', { 'aria-hidden': 'true' }),
    spaces.length ? h('div.a-overline', { id: 'a-nav-spaces' }, 'Spaces') : '',
    h(
      'div.a-nav__spaces',
      { role: spaces.length ? 'group' : undefined, 'aria-labelledby': spaces.length ? 'a-nav-spaces' : undefined },
      ...spaces.map((f) => {
        const need = spaceNeeds(f.id);
        const here = onFloor === f.id && route.view !== 'chat';
        const { title } = splitSpaceName(f.name);
        return h(
          'a.a-nav__item.a-nav__space',
          { href: `#/space/${encodeURIComponent(f.id)}`, 'aria-current': cur(here), 'aria-label': need ? `${title}, ${need} need${need === 1 ? 's' : ''} you` : title, title: f.name.replace(' · ', ': ') },
          h('span.a-space-tile', { style: `--a-space:${spaceColor(f.id)}`, 'aria-hidden': 'true' }, spaceEmoji(f)),
          h('span.a-nav__label', {}, title),
          need ? badge() : null,
        );
      }),
    ),
    h('div.a-nav__spacer'),
    navItem('#/settings', 'settings', 'Settings', tab === 'settings'),
    account ? h('div.a-nav__account', {}, h('span.a-avatar', { 'data-size': 32, 'aria-hidden': 'true' }, h('span.a-avatar__letter', {}, account.charAt(0))), h('span', {}, account)) : '',
  );

  const tabLink = (href: string, iconName: 'home' | 'chats' | 'settings', label: string, current: boolean, count?: number) =>
    h(
      'a.a-tab',
      { href, 'aria-current': cur(current), 'aria-label': count ? `${label}, ${count} need${count === 1 ? 's' : ''} you` : label },
      h('span.a-tab__icon', {}, icon(iconName, 24), count ? badge(count) : null),
      h('span.a-tab__label', { 'aria-hidden': 'true' }, label),
    );
  const create = h(
    'button.a-tab.a-tab--create',
    { type: 'button', 'aria-label': 'Create', 'aria-haspopup': 'dialog', 'aria-expanded': createOpen ? 'true' : 'false', onclick: (e: Event) => openCreate(e.currentTarget as HTMLElement) },
    h('span.a-tab__disc', { 'aria-hidden': 'true' }, icon('add', 24)),
  );
  tabItems.replaceChildren(
    tabLink('#/home', 'home', 'Home', tab === 'home'),
    tabLink('#/chats', 'chats', 'Chats', tab === 'chats', n),
    create,
    tabLink('#/settings', 'settings', 'Settings', tab === 'settings'),
  );
  // The pill glides under the current tab (slot 0, 1 or 3; 2 is Create).
  tabbar.style.setProperty('--a-tab-i', String(tab === 'home' ? 0 : tab === 'chats' ? 1 : 3));
}

// ------------------------------------------------------------------------------------------------
// Connection banner
// ------------------------------------------------------------------------------------------------

let downSince = 0;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
let longTimer: ReturnType<typeof setTimeout> | undefined;
let everUp = false;

function showBanner(kind: 'reconnecting' | 'stuck' | 'online') {
  const b = h('div.a-banner', { class: kind === 'online' ? 'is-online' : '' });
  if (kind === 'reconnecting') b.append(h('span.a-spinner', { 'aria-hidden': 'true' }), 'Reconnecting…');
  else if (kind === 'stuck') b.append(icon('offline', 16), "Can't connect right now. We'll keep trying.", button({ label: 'Try now', variant: 'ghost', size: 'sm', onClick: () => location.reload() }));
  else b.append(icon('check', 16), 'Back online');
  bannerSlot.replaceChildren(b);
}

net.onStatus((up) => {
  clearTimeout(bannerTimer);
  clearTimeout(longTimer);
  if (up) {
    const wasDown = downSince && bannerSlot.firstChild;
    downSince = 0;
    if (wasDown && everUp) {
      showBanner('online');
      bannerTimer = setTimeout(() => bannerSlot.replaceChildren(), 2000);
    } else bannerSlot.replaceChildren();
    everUp = true;
    return;
  }
  downSince = Date.now();
  bannerTimer = setTimeout(() => showBanner('reconnecting'), everUp ? 600 : 2500);
  longTimer = setTimeout(() => showBanner('stuck'), 15_000);
});
// Before the first connection: say something if it takes a while.
bannerTimer = setTimeout(() => {
  if (!net.up) {
    downSince = Date.now();
    showBanner('reconnecting');
    longTimer = setTimeout(() => !net.up && showBanner('stuck'), 12_000);
  }
}, 2500);

// ------------------------------------------------------------------------------------------------
// Screens
// ------------------------------------------------------------------------------------------------

interface Mounted {
  key: string;
  el: HTMLElement;
  cleanup: () => void;
  space?: SpaceHandle;
  /** Waiting for the socket to reach this floor. */
  pending?: string;
}

interface OpenSheet {
  key: string;
  handle: SheetHandle;
  cleanup: () => void;
  /** Closed by the shell because the route moved on (no navigation needed). */
  byRoute: boolean;
}

let mounted: Mounted | null = null;
let openSheet: OpenSheet | null = null;
let floorAsked: { floor: string; at: number } | null = null;

/** A context for one mounted view: its subscriptions end with it. */
function makeCtx(): { ctx: AppContext; drop: () => void } {
  const subs: (() => void)[] = [];
  const ctx: AppContext = {
    net,
    store,
    floor: () => floorOf(route) ?? store.floor,
    go: (r) => go(r),
    toast: (text, level) => toast(text, level),
    on: (topic: Topic, fn: () => void) => {
      const off = store.on(topic, fn);
      subs.push(off);
      return off;
    },
  };
  return { ctx, drop: () => subs.splice(0).forEach((off) => off()) };
}

function runView(view: View, root: HTMLElement, r: Route): () => void {
  const { ctx, drop } = makeCtx();
  let cleanup: (() => void) | void;
  try {
    cleanup = view(root, ctx, r);
  } catch (err) {
    console.error(err);
    root.replaceChildren(emptyState({ icon: 'warning', title: 'Something went wrong', text: 'Something went wrong on our side. Try again in a moment.', action: { label: 'Try again', onClick: () => location.reload() } }));
  }
  return () => {
    drop();
    try {
      cleanup?.();
    } catch (err) {
      console.error(err);
    }
  };
}

function teardown() {
  if (!mounted) return;
  mounted.cleanup();
  mounted.el.remove();
  mounted = null;
}

/** Which way a screen change moves: deeper pushes in, shallower pops back, the same depth (tabs) fades. */
function navDirection(r: Route, from: Route): 'push' | 'pop' | 'fade' {
  const a = depth(r);
  const b = depth(from);
  return a > b ? 'push' : a < b ? 'pop' : 'fade';
}

/** A new screen element. `animate` adds the CSS entrance, for browsers without View Transitions. */
function newScreen(r: Route, from: Route | null, animate = true): HTMLElement {
  const el = h('div.a-screen');
  if (from && animate) el.classList.add(`is-${navDirection(r, from)}`);
  return el;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
/** A View Transition is running: the screen it swaps in has no CSS entrance of its own. */
let inTransition = false;

/** A floor-bound screen while the socket rides to its floor. */
function pendingScreen(r: Route): HTMLElement {
  const el = h('div.a-page', { 'aria-busy': 'true' });
  if (r.view === 'chat') {
    el.append(skeleton('line', { width: '40%' }), skeleton('block', { height: 72, width: '70%' }), skeleton('block', { height: 48, width: '50%' }));
  } else {
    el.append(h('div', {}, skeleton('line', { width: '45%' }), skeleton('line', { width: '30%' })), skeleton('block', { height: 44 }), skeletonRows(3));
  }
  return el;
}

function missingSpace(): HTMLElement {
  return h(
    'div.a-page.a-page--read.a-page--top',
    {},
    emptyState({ emoji: '🏡', title: "This space isn't here", text: 'It may have been closed, or turned off on this device.', action: { label: 'Go home', variant: 'primary', href: '#/home' } }),
  );
}

function ensureFloor(floor: string): 'ready' | 'waiting' | 'missing' {
  if (store.floor === floor && store.floors.length) return 'ready';
  if (!store.floors.length) return 'waiting'; // not connected yet
  if (!store.floors.some((f) => f.id === floor && !f.cloning)) return 'missing';
  if (!floorAsked || floorAsked.floor !== floor || Date.now() - floorAsked.at > 4000) {
    floorAsked = { floor, at: Date.now() };
    net.send({ t: 'floor.go', floor });
  }
  return 'waiting';
}

function render() {
  const r = route;
  const from = prevRoute;
  document.body.classList.toggle('is-chat', r.view === 'chat');
  document.body.classList.toggle('has-composer', r.view === 'chat');
  // Full-screen places where the composer or key bar owns the bottom edge: no floating tab bar.
  document.body.classList.toggle('is-immersive', r.view === 'chat' || r.view === 'terminal' || r.view === 'changes');
  if (r.view !== 'chat') document.title = APP_NAME;
  renderNav();
  paintAura();

  // The sheet goes when the route leaves it.
  if (openSheet && (!isSheet(r) || openSheet.key !== `${r.view}:${floorOf(r)}`)) {
    const s = openSheet;
    openSheet = null;
    s.byRoute = true;
    s.cleanup();
    s.handle.close();
  }

  // A different screen: let the browser morph from the old to the new (View Transitions) where it can;
  // the swap itself is the same either way. A pending space finishing its ride keeps its key: no motion.
  const key = screenKey(r);
  const vt = (document as ViewTransitionDoc).startViewTransition;
  if (from && mounted && mounted.key !== key && vt && !reducedMotion() && document.visibilityState === 'visible') {
    const html = document.documentElement;
    html.dataset.nav = navDirection(r, from);
    inTransition = true;
    const t = vt.call(document, () => renderScreen());
    void t.finished.finally(() => {
      inTransition = false;
      delete html.dataset.nav;
    });
    return;
  }
  renderScreen();
}

/** Mounts the screen for the current route (or updates the one that's up). Reads the route afresh. */
function renderScreen() {
  const r = route;
  const from = prevRoute;
  const key = screenKey(r);
  const floor = floorOf(r);
  if (floor) {
    const state = ensureFloor(floor);
    if (state !== 'ready') {
      if (mounted?.key === key && mounted.pending === (state === 'missing' ? 'missing' : floor)) return;
      const sameKey = mounted?.key === key;
      teardown();
      const el = newScreen(r, from, !inTransition && !sameKey);
      el.append(state === 'missing' ? missingSpace() : pendingScreen(r));
      main.append(el);
      mounted = { key, el, cleanup: () => {}, pending: state === 'missing' ? 'missing' : floor };
      return;
    }
  }

  if (mounted && mounted.key === key && !mounted.pending) {
    // Same screen: a space switching segments, or a sheet opening over it.
    if (mounted.space && !isSheet(r)) mounted.space.update(r);
  } else {
    // A space that was waiting for its floor keeps the entrance it already made.
    const wasPending = mounted?.key === key && !!mounted.pending;
    teardown();
    const el = newScreen(r, from, !inTransition && !wasPending);
    main.append(el);
    if (isSpaceFamily(r)) {
      const { ctx, drop } = makeCtx();
      const base: Route = isSheet(r) ? { view: 'space', floor: floor! } : r;
      const space = mountSpace(el, ctx, base);
      mounted = {
        key,
        el,
        space,
        cleanup: () => {
          drop();
          space.cleanup();
        },
      };
    } else {
      const view: View = r.view === 'home' ? homeView : r.view === 'chats' ? chatsView : r.view === 'settings' ? settingsView : r.view === 'terminal' ? terminalView : r.view === 'changes' ? changesView : chatView;
      mounted = { key, el, cleanup: runView(view, el, r) };
    }
    // Focus the new screen for screen readers, without scrolling; keep the page at the top.
    if (from && !(isSheet(r) || (from && isSheet(from)))) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  }

  if (isSheet(r) && !openSheet) openRouteSheet(r);
}

function openRouteSheet(r: Route) {
  const floor = floorOf(r)!;
  const view: View = r.view === 'hire' ? hireView : r.view === 'office' ? officeView : meetingView;
  const entry: OpenSheet = { key: `${r.view}:${floor}`, byRoute: false, cleanup: () => {}, handle: null as unknown as SheetHandle };
  entry.handle = sheet({
    label: r.view === 'hire' ? 'Add teammates' : r.view === 'office' ? 'The office' : 'Call a meeting',
    className: `a-sheet--${r.view}`,
    onClose: () => {
      if (openSheet === entry) {
        openSheet = null;
        entry.cleanup();
      }
      // Dismissed by her (Esc, scrim, swipe, close button): back to the space.
      if (!entry.byRoute && isSheet(route) && floorOf(route) === floor) go({ view: 'space', floor });
    },
  });
  openSheet = entry;
  entry.cleanup = runView(view, entry.handle.root, r);
  const title = entry.handle.root.querySelector('h2');
  if (title) {
    if (!title.id) title.id = `a-route-sheet-${r.view}`;
    entry.handle.dialog.setAttribute('aria-labelledby', title.id);
    entry.handle.dialog.removeAttribute('aria-label');
  }
}

// ------------------------------------------------------------------------------------------------
// Socket messages
// ------------------------------------------------------------------------------------------------

net.onMessage((msg) => {
  store.apply(msg);
  routeToTerminal(msg);
  switch (msg.t) {
    case 'welcome':
    case 'floor.enter':
      pokeTeam();
      // The floor a screen was waiting for has arrived (or the first welcome came in).
      if (mounted?.pending || floorOf(route)) render();
      else renderNav();
      break;
    case 'floors':
      renderNav();
      if (mounted?.pending) render();
      pokeTeam();
      break;
    case 'worker.update':
    case 'worker.remove':
      renderNav();
      pokeTeam();
      break;
    case 'toast':
      // The office's own messages use its words; only say that something went wrong.
      if (msg.level === 'error') toast('Something went wrong on our side. Try again in a moment.', 'error');
      break;
  }
});

window.addEventListener(SPACES_EVENT, () => renderNav());
window.addEventListener('storage', (e) => {
  if (e.key === 'hearth.hiddenSpaces') renderNav();
  if (e.key === 'hearth.theme') applyTheme();
});
store.on('floors', () => renderNav());

// A space that never arrives (the elevator broke down): offer a way out rather than skeletons forever.
setInterval(() => {
  if (!mounted?.pending || mounted.pending === 'missing' || !net.up) return;
  if (floorAsked && Date.now() - floorAsked.at > 10_000) {
    mounted.el.replaceChildren(
      h(
        'div.a-page.a-page--read.a-page--top',
        {},
        emptyState({ icon: 'offline', title: "Couldn't open this space", text: 'Something went wrong on our side. Try again in a moment.', action: { label: 'Try again', variant: 'primary', onClick: () => location.reload() } }),
      ),
    );
    mounted.pending = 'missing';
  }
}, 2000);

// ------------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------------

// Arrive on the route's floor straight away (the socket's first welcome enters it).
{
  const f = floorOf(route);
  if (f) {
    try {
      localStorage.setItem('agent-office.floor', f);
    } catch {
      // storage blocked
    }
  }
}
if (!location.hash) history.replaceState({ appNav: curIndex }, '', '#/home');
render();
void signedIn().then((ok) => {
  if (!ok) return;
  renderNav();
  net.connect();
  // The team list names each space's emoji (by who works there) and keeps the counts fresh.
  onTeam(() => renderNav());
});
