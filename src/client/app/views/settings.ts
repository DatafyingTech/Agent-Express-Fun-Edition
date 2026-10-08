// Settings (route `settings`): the office's control centre, the way iOS Settings reads. A root list
// (you, today's usage, then the office's own settings) and pages pushed over it for each part:
//
//   #/settings                 the list
//   #/settings/you             name, color, light / dark / auto (with previews of each), sign out
//   #/settings/usage           today's spend and tokens, the Claude plan's limits, the machine, the
//                              most teammates at once (machine.limit) and the task list's (queue.limit)
//   #/settings/people          accounts and invite links, the shared password, GitHub-key access
//   #/settings/notifications   the Slack / Discord webhook, and a test message
//   #/settings/spaces          which spaces show on this device, add one from GitHub, the projects folder
//   #/settings/updates         what's running, what's new, update now
//   #/settings/about           the version, the 3D office, the address to use from a phone
//
// The shell routes every #/settings… hash here (main.ts only looks at the first part), so the pages
// are plain hash changes: Back, a reload and a shared link all land on the same page. On a wide
// screen the list stays on the left and the page opens beside it, like Settings on an iPad.
//
// Whatever only an admin may do (the server refuses it otherwise) isn't shown to anyone else, the
// same parts the 3D office hides (see ui/settings.ts, ui/accounts.ts).

import type { AppContext, View } from '../context';
import type { Net } from '../../net';
import type { Topic } from '../../state';
import { AVATAR_COLORS, saveProfile } from '../../state';
import { shareOrigin } from '../../share';
import { icon, type IconName } from '../icons';
import { SEATS } from '../../../shared/layout';
import { MAX_FLOORS, normalizeRepo, sameRepo } from '../../../shared/floors';
import { isAsleep } from '../../../shared/status';
import { fmtCost, fmtTokens, tokensOf, type AccountInfo, type AccountInvite, type AccountRole, type PlanWindow, type RepoChoice, type ServerMsg, type TeamState, type WebhookKind } from '../../../shared/protocol';
import {
  applyTheme,
  backButton,
  button,
  confirmDialog,
  firstName,
  goBack,
  h,
  hiddenSpaces,
  iconButton,
  openMenu,
  plural,
  segmented,
  setBusy,
  setHiddenSpaces,
  sheet,
  spaceColor,
  spaceEmoji,
  spaceName,
  SPACES_EVENT,
  splitSpaceName,
  themePref,
  timeAgo,
  toast,
  type ThemePref,
} from '../ui';
import { APP_NAME, commandLine, edition } from '../../../shared/edition';

// =================================================================================================
// Glyphs this screen needs beyond icons.ts (Lucide geometry, same 24 grid and 1.75 stroke).
// =================================================================================================

const GLYPHS = {
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  share: '<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  update: '<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="m8 12 4 4 4-4"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  invite: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  test: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  tasks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
} as const;

type GlyphName = keyof typeof GLYPHS;
const SVG_NS = 'http://www.w3.org/2000/svg';

function glyph(name: GlyphName | IconName, size = 18): SVGElement {
  if (!(name in GLYPHS)) return icon(name as IconName, size);
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `a-icon a-set-glyph--${name}` })) svg.setAttribute(k, String(v));
  svg.innerHTML = GLYPHS[name as GlyphName];
  return svg;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// =================================================================================================
// Server replies that aren't store topics (invite made, floor added…). Net has no way to stop
// listening, so one listener per socket hands them to whichever page is open.
// =================================================================================================

const replyListeners = new Set<(msg: ServerMsg) => void>();
const hookedNets = new WeakSet<Net>();

function hookReplies(net: Net) {
  if (hookedNets.has(net)) return;
  hookedNets.add(net);
  net.onMessage((msg) => {
    if (msg.t === 'accounts.invited' || msg.t === 'team.invited' || msg.t === 'floor.added') for (const fn of replyListeners) fn(msg);
  });
}

// =================================================================================================
// Small helpers
// =================================================================================================

type Page = '' | 'you' | 'usage' | 'people' | 'notifications' | 'spaces' | 'updates' | 'about';
const PAGES: Page[] = ['you', 'usage', 'people', 'notifications', 'spaces', 'updates', 'about'];
const ADMIN_PAGES = new Set<Page>(['people']);

const pageOfHash = (): Page => {
  const m = /^#\/settings\/([a-z]+)/.exec(location.hash);
  return m && (PAGES as string[]).includes(m[1]) ? (m[1] as Page) : '';
};
const hrefPage = (p: Page) => (p ? `#/settings/${p}` : '#/settings');

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function buzz() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // no haptics here
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not a secure context (plain http over Tailscale): a hidden textarea still works.
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

async function copyWithToast(text: string, what = 'Copied') {
  if (await copyText(text)) {
    buzz();
    toast(what);
  } else toast("Couldn't copy that. Press and hold to copy it instead.", 'warn');
}

async function shareOrCopy(url: string, title: string) {
  const nav = navigator as Navigator & { share?: (d: { url: string; title: string }) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ url, title });
      return;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
    }
  }
  await copyWithToast(url, 'Link copied');
}

/** "in 12 min", "in 2 h 5 min", or "Tue 5:00 AM" once it's more than a day out. */
function startsOver(at: number): string {
  const mins = Math.ceil((at - Date.now()) / 60_000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const levelOf = (pct: number) => (pct >= 90 ? 'over' : pct >= 75 ? 'near' : '');

const WEBHOOK_NAME: Record<WebhookKind, string> = { slack: 'Slack', discord: 'Discord', other: 'your webhook' };

const THEMES: { id: ThemePref; label: string; note: string }[] = [
  { id: 'auto', label: 'Auto', note: 'Day & night' },
  { id: 'light', label: 'Light', note: 'Porcelain' },
  { id: 'dark', label: 'Dark', note: 'Obsidian' },
];
const themeLabel = (p: ThemePref) => THEMES.find((t) => t.id === p)!.label;

async function signOut() {
  try {
    await fetch('/api/logout', { method: 'POST', cache: 'no-store' });
  } catch {
    // offline: the login page still clears the way
  }
  location.href = '/login?next=' + encodeURIComponent('/app');
}

// =================================================================================================
// Building blocks: tinted icon tiles, rows, grouped sections
// =================================================================================================

type Tint = 'ember' | 'aqua' | 'sage' | 'honey' | 'rose' | 'graphite' | 'stone' | 'space';

function tile(name: GlyphName | IconName, tint: Tint, style?: string): HTMLElement {
  return h('span.a-set-tile', { 'data-tint': tint, 'aria-hidden': 'true', style }, glyph(name, 18));
}

interface RowOpts {
  lead?: Node | null;
  title: string | Node;
  sub?: string | Node | null;
  value?: string | Node | null;
  trail?: Node | null;
  href?: string;
  onClick?: (e: MouseEvent) => void;
  chevron?: boolean;
  tone?: 'danger' | 'accent';
  center?: boolean;
  /** A <label> for a switch inside it. */
  labelFor?: string;
  cls?: string;
  attrs?: Record<string, string | undefined>;
}

function row(o: RowOpts): HTMLElement {
  const kids = [
    o.lead ? h('span.a-set-row__lead', {}, o.lead) : null,
    h('span.a-set-row__text', {}, h('span.a-set-row__title', {}, o.title), o.sub ? h('span.a-set-row__sub', {}, o.sub) : null),
    o.value !== undefined && o.value !== null ? h('span.a-set-row__value', {}, o.value) : null,
    o.trail ? h('span.a-set-row__trail', {}, o.trail) : null,
    o.chevron ?? !!o.href ? h('span.a-set-row__chev', { 'aria-hidden': 'true' }, icon('forward', 18)) : null,
  ];
  const cls = [o.cls, o.tone ? `is-${o.tone}` : '', o.center ? 'is-center' : '', o.lead ? 'has-lead' : ''].filter(Boolean).join(' ');
  const el = o.href
    ? h('a.a-set-row', { href: o.href, class: cls }, ...kids)
    : o.labelFor
      ? h('label.a-set-row', { for: o.labelFor, class: cls }, ...kids)
      : o.onClick
        ? h('button.a-set-row', { type: 'button', class: cls }, ...kids)
        : h('div.a-set-row', { class: cls }, ...kids);
  if (o.onClick) el.addEventListener('click', (e) => o.onClick!(e as MouseEvent));
  for (const [k, v] of Object.entries(o.attrs ?? {})) if (v !== undefined) el.setAttribute(k, v);
  return el;
}

function section(label: string | null, body: (Node | null)[], foot?: string | Node | null, id?: string): HTMLElement {
  const labelId = label ? `a-set-l-${Math.random().toString(36).slice(2, 8)}` : undefined;
  return h(
    'section.a-set-section',
    { id, 'aria-labelledby': labelId },
    label ? h('h2.a-set-label', { id: labelId }, label) : null,
    h('div.a-set-group', {}, ...body.filter((n): n is Node => !!n)),
    foot ? h('p.a-set-foot', {}, foot) : null,
  );
}

/** Your initial in your color, with a soft halo. */
function meAvatar(size: number): HTMLElement {
  const letter = (firstName() || 'You').charAt(0).toUpperCase();
  return h('span.a-set-avatar', { 'aria-hidden': 'true', style: `--a-who:${safeColor(storeColor())};--sz:${size}px` }, letter);
}

let currentStore: AppContext['store'] | null = null;
const storeColor = () => currentStore?.profile.color ?? AVATAR_COLORS[0];
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : AVATAR_COLORS[0]);

// ---- Rings: the plan's windows as concentric rings, like Activity -------------------------------

const RING_TINTS = ['ember', 'aqua', 'sage'] as const;

interface Rings {
  el: HTMLElement;
  update(windows: PlanWindow[]): void;
}

function rings(size: number, stroke: number, center?: Node): Rings {
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'a-set-rings__svg', 'aria-hidden': 'true' });
  const el = h('div.a-set-rings', { style: `--sz:${size}px` }, svg, center ? h('div.a-set-rings__center', {}, center) : null);
  let drawn: SVGElement[] = [];
  let count = -1;
  const build = (n: number) => {
    svg.replaceChildren();
    drawn = [];
    const gap = Math.max(2, Math.round(stroke * 0.28));
    for (let i = 0; i < Math.max(1, n); i++) {
      const r = size / 2 - stroke / 2 - i * (stroke + gap);
      if (r <= stroke) break;
      const c = 2 * Math.PI * r;
      const g = svgEl('g', { class: `a-set-ring`, 'data-tint': RING_TINTS[i % 3] });
      g.append(
        svgEl('circle', { class: 'a-set-ring__track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none' }),
        svgEl('circle', { class: 'a-set-ring__fill', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none', 'stroke-linecap': 'round', 'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': c.toFixed(2), transform: `rotate(-90 ${size / 2} ${size / 2})` }),
      );
      svg.append(g);
      drawn.push(g);
    }
    count = n;
  };
  const update = (windows: PlanWindow[]) => {
    const list = windows.slice(0, 3);
    if (list.length !== count) build(list.length);
    const paint = () =>
      drawn.forEach((g, i) => {
        const fill = g.querySelector('.a-set-ring__fill') as SVGCircleElement;
        const c = Number(fill.getAttribute('stroke-dasharray'));
        const pct = Math.max(0, Math.min(100, list[i]?.pct ?? 0));
        // A sliver shows even at 0 %, so the ring reads as a gauge rather than an empty track.
        fill.setAttribute('stroke-dashoffset', String(c * (1 - Math.max(pct, list[i] ? 1.5 : 0) / 100)));
        g.setAttribute('data-level', levelOf(pct));
      });
    // First paint from empty, so the rings draw themselves in.
    if (reduceMotion()) paint();
    else requestAnimationFrame(() => requestAnimationFrame(paint));
  };
  return { el, update };
}

// ---- Meters, pips, a sparkline ------------------------------------------------------------------

function meter(pct: number, tint: Tint = 'aqua', label?: string): HTMLElement {
  const p = Math.max(0, Math.min(100, pct));
  return h(
    'div.a-set-meter',
    { 'data-tint': tint, 'data-level': levelOf(p), role: 'progressbar', 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label },
    h('span.a-set-meter__fill', { style: `width:${p}%` }),
  );
}

/** Seats as little bars: `on` of `total` lit, at most 24 drawn. */
function pips(total: number, on: number, tint: Tint = 'sage'): HTMLElement {
  const n = Math.max(0, Math.min(24, total));
  return h('span.a-set-pips', { 'data-tint': tint, 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => h('span.a-set-pip', { class: i < on ? 'is-on' : '' })));
}

function sparkline(values: number[], w = 120, hgt = 32): SVGElement {
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: 'a-set-spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  if (values.length < 2) return svg;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, hgt - 2 - (Math.max(0, Math.min(100, v)) / 100) * (hgt - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d: `${line} L${w} ${hgt} L0 ${hgt} Z`, class: 'a-set-spark__area' }), svgEl('path', { d: line, class: 'a-set-spark__line', fill: 'none' }));
  return svg;
}

// ---- A stepper that says what it'll do, and sends once she stops tapping -------------------------

interface Stepper {
  el: HTMLElement;
  sync(): void;
}

function stepper(o: { label: string; min: number; max: number; get(): number; send(n: number): void; format?(n: number): string; disabled?: boolean }): Stepper {
  let v = o.get();
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = h('output.a-set-stepper__value', { 'aria-live': 'polite' });
  const minus = h('button.a-set-stepper__btn', { type: 'button', 'aria-label': `Fewer: ${o.label}` }, icon('minus', 18)) as HTMLButtonElement;
  const plus = h('button.a-set-stepper__btn', { type: 'button', 'aria-label': `More: ${o.label}` }, icon('add', 18)) as HTMLButtonElement;
  const el = h('div.a-set-stepper', { role: 'group', 'aria-label': o.label }, minus, out, plus);
  const paint = () => {
    out.textContent = o.format ? o.format(v) : String(v);
    minus.disabled = !!o.disabled || v <= o.min;
    plus.disabled = !!o.disabled || v >= o.max;
    el.classList.toggle('is-pending', pending);
  };
  const bump = (d: number) => {
    const next = Math.max(o.min, Math.min(o.max, v + d));
    if (next === v) return;
    v = next;
    pending = true;
    buzz();
    paint();
    clearTimeout(timer);
    // One message for a run of taps, not one per tap.
    timer = setTimeout(() => {
      pending = false;
      o.send(v);
      paint();
    }, 650);
  };
  minus.addEventListener('click', () => bump(-1));
  plus.addEventListener('click', () => bump(1));
  paint();
  return {
    el,
    sync: () => {
      if (pending) return;
      v = o.get();
      paint();
    },
  };
}

// ---- Theme previews, painted with each theme's own tokens ----------------------------------------

const PREVIEW_KEYS = ['bg', 'surface', 'ink', 'ink-3', 'line', 'accent', 'clay', 'aura-1', 'aura-2', 'lake', 'moss', 'glass'];

/**
 * Reads the light and dark values of a few tokens straight out of tokens.css, so a preview of the
 * theme you're not in shows its real colors (they only exist on :root under the other data-theme).
 */
function themeTokens(): { light: Record<string, string>; dark: Record<string, string> } | null {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) {
        const parts = r.selectorText.split(',').map((s) => s.trim());
        const into = parts.includes(':root[data-theme="dark"]') ? dark : parts.some((p) => p === ':root' || p === ':root[data-theme="light"]') ? light : null;
        if (!into) continue;
        for (let i = 0; i < r.style.length; i++) {
          const k = r.style[i];
          if (k.startsWith('--a-')) into[k] = r.style.getPropertyValue(k).trim();
        }
      } else if (r instanceof CSSMediaRule) {
        if (/contrast|motion|width|dark|light/.test(r.conditionText)) continue;
        walk(r.cssRules);
      } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // a cross-origin sheet (the fonts)
    }
  }
  if (!light['--a-bg'] || !dark['--a-bg']) return null;
  return { light, dark: { ...light, ...dark } };
}

function resolveVar(map: Record<string, string>, v: string, depth = 0): string {
  return v.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^()]*))?\)/gi, (_, name: string, fb?: string) => (depth > 6 ? fb ?? '' : map[name] !== undefined ? resolveVar(map, map[name], depth + 1) : fb ?? ''));
}

function previewStyle(map: Record<string, string> | undefined): string {
  if (!map) return '';
  return PREVIEW_KEYS.map((k) => (map[`--a-${k}`] ? `--p-${k}:${resolveVar(map, map[`--a-${k}`])}` : '')).filter(Boolean).join(';');
}

function miniScreen(style: string, cls = ''): HTMLElement {
  return h(
    'span.a-set-mini',
    { class: cls, style },
    h('span.a-set-mini__aura'),
    h('span.a-set-mini__title'),
    h('span.a-set-mini__card', {}, h('span.a-set-mini__dot'), h('span.a-set-mini__line')),
    h('span.a-set-mini__card', {}, h('span.a-set-mini__dot.is-2'), h('span.a-set-mini__line.is-short')),
    h('span.a-set-mini__pill'),
    h('span.a-set-mini__tabbar'),
  );
}

// =================================================================================================
// The view
// =================================================================================================

interface PageEnv {
  ctx: AppContext;
  on(topic: Topic, fn: () => void): void;
  reply(fn: (msg: ServerMsg) => void): void;
  every(ms: number, fn: () => void): void;
  cleanup(fn: () => void): void;
  /** Leave this page (Back on a phone, the list's first page on a wide screen). */
  back(): void;
}

type PageFn = (env: PageEnv) => HTMLElement;

export const settingsView: View = (root, ctx) => {
  hookReplies(ctx.net);
  currentStore = ctx.store;
  const store = ctx.store;
  const wideMq = matchMedia('(min-width: 1024px)');
  const isAdmin = () => store.me.admin;

  // Fresh numbers for the list: the accounts (for the people count) and what version is running.
  if (isAdmin()) ctx.net.send({ t: 'accounts.get' });
  if (store.invites) ctx.net.send({ t: 'team.get' });

  const rootPane = h('div.a-set__root');
  const detail = h('div.a-set__detail');
  const wrap = h('div.a-set', {}, rootPane, detail);
  root.replaceChildren(wrap);

  // ---- The list ---------------------------------------------------------------------------------
  const list = buildRoot(ctx);
  rootPane.append(list.el);
  const paintRoot = () => list.paint();
  for (const t of ['me', 'usage', 'limits', 'notify', 'upgrade', 'accounts', 'floors', 'team', 'peers'] as Topic[]) ctx.on(t, paintRoot);
  const onSpaces = () => paintRoot();
  window.addEventListener(SPACES_EVENT, onSpaces);

  // ---- The page over it -------------------------------------------------------------------------
  let shown: Page | null = null;
  let pageCleanup: () => void = () => {};
  let rootScroll = 0;

  const open = (animate: boolean) => {
    let p = pageOfHash();
    if (p && ADMIN_PAGES.has(p) && !isAdmin()) {
      // Not hers to see (a shared link, or her role just changed): the list, and the address says so.
      p = '';
      history.replaceState(history.state, '', hrefPage(''));
    }
    // Wide: the list is always there, so a page is always open beside it.
    const target: Page = p || (wideMq.matches ? 'you' : '');
    wrap.dataset.page = p;
    list.setCurrent(target);
    if (target === shown) return;
    const was = shown;
    shown = target;
    pageCleanup();
    pageCleanup = () => {};
    if (!p && !wideMq.matches) {
      detail.replaceChildren();
      // Back on the list: where she was on it.
      if (was) requestAnimationFrame(() => window.scrollTo(0, rootScroll));
      if (animate && was && !reduceMotion()) {
        rootPane.classList.remove('is-back');
        void rootPane.offsetWidth;
        rootPane.classList.add('is-back');
      }
      return;
    }
    if (!was && !wideMq.matches) rootScroll = window.scrollY;
    const offs: (() => void)[] = [];
    const env: PageEnv = {
      ctx,
      on: (topic, fn) => offs.push(store.on(topic, fn)),
      reply: (fn) => {
        replyListeners.add(fn);
        offs.push(() => replyListeners.delete(fn));
      },
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        offs.push(() => clearInterval(t));
      },
      cleanup: (fn) => offs.push(fn),
      back: () => goBack(ctx.go, { view: 'settings' }),
    };
    const build = PAGE_BUILDERS[target as Exclude<Page, ''>];
    let el: HTMLElement;
    try {
      el = build(env);
    } catch (err) {
      console.error(err);
      el = pageFrame(env, 'Settings', null, [h('p.a-set-intro', {}, 'Something went wrong on our side. Try again in a moment.')]);
    }
    detail.replaceChildren(el);
    pageCleanup = () => offs.splice(0).forEach((off) => off());
    if (!wideMq.matches) window.scrollTo(0, 0);
    if (animate && !reduceMotion()) {
      detail.classList.remove('is-in');
      void detail.offsetWidth;
      detail.classList.add('is-in');
    }
    // Screen readers land on the page's title.
    if (animate) (el.querySelector('h1') as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const onHash = () => {
    if (!location.hash.startsWith('#/settings')) return;
    open(true);
  };
  window.addEventListener('hashchange', onHash);
  const onWide = () => {
    shown = null;
    open(false);
  };
  wideMq.addEventListener('change', onWide);
  // Lost admin (someone changed your role): the admin pages go, and so do their rows.
  ctx.on('me', () => {
    if (ADMIN_PAGES.has(pageOfHash()) && !isAdmin()) open(true);
  });

  open(false);

  return () => {
    pageCleanup();
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener(SPACES_EVENT, onSpaces);
    wideMq.removeEventListener('change', onWide);
  };
};

// =================================================================================================
// The list
// =================================================================================================

function buildRoot(ctx: AppContext) {
  const store = ctx.store;

  // ---- You ----
  const meName = h('span.a-set-me__name');
  const meSub = h('span.a-set-me__sub');
  const meAv = h('span.a-set-me__av');
  const me = h(
    'a.a-set-me',
    { href: hrefPage('you'), 'data-page': 'you' },
    meAv,
    h('span.a-set-me__text', {}, meName, meSub),
    h('span.a-set-row__chev', { 'aria-hidden': 'true' }, icon('forward', 18)),
  );

  // ---- Today ----
  const spend = h('span.a-set-today__spend.a-num');
  const spendSub = h('span.a-set-today__sub');
  const ring = rings(116, 11, glyph('wallet', 20));
  const legend = h('ul.a-set-legend');
  const today = h(
    'a.a-set-today',
    { href: hrefPage('usage'), 'data-page': 'usage', 'aria-label': 'Usage and limits' },
    h('span.a-set-today__head', {}, h('span.a-set-today__kicker', {}, 'Today'), h('span.a-set-today__more', {}, 'Usage & limits', icon('forward', 16))),
    h('span.a-set-today__body', {}, ring.el, h('span.a-set-today__nums', {}, spend, spendSub, legend)),
  );

  // ---- The rows ----
  const valueEl = () => h('span');
  const vTheme = valueEl();
  const vSpaces = valueEl();
  const vNotify = valueEl();
  const vPeople = valueEl();
  const vUpdates = valueEl();
  const vAbout = valueEl();
  const rowAppearance = row({ lead: tile('auto', 'graphite'), title: 'Appearance', value: vTheme, href: `${hrefPage('you')}?theme`, attrs: { 'data-page': 'you-theme' } });
  const rowSpaces = row({ lead: tile('layers', 'honey'), title: 'Spaces', value: vSpaces, href: hrefPage('spaces'), attrs: { 'data-page': 'spaces' } });
  const rowNotify = row({ lead: tile('bell', 'rose'), title: 'Notifications', value: vNotify, href: hrefPage('notifications'), attrs: { 'data-page': 'notifications' } });
  const rowPeople = row({ lead: tile('key', 'sage'), title: 'People & access', value: vPeople, href: hrefPage('people'), attrs: { 'data-page': 'people' } });
  const rowUpdates = row({ lead: tile('update', 'aqua'), title: 'Updates', value: vUpdates, href: hrefPage('updates'), attrs: { 'data-page': 'updates' } });
  const rowAbout = row({ lead: tile('info', 'stone'), title: `About ${APP_NAME}`, value: vAbout, href: hrefPage('about'), attrs: { 'data-page': 'about' } });
  const officeGroup = section('The office', [rowPeople, rowUpdates, rowAbout]);

  const version = h('span.a-set-colophon__v.a-num');
  const el = h(
    'div.a-set-page.a-set-page--root.a-set-rise',
    {},
    h('h1.a-set-title', { tabindex: '-1' }, 'Settings'),
    me,
    today,
    section(null, [rowAppearance, rowSpaces, rowNotify]),
    officeGroup,
    h('p.a-set-colophon', {}, h('span.a-set-colophon__mark', {}, APP_NAME), version),
  );
  Array.from(el.children).forEach((c, i) => (c as HTMLElement).style.setProperty('--i', String(Math.min(i, 6))));
  // The rise plays once, when the list first appears.
  setTimeout(() => el.classList.remove('a-set-rise'), 900);

  const paint = () => {
    const account = store.me.account;
    const name = firstName() || 'You';
    meAv.replaceChildren(meAvatar(56));
    meName.textContent = account?.name ?? name;
    meSub.textContent = account ? `${account.role === 'admin' ? 'Admin' : 'Member'} · your own account` : store.me.admin ? 'Signed in with the office password' : 'Signed in';

    // Today
    const u = store.usage;
    const budget = u.budget;
    spend.textContent = u.today.costKnown === false ? '—' : fmtCost(u.today.cost);
    spendSub.textContent = budget !== undefined ? `of ${fmtCost(budget)} today` : `spent today · ${fmtTokens(tokensOf(u.today))} tokens`;
    const wins = store.limits.windows.length ? store.limits.windows : budget !== undefined ? [{ label: 'Budget', pct: Math.min(100, (u.today.cost / budget) * 100) }] : [];
    ring.update(wins);
    legend.replaceChildren(
      ...wins.slice(0, 3).map((w, i) =>
        h(
          'li.a-set-legend__item',
          { 'data-tint': RING_TINTS[i % 3] },
          h('span.a-set-legend__dot', { 'aria-hidden': 'true' }),
          h('span.a-set-legend__label', {}, w.label === '5h session' ? 'This session' : w.label),
          h('span.a-set-legend__pct.a-num', { 'data-level': levelOf(w.pct) }, `${Math.round(w.pct)}%`),
        ),
      ),
    );
    if (!wins.length) legend.append(h('li.a-set-legend__item.is-quiet', {}, 'Plan limits show up once the office has read them.'));

    // Rows
    vTheme.textContent = themeLabel(themePref());
    const floors = store.floors.filter((f) => !f.cloning);
    const hidden = hiddenSpaces();
    const on = floors.filter((f) => !hidden.has(f.id)).length;
    vSpaces.textContent = on === floors.length ? `${floors.length}` : `${on} of ${floors.length}`;
    const n = store.notify;
    vNotify.textContent = n.webhook ? (n.error ? 'Needs a look' : WEBHOOK_NAME[n.webhook.kind] === 'your webhook' ? 'On' : WEBHOOK_NAME[n.webhook.kind]) : 'Off';
    vNotify.classList.toggle('is-warn', !!n.error);
    rowPeople.hidden = !store.me.admin;
    vPeople.textContent = store.accounts ? (store.accounts.accounts.length ? plural(store.accounts.accounts.length, 'person', 'people') : 'Password only') : '';
    const up = store.upgrade;
    vUpdates.textContent = up.phase === 'building' || up.phase === 'restarting' ? 'Updating…' : up.checking ? 'Checking…' : up.latest ? 'New version' : up.available ? 'Up to date' : '';
    vUpdates.classList.toggle('is-accent', !!up.latest && up.phase === 'idle');
    vAbout.textContent = up.current?.sha ?? '';
    version.textContent = up.current ? `Version ${up.current.sha} · ${new Date(up.current.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Your whole office, in one calm place.';
  };
  paint();

  const setCurrent = (p: Page) => {
    el.querySelectorAll('[data-page]').forEach((r) => {
      const page = (r as HTMLElement).dataset.page;
      if (page === p) r.setAttribute('aria-current', 'page');
      else r.removeAttribute('aria-current');
    });
  };

  return { el, paint, setCurrent };
}

// =================================================================================================
// Pages
// =================================================================================================

/** A page: glass header with Back (phones), the large title, a sentence under it, its sections. */
function pageFrame(env: PageEnv, title: string, intro: string | Node | null, body: (Node | null)[], hero?: Node | null): HTMLElement {
  const h1 = h('h1.a-set-title.a-set-title--page', { tabindex: '-1' }, title);
  const header = h(
    'header.a-header.a-set-bar',
    {},
    h('div.a-header__start', {}, backButton('Settings', env.ctx.go, { view: 'settings' })),
    h('div.a-header__title', { 'aria-hidden': 'true' }, title),
  );
  const page = h(
    'div.a-set-page',
    {},
    hero ?? null,
    h1,
    intro ? h('p.a-set-intro', {}, intro) : null,
    ...body.filter((n): n is Node => !!n),
  );
  const wrap = h('div.a-set-pane', {}, header, page);
  const io = new IntersectionObserver(([e]) => header.classList.toggle('is-scrolled', !e.isIntersecting), { rootMargin: '-64px 0px 0px 0px' });
  io.observe(h1);
  env.cleanup(() => io.disconnect());
  return wrap;
}

// ---- You ----------------------------------------------------------------------------------------

function youPage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  const account = store.me.account;

  const heroAv = h('span.a-set-hero__av');
  const heroName = h('span.a-set-hero__name');
  const hero = h('div.a-set-hero', {}, heroAv, heroName, h('span.a-set-hero__sub', {}, account ? `${account.role === 'admin' ? 'Admin' : 'Member'} · signed in with your own account` : store.me.admin ? 'Signed in with the office password' : 'Signed in'));
  const paintHero = () => {
    heroAv.replaceChildren(meAvatar(88));
    heroName.textContent = account?.name ?? (firstName() || 'You');
  };
  paintHero();

  const sendProfile = (name: string, color: string) => {
    const p = store.profile;
    p.color = color;
    if (!account) p.name = `${name} 📱`;
    saveProfile({ name: account ? p.name.replace(/\s*📱\s*$/u, '') : name, color, look: p.look });
    ctx.net.send({ t: 'profile', name: p.name, color, look: p.look });
    paintHero();
    window.dispatchEvent(new Event(SPACES_EVENT)); // the list and the sidebar pick up the new name
  };

  // ---- Name ----
  let nameSection: HTMLElement;
  if (account) {
    nameSection = section('Name', [row({ lead: tile('user', 'ember'), title: 'Name', value: account.name })], 'Your name comes from your account, so everyone sees the same one.');
  } else {
    const current = (store.profile.name || '').replace(/\s*📱\s*$/u, '');
    const input = h('input.a-set-input', { type: 'text', maxlength: 24, value: current === 'Guest' ? '' : current, placeholder: 'Your name…', 'aria-label': 'Your name', autocomplete: 'given-name', autocapitalize: 'words', enterkeyhint: 'done' }) as HTMLInputElement;
    const save = button({ label: 'Save', variant: 'primary', size: 'sm' }) as HTMLButtonElement;
    save.hidden = true;
    const doSave = () => {
      const v = input.value.trim().slice(0, 24);
      if (!v) return input.focus();
      sendProfile(v, store.profile.color);
      save.hidden = true;
      buzz();
      toast(`Hello, ${v.split(/\s+/)[0]}`);
    };
    input.addEventListener('input', () => (save.hidden = input.value.trim() === current || !input.value.trim()));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && doSave());
    save.addEventListener('click', doSave);
    nameSection = section('Name', [h('div.a-set-row.a-set-row--field.has-lead', {}, h('span.a-set-row__lead', {}, tile('user', 'ember')), input, save)], 'What your teammates and everyone in the office see.');
  }

  // ---- Color ----
  const swatches = h('div.a-set-swatches', { role: 'radiogroup', 'aria-label': 'Your color' });
  const paintSwatches = () => {
    const now = store.profile.color.toLowerCase();
    swatches.replaceChildren(
      ...AVATAR_COLORS.map((c, i) => {
        const on = c.toLowerCase() === now;
        const b = h('button.a-set-swatch', { type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': `Color ${i + 1}`, tabindex: on ? '0' : '-1', style: `--a-who:${c}` }, on ? icon('check', 16) : null);
        b.addEventListener('click', () => {
          if (on) return;
          buzz();
          sendProfile((store.profile.name || '').replace(/\s*📱\s*$/u, ''), c);
          paintSwatches();
          (swatches.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
        });
        return b;
      }),
    );
  };
  paintSwatches();
  swatches.addEventListener('keydown', (e) => {
    const btns = Array.from(swatches.querySelectorAll('button'));
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (i < 0 || !d) return;
    e.preventDefault();
    btns[(i + d + btns.length) % btns.length].click();
  });
  const colorSection = section('Color', [h('div.a-set-row.a-set-row--swatches', {}, swatches)], 'Your dot in the office, and your initial here.');

  // ---- Appearance: three little screens, each in its own theme ----
  const tokens = themeTokens();
  const lightStyle = previewStyle(tokens?.light);
  const darkStyle = previewStyle(tokens?.dark);
  let pref = themePref();
  const themeBtns = THEMES.map((t) => {
    const screen =
      t.id === 'auto'
        ? h('span.a-set-theme__frame', {}, miniScreen(lightStyle), miniScreen(darkStyle, 'is-dark is-half'))
        : h('span.a-set-theme__frame', {}, miniScreen(t.id === 'light' ? lightStyle : darkStyle, t.id === 'dark' ? 'is-dark' : ''));
    const b = h(
      'button.a-set-theme',
      { type: 'button', role: 'radio', 'data-theme-choice': t.id },
      screen,
      h('span.a-set-theme__label', {}, h('span.a-set-theme__radio', { 'aria-hidden': 'true' }, icon('check', 12)), t.label),
      h('span.a-set-theme__note', {}, t.note),
    ) as HTMLButtonElement;
    b.addEventListener('click', () => choose(t.id));
    return b;
  });
  const themeGroup = h('div.a-set-themes', { role: 'radiogroup', 'aria-label': 'Appearance' }, ...themeBtns);
  const paintTheme = () =>
    themeBtns.forEach((b, i) => {
      const on = THEMES[i].id === pref;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  const choose = (p: ThemePref, focus = false) => {
    if (p === pref) return;
    pref = p;
    buzz();
    // A soft crossfade of the whole app into the new theme, where the browser can.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const apply = () => applyTheme(p, true);
    if (doc.startViewTransition && !reduceMotion()) doc.startViewTransition(apply);
    else apply();
    paintTheme();
    if (focus) themeBtns[THEMES.findIndex((t) => t.id === p)].focus();
    window.dispatchEvent(new Event(SPACES_EVENT));
  };
  themeGroup.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = THEMES.findIndex((t) => t.id === pref);
    choose(THEMES[(i + d + THEMES.length) % THEMES.length].id, true);
  });
  paintTheme();
  const themeSection = h(
    'section.a-set-section',
    { id: 'a-set-theme', 'aria-labelledby': 'a-set-theme-l' },
    h('h2.a-set-label', { id: 'a-set-theme-l' }, 'Appearance'),
    h('div.a-set-group.a-set-group--pad', {}, themeGroup),
    h('p.a-set-foot', {}, 'Auto follows your phone or computer: light by day, dark at night.'),
  );

  // ---- Sign out ----
  const signOutRow = row({
    title: 'Sign out',
    tone: 'danger',
    center: true,
    onClick: async () => {
      const ok = await confirmDialog({ title: `Sign out of ${APP_NAME}?`, body: 'Your teammates keep working. You can sign back in any time.', action: 'Sign out', danger: true });
      if (ok) await signOut();
    },
  });

  const el = pageFrame(env, 'You', null, [nameSection, colorSection, themeSection, section(null, [signOutRow])], hero);
  if (location.hash.includes('?theme')) requestAnimationFrame(() => themeSection.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }));
  env.on('me', paintHero);
  return el;
}

// ---- Usage & limits -----------------------------------------------------------------------------

function usagePage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;

  // ---- Hero: the rings, big ----
  const heroSpend = h('span.a-set-bigring__spend.a-num');
  const heroCaption = h('span.a-set-bigring__caption');
  const big = rings(208, 16, h('span.a-set-bigring__center', {}, heroSpend, heroCaption));
  const hero = h('div.a-set-bigring', {}, big.el);

  // ---- Today ----
  const todayGroup = h('div.a-set-group');
  const todaySection = h('section.a-set-section', {}, h('h2.a-set-label', {}, 'Today'), todayGroup, h('p.a-set-foot', {}, 'Claude Code across every space, since midnight on the office’s computer.'));
  const paintToday = () => {
    const u = store.usage;
    const t = u.today;
    const unknown = t.costKnown === false;
    heroSpend.textContent = unknown ? '—' : fmtCost(t.cost);
    heroCaption.textContent = u.budget !== undefined ? `of ${fmtCost(u.budget)} today` : 'spent today';
    const rows: HTMLElement[] = [];
    if (u.budget !== undefined) {
      const pct = Math.min(100, (t.cost / u.budget) * 100);
      const over = t.cost >= u.budget;
      rows.push(
        h(
          'div.a-set-row.a-set-row--stack.has-lead',
          {},
          h('span.a-set-row__lead', {}, tile('wallet', 'ember')),
          h(
            'span.a-set-row__text',
            {},
            h('span.a-set-row__line', {}, h('span.a-set-row__title', {}, 'Daily budget'), h('span.a-set-row__figure.a-num', {}, `${Math.round(pct)}%`)),
            meter(pct, 'ember', 'Daily budget used'),
            h('span.a-set-row__sub', {}, over ? (u.pauseHiring ? 'Spent. No new teammates until tomorrow.' : 'Spent for today.') : `${fmtCost(Math.max(0, u.budget - t.cost))} left today`),
          ),
        ),
      );
    }
    rows.push(
      row({ lead: tile('wallet', 'ember'), title: 'Spent', value: h('span.a-num', {}, unknown ? 'Not known' : fmtCost(t.cost)), sub: `${plural(t.calls, 'reply', 'replies')} from Claude` }),
      row({
        lead: tile('gauge', 'aqua'),
        title: 'Tokens',
        value: h('span.a-num', {}, fmtTokens(tokensOf(t))),
        sub: `${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out · ${fmtTokens(t.cacheRead + t.cacheWrite)} remembered`,
      }),
      row({ lead: tile('list', 'stone'), title: 'All time', value: h('span.a-num', {}, `${fmtCost(u.total.cost)}`), sub: `${fmtTokens(tokensOf(u.total))} tokens` }),
    );
    todayGroup.replaceChildren(...rows);
  };

  // ---- The Claude plan ----
  const planGroup = h('div.a-set-group');
  const planLabel = h('h2.a-set-label', {}, 'Claude plan');
  const planFoot = h('p.a-set-foot');
  const refresh = button({ label: 'Check again', icon: 'retry', variant: 'ghost', size: 'sm' }) as HTMLButtonElement;
  refresh.addEventListener('click', () => {
    ctx.net.send({ t: 'limits.refresh' });
    setBusy(refresh, true);
    setTimeout(() => setBusy(refresh, false), 4000);
  });
  const planSection = h('section.a-set-section', {}, h('div.a-set-label-row', {}, planLabel, refresh), planGroup, planFoot);
  const paintPlan = () => {
    const l = store.limits;
    big.update(l.windows);
    const plan = l.plan ? l.plan.charAt(0).toUpperCase() + l.plan.slice(1) : '';
    planLabel.textContent = plan ? `Claude plan · ${plan}` : 'Claude plan';
    setBusy(refresh, false);
    if (!l.windows.length) {
      planGroup.replaceChildren(row({ lead: tile('gauge', 'aqua'), title: 'Not read yet', sub: 'The limits show up once the office has read them from Claude.' }));
      planFoot.textContent = '';
      return;
    }
    planGroup.replaceChildren(
      ...l.windows.map((w, i) =>
        h(
          'div.a-set-row.a-set-row--stack.has-lead',
          {},
          h('span.a-set-row__lead', {}, h('span.a-set-ringdot', { 'data-tint': RING_TINTS[i % 3], 'aria-hidden': 'true' })),
          h(
            'span.a-set-row__text',
            {},
            h(
              'span.a-set-row__line',
              {},
              h('span.a-set-row__title', {}, w.label === '5h session' ? 'This session (5 hours)' : w.label === 'Week' ? 'This week, all models' : w.label),
              h('span.a-set-row__figure.a-num', { 'data-level': levelOf(w.pct) }, `${Math.round(w.pct)}%`),
            ),
            meter(w.pct, RING_TINTS[i % 3], w.label),
            w.resetsAt ? h('span.a-set-row__sub', {}, `Starts over ${startsOver(w.resetsAt)}`) : null,
          ),
        ),
      ),
    );
    planFoot.textContent = `The account every Claude teammate runs on, for the whole office. Read ${timeAgo(l.at)}.`;
  };

  // ---- This computer ----
  const machineGroup = h('div.a-set-group');
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
  const paintMachine = () => {
    const m = store.machine;
    const mem = pct(m.memUsed, m.memTotal);
    machineGroup.replaceChildren(
      h(
        'div.a-set-row.a-set-row--stack.has-lead',
        {},
        h('span.a-set-row__lead', {}, tile('cpu', 'graphite')),
        h(
          'span.a-set-row__text',
          {},
          h('span.a-set-row__line', {}, h('span.a-set-row__title', {}, 'Processor'), h('span.a-set-row__figure.a-num', { 'data-level': levelOf(m.cpu) }, `${Math.round(m.cpu)}%`)),
          h('span.a-set-spark-wrap', { 'data-tint': 'aqua' }, sparkline(m.history.map(([c]) => c), 300, 36)),
          h('span.a-set-row__sub', {}, `${m.cores} cores, the last few minutes`),
        ),
      ),
      h(
        'div.a-set-row.a-set-row--stack.has-lead',
        {},
        h('span.a-set-row__lead', {}, tile('layers', 'graphite')),
        h(
          'span.a-set-row__text',
          {},
          h('span.a-set-row__line', {}, h('span.a-set-row__title', {}, 'Memory'), h('span.a-set-row__figure.a-num', { 'data-level': levelOf(mem) }, `${mem}%`)),
          meter(mem, 'sage', 'Memory used'),
          h('span.a-set-row__sub', {}, `${gb(m.memUsed)} of ${gb(m.memTotal)}${m.pressure ? ` · ${m.pressure}` : ''}`),
        ),
      ),
    );
  };

  // ---- Most teammates at once (machine.limit) ----
  const machineStep = stepper({
    label: 'Most teammates at once',
    min: 1,
    max: store.machine.ceiling ?? 64,
    get: () => store.machine.limit ?? store.machine.ceiling ?? Math.max(store.machine.workers, 8),
    send: (n) => ctx.net.send({ t: 'machine.limit', limit: n }),
  });
  const limitPips = h('span.a-set-row__pips');
  const limitSub = h('span.a-set-row__sub');
  const limitReset = button({ label: '', variant: 'ghost', size: 'sm' }) as HTMLButtonElement;
  limitReset.addEventListener('click', async () => {
    const m = store.machine;
    const ok = await confirmDialog({ title: m.ceiling ? `Back to ${m.ceiling}?` : 'Take the limit off?', body: m.ceiling ? `The office goes back to its own most, ${m.ceiling} at once.` : 'The office will add a teammate for every free seat.', action: m.ceiling ? `Back to ${m.ceiling}` : 'Take it off' });
    if (ok) ctx.net.send({ t: 'machine.limit', limit: null });
  });
  const limitGroup = h('div.a-set-group');
  const limitFoot = h('p.a-set-foot');
  const paintLimit = () => {
    const m = store.machine;
    const admin = store.me.admin;
    machineStep.sync();
    const cap = m.limit ?? m.ceiling;
    limitPips.replaceChildren(pips(cap ?? Math.max(m.workers, 1), m.workers, 'sage'));
    limitSub.textContent = cap ? `${m.workers} of ${cap} here now, across every space` : `${plural(m.workers, 'teammate')} here now · no limit`;
    limitReset.textContent = m.ceiling ? `Back to ${m.ceiling}` : 'No limit';
    limitReset.hidden = !admin || !m.set;
    limitGroup.replaceChildren(
      h(
        'div.a-set-row.a-set-row--stack.has-lead',
        {},
        h('span.a-set-row__lead', {}, tile('team', 'sage')),
        h(
          'span.a-set-row__text',
          {},
          h('span.a-set-row__line', {}, h('span.a-set-row__title', {}, 'Most at once'), admin ? machineStep.el : h('span.a-set-row__figure.a-num', {}, cap ? String(cap) : 'No limit')),
          limitPips,
          limitSub,
        ),
      ),
      ...(admin && m.set ? [h('div.a-set-row.a-set-row--actions', {}, h('span.a-set-row__sub', {}, `Set by ${m.set.by} ${timeAgo(m.set.at)}`), limitReset)] : []),
    );
    limitFoot.textContent =
      'Every space counts, and helpers and board teammates too. Past the limit, adding another teammate is turned down.' +
      (m.ceiling ? ` The office was started with at most ${m.ceiling}, so it can't go higher.` : '') +
      (admin ? '' : ' Only an admin can change it.');
  };

  // ---- Tasks at once, for the space the office has open here (queue.limit) ----
  const queueStep = stepper({
    label: 'Tasks at once',
    min: 0,
    max: SEATS.length,
    get: () => store.queue.maxWorkers,
    send: (n) => ctx.net.send({ t: 'queue.limit', maxWorkers: n }),
    format: (n) => (n === 0 ? 'Paused' : String(n)),
  });
  const queueGroup = h('div.a-set-group');
  const queueFoot = h('p.a-set-foot');
  const paintQueue = () => {
    queueStep.sync();
    const f = store.floor;
    const busy = store.queue.tasks.filter((t) => t.status === 'running').length;
    const waiting = store.queue.tasks.filter((t) => t.status === 'queued').length;
    queueGroup.replaceChildren(
      h(
        'div.a-set-row.a-set-row--stack.has-lead',
        {},
        h('span.a-set-row__lead', {}, tile('tasks', 'honey')),
        h(
          'span.a-set-row__text',
          {},
          h('span.a-set-row__line', {}, h('span.a-set-row__title', {}, f ? spaceName(f) : 'Task list'), queueStep.el),
          h('span.a-set-row__sub', {}, store.queue.maxWorkers === 0 ? 'The task list is paused: nobody new picks up a task.' : `${plural(waiting, 'task')} waiting${busy ? ` · ${busy} being worked on` : ''}`),
        ),
      ),
    );
    queueFoot.textContent = `How many tasks from ${f ? spaceName(f) : 'this space'}’s list are worked on at once. 0 pauses it. Each space keeps its own; open a space’s Tasks to change another.`;
  };

  paintToday();
  paintPlan();
  paintMachine();
  paintLimit();
  paintQueue();
  env.on('usage', paintToday);
  env.on('limits', paintPlan);
  env.on('machine', () => (paintMachine(), paintLimit()));
  env.on('me', paintLimit);
  env.on('queue', paintQueue);
  env.on('floor', paintQueue);
  // The "starts over in…" lines move with the clock.
  env.every(60_000, paintPlan);
  // Stale limits: read them again as she opens this.
  if (Date.now() - store.limits.at > 10 * 60_000) ctx.net.send({ t: 'limits.refresh' });

  return pageFrame(
    env,
    'Usage & limits',
    'What the office spends, how much of the Claude plan is left, and how many teammates may work at once.',
    [
      todaySection,
      planSection,
      h('section.a-set-section', {}, h('h2.a-set-label', {}, 'Teammates at once'), limitGroup, limitFoot),
      h('section.a-set-section', {}, h('h2.a-set-label', {}, 'Tasks at once'), queueGroup, queueFoot),
      h('section.a-set-section', {}, h('h2.a-set-label', {}, 'The office’s computer'), machineGroup),
    ],
    hero,
  );
}

// ---- People & access ----------------------------------------------------------------------------

function initials(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

// Made on the office PC itself, a localhost link would only open there: share the Tailscale address instead.
const inviteLink = (v: AccountInvite) => `${shareOrigin()}/join#${v.token}`;
const expiresIn = (t: number) => {
  const d = Math.round((t - Date.now()) / 86_400_000);
  return d >= 1 ? `link works for ${plural(d, 'more day')}` : 'link works until tonight';
};

type Os = 'mac' | 'linux' | 'windows';
const OS_LABEL: Record<Os, string> = { mac: 'Mac', windows: 'Windows', linux: 'Linux' };
const guessOs = (): Os => (/Windows/i.test(navigator.userAgent) ? 'windows' : /Mac|iPhone|iPad/i.test(navigator.userAgent) ? 'mac' : 'linux');
/** The same one-line tunnel the 3D office's invite window gives (ui/team.ts tunnelCommand). */
function tunnelCommand(t: TeamState, os: Os): string {
  const url = `http://localhost:${t.port}`;
  const openCmd = os === 'mac' ? `open ${url}` : os === 'windows' ? `start ${url}` : `xdg-open ${url} >/dev/null 2>&1 &`;
  return `ssh -o ExitOnForwardFailure=yes -o PermitLocalCommand=yes -o LocalCommand="${openCmd}" -L ${t.port}:localhost:${t.port} ${t.ssh}`;
}

function peoplePage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  ctx.net.send({ t: 'accounts.get' });
  if (store.invites) ctx.net.send({ t: 'team.get' });

  let fresh: AccountInvite | null = null;
  let inviteSheet: { onInvited(msg: Extract<ServerMsg, { t: 'accounts.invited' }>): void } | null = null;

  const inviteBtn = button({ label: 'Invite someone', icon: 'add', variant: 'primary', block: true, onClick: () => openInvite() });
  const accountsSection = h('div');
  const invitesSection = h('div');
  const sharedSection = h('div');
  const teamSection = h('div');

  const accountMenu = (a: AccountInfo, anchor: HTMLElement) => {
    openMenu(
      anchor,
      [
        {
          label: a.role === 'admin' ? 'Make them a member' : 'Make them an admin',
          icon: 'team',
          onSelect: async () => {
            const toAdmin = a.role !== 'admin';
            const ok = await confirmDialog({
              title: toAdmin ? `Make ${a.name} an admin?` : `Make ${a.name} a member?`,
              body: toAdmin ? 'Admins can invite and remove people, and change the office’s limits.' : 'They keep working as before, but can’t manage people or the office’s limits any more.',
              action: toAdmin ? 'Make admin' : 'Make member',
              danger: !toAdmin,
            });
            if (ok) ctx.net.send({ t: 'accounts.role', accountId: a.id, role: (toAdmin ? 'admin' : 'member') as AccountRole });
          },
        },
        {
          label: `Remove ${a.name}`,
          icon: 'remove',
          danger: true,
          divider: true,
          onSelect: async () => {
            const shared = store.accounts?.sharedPassword;
            const ok = await confirmDialog({
              title: `Remove ${a.name}?`,
              body: `Their account is deleted and they’re signed out everywhere right away. What they started keeps running.${shared ? ` If ${a.name} knows the shared office password, they can still use it: switch it off below.` : ''}`,
              action: 'Remove',
              danger: true,
            });
            if (ok) ctx.net.send({ t: 'accounts.revoke', accountId: a.id });
          },
        },
      ],
      a.name,
    );
  };

  const inviteMenu = (v: AccountInvite, anchor: HTMLElement) => {
    openMenu(
      anchor,
      [
        { label: 'Copy the link', icon: 'external', onSelect: () => void copyWithToast(inviteLink(v), 'Link copied') },
        { label: 'Share…', icon: 'send', onSelect: () => void shareOrCopy(inviteLink(v), `Your invite to ${APP_NAME}`) },
        {
          label: 'Cancel this invite',
          icon: 'remove',
          danger: true,
          divider: true,
          onSelect: async () => {
            const ok = await confirmDialog({ title: 'Cancel this invite?', body: 'The link stops working. You can always make a new one.', action: 'Cancel invite', cancel: 'Keep it', danger: true });
            if (!ok) return;
            if (fresh?.id === v.id) fresh = null;
            ctx.net.send({ t: 'accounts.cancel', inviteId: v.id });
          },
        },
      ],
      'Invite',
    );
  };

  const render = () => {
    const s = store.accounts;
    const me = store.me;
    if (!s) {
      accountsSection.replaceChildren(section('People', [h('div.a-set-row', {}, h('span.a-set-row__sub', {}, 'Loading…'))]));
      invitesSection.replaceChildren();
      sharedSection.replaceChildren();
    } else {
      const people = [...s.accounts].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      accountsSection.replaceChildren(
        section(
          `People · ${s.accounts.length}`,
          people.length
            ? people.map((a) => {
                const you = me.account?.name === a.name;
                const seen = a.online ? 'In the office now' : a.lastSeenAt ? `Last here ${timeAgo(a.lastSeenAt)}` : 'Hasn’t come in yet';
                const lead = h('span.a-set-person', { 'data-online': a.online ? 'true' : undefined, 'aria-hidden': 'true' }, initials(a.name));
                const r = row({
                  lead,
                  title: h('span', {}, a.name, you ? h('span.a-set-you', {}, ' (you)') : null),
                  sub: seen,
                  trail: h('span.a-set-role', { 'data-role': a.role }, a.role === 'admin' ? 'Admin' : 'Member'),
                  chevron: !you,
                  onClick: you ? undefined : (e) => accountMenu(a, e.currentTarget as HTMLElement),
                  attrs: you ? undefined : { 'aria-haspopup': 'menu', 'aria-label': `${a.name}, ${a.role}, ${seen}` },
                });
                return r;
              })
            : [h('div.a-set-row', {}, h('span.a-set-row__sub', {}, 'Nobody has an account yet. Invite someone to make the first one.'))],
          people.length > 1 || (people.length === 1 && me.account?.name !== people[0].name) ? 'Tap someone to change what they can do, or to remove them.' : null,
        ),
      );

      invitesSection.replaceChildren(
        s.invites.length
          ? section(
              `Waiting to join · ${s.invites.length}`,
              s.invites.map((v) =>
                row({
                  lead: tile('link', v.id === fresh?.id ? 'ember' : 'stone'),
                  title: v.name ?? 'They pick a name',
                  sub: `${v.role === 'admin' ? 'Admin' : 'Member'} · ${expiresIn(v.expiresAt)}`,
                  trail: iconButtonSm('copy', 'Copy the link', () => void copyWithToast(inviteLink(v), 'Link copied')),
                  chevron: true,
                  onClick: (e) => {
                    if ((e.target as HTMLElement).closest('.a-set-mini-btn')) return;
                    inviteMenu(v, e.currentTarget as HTMLElement);
                  },
                  attrs: { 'aria-haspopup': 'menu' },
                }),
              ),
              'Each link makes one account, works once, and stops working after 7 days.',
            )
          : h('span'),
      );

      // The shared password: the old way in, kept until everyone has an account.
      const canSwitchOff = me.account?.role === 'admin';
      const sw = h('input.a-switch', { type: 'checkbox', role: 'switch', id: 'a-set-shared' }) as HTMLInputElement;
      sw.checked = s.sharedPassword;
      sw.disabled = s.sharedPassword && !canSwitchOff;
      sw.addEventListener('change', async () => {
        if (sw.checked) {
          ctx.net.send({ t: 'accounts.shared', on: true });
          return;
        }
        sw.checked = true;
        const ok = await confirmDialog({
          title: 'Switch off the shared password?',
          body: 'From now on only people with their own account can sign in. Everyone who came in with the shared password is signed out right away.',
          action: 'Switch it off',
          danger: true,
        });
        if (ok) {
          sw.checked = false;
          ctx.net.send({ t: 'accounts.shared', on: false });
        }
      });
      sharedSection.replaceChildren(
        section(
          'The shared password',
          [row({ lead: tile('key', 'honey'), title: 'Let the shared password in', sub: s.sharedPassword ? 'On: anyone who knows it gets in as an admin' : 'Off: only accounts can sign in', trail: sw, labelFor: 'a-set-shared' })],
          s.sharedPassword
            ? canSwitchOff
              ? 'Once everyone has an account, switch it off, so removing someone really locks them out.'
              : 'Sign in with an admin account of your own before you switch it off, or nobody could get back in.'
            : `If every admin is ever locked out, run “${commandLine('accounts password on')}” on the office’s computer.`,
        ),
      );
    }

    // Access by GitHub key: only offices deployed with deploy/aws.sh can manage it.
    const t = store.team;
    if (!store.invites || !t || t.unavailable) {
      teamSection.replaceChildren();
    } else {
      teamSection.replaceChildren(teamBlock(env, t));
    }
  };

  const openInvite = () => {
    let role: AccountRole = 'member';
    const name = h('input.a-set-input.a-set-input--boxed', { type: 'text', maxlength: 24, placeholder: 'Their name (or leave it empty)', 'aria-label': 'Their name', autocomplete: 'off', autocapitalize: 'words' }) as HTMLInputElement;
    const roleSeg = segmented({
      label: 'What they can do',
      role: 'radiogroup',
      value: role,
      items: [
        { value: 'member', label: 'Member' },
        { value: 'admin', label: 'Admin' },
      ],
      onChange: (v) => {
        role = v as AccountRole;
        roleNote.textContent = role === 'admin' ? 'Admins can also invite and remove people, and change the office’s limits.' : 'Members work with every teammate, but can’t manage people.';
      },
    });
    roleSeg.classList.add('a-set-seg');
    const roleNote = h('p.a-set-foot.a-set-foot--flush', {}, 'Members work with every teammate, but can’t manage people.');
    const result = h('div.a-set-invite-result');
    const make = button({ label: 'Make an invite link', variant: 'primary', size: 'lg', block: true }) as HTMLButtonElement;
    const body = h(
      'div.a-set-sheet',
      {},
      h('p.a-set-intro', {}, 'You get a link to send them. It makes one account, with its own name and password, and works once within 7 days.'),
      h('label.a-set-field', {}, h('span.a-set-field__label', {}, 'Name'), name),
      h('div.a-set-field', {}, h('span.a-set-field__label', {}, 'What they can do'), roleSeg, roleNote),
      result,
    );
    const s = sheet({ title: 'Invite someone', content: [body], footer: make, className: 'a-set-sheet-dialog' });
    // Leaving the page (Back, another tab) takes the sheet with it.
    env.cleanup(() => s.close());
    make.addEventListener('click', () => {
      if (make.dataset.done) return s.close();
      setBusy(make, true);
      ctx.net.send({ t: 'accounts.invite', name: name.value.trim() || undefined, role });
    });
    inviteSheet = {
      onInvited: (msg) => {
        setBusy(make, false);
        if (msg.error || !msg.invite) {
          result.replaceChildren(h('p.a-set-alert', { role: 'alert' }, icon('warning', 16), msg.error ?? 'Couldn’t make the invite. Try again in a moment.'));
          return;
        }
        const v = msg.invite;
        fresh = v;
        buzz();
        const link = inviteLink(v);
        result.replaceChildren(
          h(
            'div.a-set-linkcard',
            {},
            h('span.a-set-linkcard__kicker', {}, icon('check', 14), `Send this to ${v.name ?? 'them'}`),
            h('code.a-set-linkcard__url', {}, link),
            h(
              'span.a-set-linkcard__actions',
              {},
              button({ label: 'Copy link', icon: 'external', size: 'sm', onClick: () => void copyWithToast(link, 'Link copied') }),
              button({ label: 'Share…', icon: 'send', size: 'sm', onClick: () => void shareOrCopy(link, `Your invite to ${APP_NAME}`) }),
            ),
          ),
        );
        (make.querySelector('.a-btn__label') as HTMLElement).textContent = 'Done';
        make.dataset.done = '1';
        name.value = '';
      },
    };
    setTimeout(() => name.focus({ preventScroll: true }), 60);
  };

  env.reply((msg) => {
    if (msg.t === 'accounts.invited') inviteSheet?.onInvited(msg);
  });
  env.on('accounts', render);
  env.on('team', render);
  env.on('me', render);
  render();

  return pageFrame(env, 'People & access', 'Who can come into the office, and what they can do there.', [h('div.a-set-cta', {}, inviteBtn), accountsSection, invitesSection, sharedSection, teamSection]);
}

function iconButtonSm(name: GlyphName | IconName, label: string, onClick: () => void): HTMLElement {
  const b = h('button.a-set-mini-btn', { type: 'button', 'aria-label': label, title: label }, glyph(name, 18));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** SSH-key access for people outside (offices deployed with deploy/aws.sh), as in ui/team.ts. */
function teamBlock(env: PageEnv, t: TeamState): HTMLElement {
  const { ctx } = env;
  let os = guessOs();
  const input = h('input.a-set-input', { type: 'text', maxlength: 40, placeholder: 'GitHub username…', 'aria-label': 'GitHub username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }) as HTMLInputElement;
  const add = button({ label: 'Add', variant: 'primary', size: 'sm' }) as HTMLButtonElement;
  const status = h('p.a-set-foot');
  const submit = () => {
    const github = input.value.trim();
    if (!github) return input.focus();
    setBusy(add, true);
    status.textContent = `Fetching ${github}’s keys from GitHub…`;
    ctx.net.send({ t: 'team.invite', github });
  };
  add.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  env.reply((msg) => {
    if (msg.t !== 'team.invited') return;
    setBusy(add, false);
    status.textContent = msg.error ? msg.error : `${msg.name} can come in now (${plural(msg.keys ?? 0, 'key')}). Send them the command below.`;
    if (!msg.error) input.value = '';
  });
  const cmd = h('code.a-set-linkcard__url');
  const osSeg = segmented({
    label: 'Their computer',
    role: 'radiogroup',
    value: os,
    items: (Object.keys(OS_LABEL) as Os[]).map((o) => ({ value: o, label: OS_LABEL[o] })),
    onChange: (v) => {
      os = v as Os;
      cmd.textContent = tunnelCommand(t, os);
    },
  });
  osSeg.classList.add('a-set-seg');
  cmd.textContent = tunnelCommand(t, os);

  const members = t.members.map((m) =>
    row({
      lead: h('span.a-set-person', { 'aria-hidden': 'true' }, initials(m.name)),
      title: m.name,
      sub: plural(m.keys, 'key'),
      trail: button({
        label: 'Remove',
        variant: 'danger-quiet',
        size: 'sm',
        onClick: async () => {
          const ok = await confirmDialog({ title: `Remove ${m.name}?`, body: 'Their keys stop working right away. Everyone else’s connection drops for a moment too.', action: 'Remove', danger: true });
          if (ok) ctx.net.send({ t: 'team.remove', name: m.name });
        },
      }),
    }),
  );
  return h(
    'div',
    {},
    section(
      'Access from outside, by GitHub key',
      [h('div.a-set-row.a-set-row--field.has-lead', {}, h('span.a-set-row__lead', {}, tile('github', 'graphite')), input, add), ...members],
      status,
    ),
    h(
      'section.a-set-section',
      {},
      h('h2.a-set-label', {}, 'Then send them this'),
      h('div.a-set-group.a-set-group--pad', {}, osSeg, h('div.a-set-linkcard', {}, cmd, h('span.a-set-linkcard__actions', {}, button({ label: 'Copy', icon: 'external', size: 'sm', onClick: () => void copyWithToast(cmd.textContent ?? '', 'Command copied') })))),
      h('p.a-set-foot', {}, t.fingerprint ? `The first time, it asks whether to trust the office. Only say yes if it shows ${t.fingerprint}.` : 'It opens the office in their browser while that window stays open.'),
    ),
  );
}

// ---- Notifications ------------------------------------------------------------------------------

function notificationsPage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  const statusCard = h('div.a-set-status');
  const input = h('input.a-set-input', { type: 'url', inputmode: 'url', placeholder: 'Paste the address…', 'aria-label': 'Slack or Discord webhook address', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }) as HTMLInputElement;
  const save = button({ label: 'Save', variant: 'primary', size: 'sm' }) as HTMLButtonElement;
  const fieldFoot = h('p.a-set-foot');
  const actions = h('div');

  const doSave = () => {
    const url = input.value.trim();
    if (!url) return input.focus();
    if (!/^https:\/\//i.test(url)) {
      fieldFoot.textContent = 'That doesn’t look like a webhook address. It starts with https://';
      fieldFoot.classList.add('is-warn');
      return input.focus();
    }
    fieldFoot.classList.remove('is-warn');
    ctx.net.send({ t: 'notify.webhook', url });
    input.value = '';
    buzz();
    toast('Saved. Send a test to check it.');
  };
  save.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && doSave());

  const render = () => {
    const { webhook, error, lastSentAt } = store.notify;
    const where = webhook ? WEBHOOK_NAME[webhook.kind] : '';
    statusCard.dataset.state = !webhook ? 'off' : error ? 'error' : 'on';
    statusCard.replaceChildren(
      h('span.a-set-status__orb', { 'aria-hidden': 'true' }, glyph('bell', 26)),
      h(
        'span.a-set-status__text',
        {},
        h('span.a-set-status__title', {}, !webhook ? 'Not set up' : error ? `Posting to ${where} isn’t working` : `Posting to ${where}`),
        h(
          'span.a-set-status__sub',
          {},
          !webhook
            ? 'Get a message in Slack or Discord when a teammate needs you or finishes, and nobody is looking.'
            : error
              ? error
              : `${webhook.hint} · set by ${webhook.by} ${timeAgo(webhook.at)}${lastSentAt ? ` · last message ${timeAgo(lastSentAt)}` : ''}`,
        ),
      ),
    );
    (save.querySelector('.a-btn__label') as HTMLElement).textContent = webhook ? 'Replace' : 'Save';
    input.placeholder = webhook ? 'Paste a new address…' : 'Paste the address…';
    fieldFoot.textContent = 'In Slack or Discord, make an “incoming webhook” for a channel and paste its address here. It’s for everyone in the office.';
    actions.replaceChildren(
      webhook
        ? section(null, [
            row({
              lead: tile('test', 'aqua'),
              title: 'Send a test message',
              sub: `Posts a hello to ${where}`,
              onClick: () => {
                ctx.net.send({ t: 'notify.test' });
                buzz();
                toast(`Sending a test to ${where}…`);
              },
            }),
            row({
              lead: tile('remove', 'rose'),
              title: 'Stop posting',
              tone: 'danger',
              onClick: async () => {
                const ok = await confirmDialog({ title: `Stop posting to ${where}?`, body: 'The office forgets the address. You can paste it again any time.', action: 'Stop posting', danger: true });
                if (ok) ctx.net.send({ t: 'notify.webhook', url: '' });
              },
            }),
          ])
        : h('span'),
    );
  };
  render();
  env.on('notify', render);

  return pageFrame(env, 'Notifications', null, [
    statusCard,
    h('section.a-set-section', {}, h('h2.a-set-label', {}, 'Webhook address'), h('div.a-set-group', {}, h('div.a-set-row.a-set-row--field.has-lead', {}, h('span.a-set-row__lead', {}, tile('link', 'rose')), input, save)), fieldFoot),
    actions,
  ]);
}

// ---- Spaces -------------------------------------------------------------------------------------

function spacesPage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  const showSection = h('div');
  const addSection = h('div');
  const dirSection = h('div');

  let sig = '';
  const renderShow = () => {
    const floors = store.floors;
    const key = floors.map((f) => `${f.id}:${f.name}:${f.cloning ? 1 : 0}:${f.workers}:${f.busy}:${f.waiting}`).join('|');
    if (key === sig) return;
    sig = key;
    const hidden = hiddenSpaces();
    const rows = floors.map((f) => {
      const id = `a-set-space-${f.id}`;
      const { title, sub } = splitSpaceName(f.name);
      const counts = f.cloning ? 'Being set up…' : [plural(f.workers, 'teammate'), f.busy ? `${f.busy} working` : '', f.waiting ? `${f.waiting} waiting on you` : ''].filter(Boolean).join(' · ');
      const box = h('input.a-switch', { type: 'checkbox', role: 'switch', id }) as HTMLInputElement;
      box.checked = !hidden.has(f.id);
      box.disabled = !!f.cloning;
      box.addEventListener('change', () => {
        const now = hiddenSpaces();
        if (box.checked) now.delete(f.id);
        else now.add(f.id);
        setHiddenSpaces(now);
        buzz();
        paintFoot();
      });
      return row({
        lead: h('span.a-set-tile.a-set-tile--emoji', { 'aria-hidden': 'true', style: `--a-space:${spaceColor(f.id)}` }, spaceEmoji(f)),
        title,
        sub: sub ? `${sub} · ${counts}` : counts,
        trail: box,
        labelFor: id,
      });
    });
    const foot = h('p.a-set-foot');
    const paintFoot = () => {
      const h2 = hiddenSpaces();
      const allOff = floors.length > 0 && floors.every((f) => h2.has(f.id));
      foot.textContent = allOff ? 'With every space off, Home has nothing to show.' : 'Only on this device. Everyone else still sees every space.';
    };
    paintFoot();
    showSection.replaceChildren(
      h('section.a-set-section', {}, h('h2.a-set-label', {}, 'Show on this device'), h('div.a-set-group', {}, ...(rows.length ? rows : [h('div.a-set-row', {}, h('span.a-set-row__sub', {}, 'No spaces yet.'))])), foot),
    );
  };

  // ---- Add a space from GitHub (admins) ----
  const renderAdd = () => {
    if (!store.me.admin) return addSection.replaceChildren();
    const full = store.floors.length >= MAX_FLOORS;
    addSection.replaceChildren(
      section(
        null,
        [
          row({
            lead: tile('github', 'graphite'),
            title: 'Add a space from GitHub',
            sub: full ? `The office holds ${MAX_FLOORS} spaces at most.` : 'Pick one of your projects and it gets its own space.',
            chevron: !full,
            onClick: full ? undefined : () => openAddSpace(env),
            tone: full ? undefined : 'accent',
          }),
        ],
      ),
    );
  };

  // ---- The projects folder (admins move it) ----
  const dirInput = h('input.a-set-input.a-set-input--mono', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Projects folder', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }) as HTMLInputElement;
  const dirSave = button({ label: 'Save', variant: 'primary', size: 'sm' }) as HTMLButtonElement;
  dirSave.hidden = true;
  const saveDir = () => {
    const dir = dirInput.value.trim();
    if (!dir) return dirInput.focus();
    if (dir !== store.projectsDir.dir) ctx.net.send({ t: 'floor.projectsDir', dir });
    dirSave.hidden = true;
    buzz();
  };
  dirSave.addEventListener('click', saveDir);
  dirInput.addEventListener('input', () => (dirSave.hidden = dirInput.value.trim() === store.projectsDir.dir || !dirInput.value.trim()));
  dirInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveDir());
  const renderDir = () => {
    const { dir, custom, by, at } = store.projectsDir;
    const admin = store.me.admin;
    const sep = dir.includes('\\') ? '\\' : '/';
    if (document.activeElement !== dirInput) dirInput.value = dir;
    const def = custom && admin ? row({ title: 'Use the default folder', tone: 'accent', onClick: () => ctx.net.send({ t: 'floor.projectsDir', dir: '' }) }) : null;
    dirSection.replaceChildren(
      section(
        'Projects folder',
        [admin ? h('div.a-set-row.a-set-row--field.has-lead', {}, h('span.a-set-row__lead', {}, tile('folder', 'honey')), dirInput, dirSave) : row({ lead: tile('folder', 'honey'), title: h('span.a-set-mono', {}, dir) }), def],
        `New spaces from GitHub are copied into ${dir}${sep}<owner>${sep}<project> on the office’s computer.${custom && by && at ? ` Set by ${by} ${timeAgo(at)}.` : ''}${admin ? ' Spaces you already have stay where they are.' : ' An admin can move it.'}`,
      ),
    );
  };

  renderShow();
  renderAdd();
  renderDir();
  env.on('floors', () => (renderShow(), renderAdd()));
  env.on('me', () => (renderAdd(), renderDir()));
  env.on('projectsDir', renderDir);

  return pageFrame(env, 'Spaces', 'Each space is one project: its own teammates, notes, tasks and meetings.', [showSection, addSection, dirSection]);
}

/** The elevator's "add a project", as a sheet: search the repositories gh can see, add one. */
function openAddSpace(env: PageEnv) {
  const { ctx } = env;
  const store = ctx.store;
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  const SHOWN = 60;

  const search = h('input.a-set-input', { type: 'search', placeholder: 'Search, or type owner/name…', 'aria-label': 'Search your GitHub projects', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' }) as HTMLInputElement;
  const listEl = h('div.a-set-group.a-set-repos', { role: 'listbox', 'aria-label': 'Your GitHub projects' });
  const note = h('p.a-set-foot');
  const add = button({ label: 'Pick a project', variant: 'primary', size: 'lg', block: true, disabled: true }) as HTMLButtonElement;
  const refresh = iconButton('retry', 'Ask GitHub again', () => {
    store.repos = { ...store.repos, loading: true, error: undefined };
    ctx.net.send({ t: 'floor.repos', refresh: true });
    render();
  });
  const body = h(
    'div.a-set-sheet',
    {},
    h('p.a-set-intro', {}, 'The office copies the project onto its computer, and it becomes a space of its own.'),
    h('div.a-set-search', {}, glyph('search', 18), search, refresh),
    listEl,
    note,
  );
  const s = sheet({
    title: 'Add a space',
    content: [body],
    footer: add,
    className: 'a-set-sheet-dialog a-set-sheet-dialog--tall',
    onClose: () => {
      replyListeners.delete(onReply);
      offs.forEach((o) => o());
    },
  });

  const choice = () => selected ?? normalizeRepo(filter);
  const repoRow = (r: RepoChoice) => {
    const floor = store.floors.find((f) => sameRepo(f.repo, r.name));
    const on = !!selected && sameRepo(selected, r.name);
    const [owner, name] = r.name.split('/');
    const b = h(
      'button.a-set-row.a-set-repo',
      { type: 'button', role: 'option', 'aria-selected': String(on), disabled: !!floor || !!adding },
      h(
        'span.a-set-row__text',
        {},
        h('span.a-set-row__title', {}, name ?? r.name, r.private ? h('span.a-set-repo__lock', { title: 'Private' }, glyph('lock', 13)) : null),
        h('span.a-set-row__sub', {}, r.description || owner || ''),
      ),
      h('span.a-set-row__value', {}, floor ? 'Already a space' : r.pushedAt ? timeAgo(Date.parse(r.pushedAt)) : ''),
      h('span.a-set-repo__tick', { 'aria-hidden': 'true' }, icon('check', 16)),
    );
    b.addEventListener('click', () => {
      if (floor || adding) return;
      selected = on ? null : r.name;
      render();
    });
    return b;
  };

  const render = () => {
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const typed = normalizeRepo(filter);
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    if (typed && !r.list.some((x) => sameRepo(x.name, typed))) rows.push(repoRow({ name: typed, private: false, description: 'Not in your list: the office will try to copy it anyway' }));
    rows.push(...matches.slice(0, SHOWN).map(repoRow));
    if (!rows.length) rows.push(h('div.a-set-row', {}, h('span.a-set-row__sub', {}, r.loading ? 'Asking GitHub for your projects…' : r.error ? 'GitHub didn’t answer.' : q ? 'Nothing matches. Type owner/name to add any project.' : 'No projects.')));
    if (matches.length > SHOWN) rows.push(h('div.a-set-row', {}, h('span.a-set-row__sub', {}, `…and ${matches.length - SHOWN} more. Type to narrow it down.`)));
    listEl.replaceChildren(...rows);
    listEl.setAttribute('aria-busy', String(r.loading));
    const pick = choice();
    const dir = store.projectsDir.dir;
    const sep = dir.includes('\\') ? '\\' : '/';
    const into = (rest: string) => `${dir}${sep}${rest.replace(/\//g, sep)}`;
    note.replaceChildren(
      adding ? `Copying ${adding} into ${into(adding)}… A big project can take a minute.` : pick ? `It goes into ${into(pick)}.` : `Projects go into ${into('<owner>/<project>')}.`,
      ...[r.error, error].filter(Boolean).map((e) => h('span.a-set-alert', { role: 'alert' }, icon('warning', 14), e!)),
    );
    const exists = !!pick && store.floors.some((f) => sameRepo(f.repo, pick));
    add.disabled = !!adding || !pick || exists;
    setBusy(add, !!adding);
    (add.querySelector('.a-btn__label') as HTMLElement).textContent = adding ? 'Setting it up…' : pick ? `Add ${pick.split('/')[1] ?? pick}` : 'Pick a project';
    search.disabled = !!adding;
  };

  search.addEventListener('input', () => {
    filter = search.value;
    if (selected && !sameRepo(selected, normalizeRepo(filter))) selected = null;
    render();
  });
  add.addEventListener('click', () => {
    const pick = choice();
    if (!pick || adding) return;
    adding = pick;
    error = '';
    render();
    ctx.net.send({ t: 'floor.add', repo: pick });
  });
  const onReply = (msg: ServerMsg) => {
    if (msg.t !== 'floor.added' || !adding || msg.repo !== adding) return;
    const repo = adding;
    adding = null;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'It couldn’t be added. Try again in a moment.';
      render();
      return;
    }
    buzz();
    s.close();
    toast(`${repo.split('/')[1] ?? repo} is a space now`);
    ctx.go({ view: 'space', floor: msg.floor });
  };
  replyListeners.add(onReply);
  env.cleanup(() => s.close());
  const offs = [store.on('repos', render), store.on('floors', render), store.on('projectsDir', render)];

  // Ask gh for the list (again, if it's more than a few minutes old).
  const r = store.repos;
  if (!r.loading && (!r.at || Date.now() - r.at > 5 * 60_000 || r.error)) {
    store.repos = { ...r, loading: true };
    ctx.net.send({ t: 'floor.repos' });
  }
  render();
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => search.focus(), 60);
}

// ---- Updates ------------------------------------------------------------------------------------

function updatesPage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  const current = h('div');
  const state = h('div');
  const changes = h('div');
  const actions = h('div.a-set-cta');

  const render = () => {
    const u = store.upgrade;
    const busy = u.phase === 'building' || u.phase === 'restarting';
    current.replaceChildren(
      u.current
        ? h(
            'div.a-set-version',
            {},
            h('span.a-set-version__kicker', {}, 'Running now'),
            h('span.a-set-version__subject', {}, u.current.subject),
            h('span.a-set-version__meta', {}, h('code.a-set-mono', {}, u.current.sha), ` · ${new Date(u.current.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`),
          )
        : h('span'),
    );

    let status: HTMLElement;
    if (!u.available) status = row({ lead: tile('info', 'stone'), title: 'Updated on its own computer', sub: 'This office wasn’t installed to update itself, so new versions go on where it runs.' });
    else if (u.phase === 'building') status = row({ lead: h('span.a-spinner', { 'aria-hidden': 'true' }), title: 'Updating…', sub: `Building ${u.latest?.sha ?? 'the new version'}${u.by ? `, started by ${u.by}` : ''}. Everyone keeps working until it restarts, usually in a minute or two.` });
    else if (u.phase === 'restarting') status = row({ lead: h('span.a-spinner', { 'aria-hidden': 'true' }), title: 'Restarting…', sub: 'You’ll be back in a few seconds. No need to do anything.' });
    else if (u.checking) status = row({ lead: h('span.a-spinner', { 'aria-hidden': 'true' }), title: 'Checking for updates…' });
    else if (u.phase === 'failed' && u.error) status = h('div.a-set-row.a-set-row--stack', {}, h('span.a-set-row__text', {}, h('span.a-set-row__title.is-danger', {}, 'The last update didn’t work'), h('pre.a-set-pre', {}, u.error)));
    else if (u.error) status = row({ lead: tile('warning', 'rose'), title: 'Couldn’t check', sub: u.error });
    else if (u.latest) status = row({ lead: tile('update', 'ember'), title: 'A new version is ready', sub: `${u.latest.subject} · ${u.latest.sha}` });
    else status = row({ lead: tile('check', 'sage'), title: 'Up to date', sub: u.checkedAt ? `Checked ${timeAgo(u.checkedAt)}` : undefined });
    state.replaceChildren(section(null, [status]));

    if (u.latest && u.changes?.length) {
      const n = u.behind ?? u.changes.length;
      const more = n - u.changes.length;
      changes.replaceChildren(
        section(
          `What’s new · ${n >= 50 ? '50+' : n}`,
          u.changes.map((c) => h('div.a-set-row.a-set-change', {}, h('span.a-set-row__text', {}, h('span.a-set-row__title.a-set-change__subject', {}, c.subject), h('span.a-set-row__sub', {}, h('code.a-set-mono', {}, c.sha))))),
          more > 0 ? `…and ${n >= 50 ? 'more' : `${more} more`}.` : null,
        ),
      );
    } else changes.replaceChildren();

    actions.replaceChildren();
    if (u.available) {
      if (u.latest && !busy) actions.append(button({ label: 'Update now', icon: 'download', variant: 'primary', size: 'lg', block: true, disabled: !!u.checking, onClick: () => void confirmUpdate() }));
      actions.append(button({ label: 'Check again', icon: 'retry', variant: u.latest ? 'ghost' : 'secondary', block: true, disabled: !!u.checking || busy, onClick: () => ctx.net.send({ t: 'upgrade.check' }) }));
    }
  };

  const confirmUpdate = async () => {
    const awake = [...store.workers.values()].filter((w) => !isAsleep(w.status));
    const working = awake.filter((w) => w.status === 'working' || w.status === 'needs_input');
    const ok = await confirmDialog({
      title: 'Update the office now?',
      body:
        'It builds the new version while everyone keeps working, then restarts. Teammates who are awake wake back up by themselves.' +
        (working.length ? ` ${working.map((w) => w.name).join(', ')} ${working.length === 1 ? 'is' : 'are'} in the middle of something that will be interrupted.` : ''),
      action: 'Update now',
    });
    if (ok) {
      buzz();
      ctx.net.send({ t: 'upgrade.start' });
    }
  };

  render();
  env.on('upgrade', render);
  if (store.upgrade.available) ctx.net.send({ t: 'upgrade.check' });

  return pageFrame(env, 'Updates', null, [current, state, changes, actions]);
}

// ---- About --------------------------------------------------------------------------------------

function aboutPage(env: PageEnv): HTMLElement {
  const { ctx } = env;
  const store = ctx.store;
  const u = store.upgrade;
  const onTailnet = /\.ts\.net$/i.test(location.hostname);
  // The office's Tailscale address (the server finds it), unless you're already on it or it has none.
  const phoneUrl = `${onTailnet || !store.share ? location.origin : store.share}/app`;
  const noTailnet = !onTailnet && !store.share;
  const to3d = !edition.has3d ? null : row({
    lead: tile('cube', 'ember'),
    title: 'Open the 3D office',
    sub: 'The whole team in 3D, for a big screen',
    href: '/',
    trail: icon('external', 18),
    chevron: false,
  });
  to3d?.addEventListener('click', () => {
    // On a phone the office page sends people back here unless they chose the 3D office.
    try {
      localStorage.setItem('agent-office.3d', '1');
    } catch {
      // storage blocked
    }
  });
  // Where this edition's code lives, for an edition that has a public home.
  const source = edition.repo
    ? row({ lead: tile('external', 'graphite'), title: `${edition.name} on GitHub`, sub: `${edition.repo}, built on AgentSystemLabs/agent-office`, href: `https://github.com/${edition.repo}`, trail: icon('external', 18), chevron: false })
    : null;
  source?.setAttribute('target', '_blank');
  source?.setAttribute('rel', 'noopener noreferrer');
  const hero = h(
    'div.a-set-about',
    {},
    h('span.a-set-about__mark', {}, APP_NAME, h('span.a-set-about__dot', { 'aria-hidden': 'true' })),
    h('span.a-set-about__line', {}, 'The whole office, ', h('em', {}, 'quietly'), '.'),
  );
  return pageFrame(
    env,
    'About',
    null,
    [
      section(null, [
        row({ lead: tile('info', 'stone'), title: 'Version', value: h('span.a-set-mono', {}, u.current?.sha ?? '—'), sub: u.current ? new Date(u.current.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null }),
        to3d,
        source,
        row({ lead: tile('list', 'aqua'), title: 'Simple phone list', sub: 'Everyone on one page, nothing extra', href: '/phone', trail: icon('external', 18), chevron: false }),
      ]),
      section(
        'On your phone',
        [
          h(
            'div.a-set-row.a-set-row--stack.has-lead',
            {},
            h('span.a-set-row__lead', {}, tile('phone', 'sage')),
            h('span.a-set-row__text', {}, h('span.a-set-row__title', {}, 'Open this address'), h('code.a-set-url', {}, phoneUrl)),
          ),
          row({ lead: tile('copy', 'graphite'), title: 'Copy the address', onClick: () => void copyWithToast(phoneUrl, 'Address copied') }),
        ],
        noTailnet
          ? 'Tailscale isn’t running on the office’s computer, so this address may only work there. Install Tailscale on it and on your phone, sign both in, and the address here becomes one your phone can open from anywhere.'
          : 'It works anywhere your phone is signed in to Tailscale. To keep it on your home screen, open it in Safari, tap Share, then Add to Home Screen.',
      ),
    ],
    hero,
  );
}

const PAGE_BUILDERS: Record<Exclude<Page, ''>, PageFn> = {
  you: youPage,
  usage: usagePage,
  people: peoplePage,
  notifications: notificationsPage,
  spaces: spacesPage,
  updates: updatesPage,
  about: aboutPage,
};
