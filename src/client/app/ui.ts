// The app's shared pieces (docs/app/DESIGN.md §5, §7): status in words, avatars with their rings,
// chips, buttons, sheets and dialogs, menus, toasts, empty states, skeletons, time in words, the
// theme, the per-device hidden spaces, and the building-wide team list (GET /api/team).
// Every screen builds on these so the app reads as one thing. Class names are exactly DESIGN.md's.

import { h } from '../ui/dom';
import { store } from '../state';
import { icon, type IconName } from './icons';
import { DEPARTMENT_ICON, DEPARTMENTS, TEAM_BY_ID, type Department } from '../../shared/team';
import { FLOOR_PALETTES } from '../../shared/floors';
import type { TeamEntry, TeamResponse } from '../../shared/app-api';
import type { FloorInfo, WorkerInfo, WorkerStatus } from '../../shared/protocol';

export { h };
export type { TeamEntry };

// =================================================================================================
// Status → words (§5)
// =================================================================================================

/** A teammate as either list gives it: the live WorkerInfo of the space on screen, or /api/team's TeamEntry. */
export type Who = Pick<WorkerInfo, 'id' | 'name' | 'color' | 'status' | 'acked'> &
  Partial<Pick<WorkerInfo, 'role' | 'waitingSince' | 'activity' | 'title' | 'parked' | 'task' | 'prompt' | 'kind'>> & {
    emoji?: string;
    lastMessageAt?: number;
  };

/** The five states the app shows. */
export type UiStatus = 'needs' | 'done' | 'working' | 'ready' | 'resting';

export function uiStatus(w: { status: WorkerStatus; acked: boolean }): UiStatus {
  switch (w.status) {
    case 'needs_input':
      return 'needs';
    case 'done':
      return w.acked ? 'ready' : 'done';
    case 'starting':
    case 'working':
      return 'working';
    case 'exited':
    case 'offline':
      return 'resting';
    default:
      return 'ready';
  }
}

export const STATUS_WORDS: Record<UiStatus, string> = {
  needs: 'Needs you',
  done: 'Finished',
  working: 'Working on it',
  ready: 'Ready',
  resting: 'Resting',
};

/** The chip's label: "Needs you", "Working on it", … ("Getting settled…" while a teammate starts up). */
export function statusWords(w: { status: WorkerStatus; acked: boolean }): string {
  if (w.status === 'starting') return 'Getting settled…';
  return STATUS_WORDS[uiStatus(w)];
}

/** Waiting on her: a question, or something finished she hasn't looked at. */
export function needsHer(w: { status: WorkerStatus; acked: boolean }): boolean {
  const s = uiStatus(w);
  return s === 'needs' || s === 'done';
}

export const isResting = (w: { status: WorkerStatus }) => w.status === 'exited' || w.status === 'offline';

const RANK: Record<UiStatus, number> = { needs: 0, done: 1, working: 2, ready: 3, resting: 4 };

/** Sort order everywhere: Needs you → Finished → Working → Ready → Resting; oldest wait / newest activity first. */
export function byStatus(a: Who, b: Who): number {
  const r = RANK[uiStatus(a)] - RANK[uiStatus(b)];
  if (r) return r;
  const s = uiStatus(a);
  if (s === 'needs' || s === 'done') return (a.waitingSince ?? 0) - (b.waitingSince ?? 0);
  return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.name.localeCompare(b.name);
}

const TECHNICAL = /\\|\w\/\w|\(\)|\.(?:ts|js|json|md|py|ps1|sh)\b|\bnpm\b|\bnpx\b|\bgit\b|\bpwsh\b|\bbash\b|[{}<>`]|\b[A-Z][a-z]+[A-Z]\w*\(/;

function firstSentence(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(one);
  const t = m ? m[1] : one;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The generic line for a status, when there's nothing human to say. */
export function genericLine(w: { status: WorkerStatus; acked: boolean }): string {
  switch (uiStatus(w)) {
    case 'needs':
      return 'Waiting for your answer';
    case 'done':
      return 'All done — take a look';
    case 'working':
      return w.status === 'starting' ? 'Getting settled…' : 'Working on it';
    case 'resting':
      return 'Resting';
    default:
      return 'Ready when you are';
  }
}

/**
 * What they're doing, in a line (≤ 80 chars): what they're asking when they need her, else what
 * they're on. Never tool names or paths: anything that looks technical gives the status's own line.
 */
export function doingLine(w: Who): string {
  const s = uiStatus(w);
  const candidates = s === 'needs' ? [w.activity, w.task?.summary, w.prompt] : [w.task?.summary, w.activity, w.title, w.prompt];
  if (s === 'resting' || s === 'ready') {
    // Only a finished task is worth saying for someone at rest.
    const t = w.task?.summary;
    if (t && !TECHNICAL.test(t)) return firstSentence(t);
    return s === 'resting' ? 'Resting' : roleTitle(w) ?? 'Ready when you are';
  }
  for (const c of candidates) if (c && c.trim() && !TECHNICAL.test(c)) return firstSentence(c);
  return genericLine(w);
}

/** Their roster emoji, when they have one. */
export function emojiOf(w: { emoji?: string; role?: string }): string | undefined {
  return w.emoji ?? (w.role ? TEAM_BY_ID.get(w.role)?.emoji : undefined);
}

/** What they do ("Meal planning"), when it says more than their name. */
export function roleTitle(w: { name: string; role?: string }): string | undefined {
  const m = w.role ? TEAM_BY_ID.get(w.role) : undefined;
  return m && m.title !== w.name ? m.title : undefined;
}

// =================================================================================================
// Avatars (§7.4), status chips (§7.5), badges (§7.6)
// =================================================================================================

export type AvatarSize = 24 | 32 | 40 | 48 | 72;

export interface AvatarOpts {
  emoji?: string;
  /** For the letter when there's no emoji. */
  name?: string;
  color?: string;
  status?: UiStatus;
  size?: AvatarSize;
}

/**
 * A round emoji avatar on the teammate's tint, with its status ring. Pass a teammate (WorkerInfo or
 * TeamEntry) or plain options. Decorative: the row around it says the name and status.
 */
export function avatar(who: Who | AvatarOpts, size?: AvatarSize): HTMLElement {
  const isWho = 'acked' in who && 'id' in who;
  const o: AvatarOpts = isWho
    ? { emoji: emojiOf(who as Who), name: (who as Who).name, color: (who as Who).color, status: uiStatus(who as Who), size }
    : { ...(who as AvatarOpts), size: size ?? (who as AvatarOpts).size };
  const px = o.size ?? 48;
  const el = h('span.a-avatar', {
    'aria-hidden': 'true',
    'data-size': px,
    'data-status': o.status ?? 'ready',
    style: o.color ? `--a-who:${o.color}` : undefined,
  });
  if (o.emoji) el.append(h('span.a-avatar__emoji', {}, o.emoji));
  else el.append(h('span.a-avatar__letter', {}, (o.name ?? '?').trim().charAt(0).toUpperCase() || '?'));
  return el;
}

/** Changes an avatar's ring in place; a teammate who just started needing her gets one soft pulse. */
export function setAvatarStatus(el: HTMLElement, status: UiStatus) {
  const was = el.dataset.status;
  if (was === status) return;
  el.dataset.status = status;
  if (status === 'needs' && was) {
    el.classList.remove('is-pulse');
    void el.offsetWidth;
    el.classList.add('is-pulse');
    el.addEventListener('animationend', () => el.classList.remove('is-pulse'), { once: true });
  }
}

/** Up to `max` overlapping 24 px avatars. */
export function avatarStack(list: Who[], max = 4): HTMLElement {
  return h('span.a-avatar-stack', { 'aria-hidden': 'true' }, ...list.slice(0, max).map((w) => avatar(w, 24)));
}

/** The status chip: a dot and the words, colored per §5. */
export function statusChip(w: { status: WorkerStatus; acked: boolean } | UiStatus, label?: string): HTMLElement {
  const s = typeof w === 'string' ? w : uiStatus(w);
  const text = label ?? (typeof w === 'string' ? STATUS_WORDS[w] : statusWords(w));
  return h('span.a-status', { 'data-status': s }, h('span.a-status__dot', { 'aria-hidden': 'true' }), text);
}

/** A clay count badge ("9+" past nine), or a dot when `n` is omitted. */
export function badge(n?: number): HTMLElement {
  if (n === undefined) return h('span.a-badge.a-badge--dot', { 'aria-hidden': 'true' });
  return h('span.a-badge.a-num', { 'aria-hidden': 'true' }, n > 9 ? '9+' : String(n));
}

// =================================================================================================
// Buttons (§7.1)
// =================================================================================================

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet';

export interface ButtonOpts {
  label: string;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  onClick?: (e: MouseEvent) => void;
  /** Render an <a href> instead of a <button>. */
  href?: string;
  type?: 'button' | 'submit';
  block?: boolean;
  disabled?: boolean;
  attrs?: Record<string, string | undefined>;
}

export function button(o: ButtonOpts): HTMLButtonElement | HTMLAnchorElement {
  const cls = `a-btn a-btn--${o.variant ?? 'secondary'} a-btn--${o.size ?? 'md'}${o.block ? ' a-btn--block' : ''}`;
  const kids = [o.icon ? icon(o.icon, o.size === 'sm' ? 18 : 20) : null, h('span.a-btn__label', {}, o.label)];
  const el = o.href ? h('a', { class: cls, href: o.href }, ...kids) : h('button', { class: cls, type: o.type ?? 'button' }, ...kids);
  for (const [k, v] of Object.entries(o.attrs ?? {})) if (v !== undefined) el.setAttribute(k, v);
  if (o.disabled) {
    if (el instanceof HTMLButtonElement) el.disabled = true;
    else el.setAttribute('aria-disabled', 'true');
  }
  if (o.onClick) {
    el.addEventListener('click', (e) => {
      if (el.getAttribute('aria-busy') === 'true' || el.getAttribute('aria-disabled') === 'true') return e.preventDefault();
      o.onClick!(e as MouseEvent);
    });
  }
  return el;
}

/** Keeps the label, adds a spinner, and ignores clicks until it's done. */
export function setBusy(btn: HTMLElement, busy: boolean) {
  btn.setAttribute('aria-busy', String(busy));
  const spin = btn.querySelector(':scope > .a-spinner');
  if (busy && !spin) btn.prepend(h('span.a-spinner', { 'aria-hidden': 'true' }));
  if (!busy) spin?.remove();
}

/** A 44 px round icon-only button; `label` is its accessible name (and tooltip). */
export function iconButton(name: IconName, label: string, onClick?: (e: MouseEvent) => void, size = 22): HTMLButtonElement {
  const b = h('button.a-icon-btn', { type: 'button', 'aria-label': label, title: label }, icon(name, size));
  if (onClick) b.addEventListener('click', (e) => onClick(e as MouseEvent));
  return b;
}

// =================================================================================================
// Segmented control (§7.7): tabs (Team · Notes · Reports) or a radio group (Light · Dark · Auto).
// =================================================================================================

export interface SegItem {
  value: string;
  label: string;
  icon?: IconName;
  /** The panel it controls (tabs only), for aria-controls. */
  controls?: string;
}

export interface SegmentedControl extends HTMLElement {
  /** Moves the selection (and the pill) without calling onChange. */
  select(value: string): void;
}

export function segmented(o: { items: SegItem[]; value: string; label: string; role?: 'tablist' | 'radiogroup'; onChange: (value: string) => void }): SegmentedControl {
  const role = o.role ?? 'tablist';
  const itemRole = role === 'tablist' ? 'tab' : 'radio';
  const state = role === 'tablist' ? 'aria-selected' : 'aria-checked';
  const pill = h('span.a-seg__pill', { 'aria-hidden': 'true' });
  const items = o.items.map((it) =>
    h('button.a-seg__item', { type: 'button', role: itemRole, 'data-value': it.value, 'aria-controls': it.controls }, it.icon ? icon(it.icon, 18) : null, h('span', {}, it.label)),
  );
  const el = h('div.a-seg', { role, 'aria-label': o.label, style: `--a-seg-n:${items.length}` }, pill, ...items) as unknown as SegmentedControl;
  el.select = (value: string) => {
    const i = Math.max(
      0,
      o.items.findIndex((it) => it.value === value),
    );
    items.forEach((b, j) => {
      b.setAttribute(state, String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    el.style.setProperty('--a-seg-i', String(i));
  };
  el.select(o.value);
  const choose = (i: number, focus = false) => {
    const v = o.items[i].value;
    el.select(v);
    if (focus) items[i].focus();
    o.onChange(v);
  };
  items.forEach((b, i) => b.addEventListener('click', () => b.getAttribute(state) !== 'true' && choose(i)));
  el.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = items.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(next, true);
  });
  return el;
}

// =================================================================================================
// Empty states (§7.16) and skeletons (§7.17)
// =================================================================================================

export interface EmptyOpts {
  emoji?: string;
  icon?: IconName;
  title: string;
  text?: string;
  action?: ButtonOpts;
}

export function emptyState(o: EmptyOpts): HTMLElement {
  return h(
    'div.a-empty',
    {},
    o.emoji ? h('span.a-empty__art', { 'aria-hidden': 'true' }, o.emoji) : o.icon ? h('span.a-empty__art', { 'aria-hidden': 'true' }, icon(o.icon, 32)) : null,
    h('h2.a-empty__title', {}, o.title),
    o.text ? h('p.a-empty__text', {}, o.text) : null,
    o.action ? h('div.a-empty__action', {}, button(o.action)) : null,
  );
}

/** One skeleton shape. `kind`: 'line' (text bar, `width` like '60%'), 'circle' (avatar, `size` px) or 'block' (`height` px). */
export function skeleton(kind: 'line' | 'circle' | 'block' = 'line', o: { width?: string; size?: number; height?: number } = {}): HTMLElement {
  const style =
    kind === 'circle' ? `width:${o.size ?? 48}px;height:${o.size ?? 48}px` : kind === 'block' ? `height:${o.height ?? 96}px;${o.width ? `width:${o.width}` : ''}` : `width:${o.width ?? '60%'}`;
  return h('span.a-skeleton', { class: `a-skeleton--${kind}`, style, 'aria-hidden': 'true' });
}

/** A group of `n` skeleton rows shaped like teammate rows (avatar + two lines). */
export function skeletonRows(n = 3): HTMLElement {
  return h(
    'div.a-group.a-group--skeleton',
    { 'aria-busy': 'true', 'aria-label': 'Loading' },
    ...Array.from({ length: n }, () =>
      h('div.a-row.a-row--skeleton', {}, skeleton('circle', { size: 48 }), h('span.a-row__text', {}, skeleton('line', { width: '60%' }), skeleton('line', { width: '40%' }))),
    ),
  );
}

/**
 * Shows `skeletonEl` in `root` only if the data takes longer than 300 ms (no flash). Call the returned
 * function once the data is in: it removes the skeleton if it went up.
 */
export function lateSkeleton(root: HTMLElement, skeletonEl: HTMLElement, delay = 300): () => void {
  const t = setTimeout(() => root.append(skeletonEl), delay);
  return () => {
    clearTimeout(t);
    skeletonEl.remove();
  };
}

// =================================================================================================
// Toasts (§7.14): one at a time, bottom center, above the tab bar or composer.
// =================================================================================================

let toastHost: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, level: 'info' | 'warn' | 'error' = 'info', action?: { label: string; onClick: () => void }) {
  if (!toastHost) {
    toastHost = h('div.a-toasts');
    document.body.append(toastHost);
  }
  const host = toastHost;
  host.setAttribute('role', level === 'error' ? 'alert' : 'status');
  host.setAttribute('aria-live', level === 'error' ? 'assertive' : 'polite');
  clearTimeout(toastTimer);
  const el = h(
    'div.a-toast',
    { 'data-level': level },
    level === 'warn' ? icon('warning', 20) : level === 'error' ? icon('warning', 20) : null,
    h('span.a-toast__text', {}, text),
  );
  if (action) {
    el.append(
      h(
        'button.a-toast__action',
        {
          type: 'button',
          onclick: () => {
            action.onClick();
            dismiss();
          },
        },
        action.label,
      ),
    );
  }
  host.replaceChildren(el);
  const ms = action ? 6000 : 4000;
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  };
  let left = ms;
  let started = Date.now();
  const arm = () => {
    started = Date.now();
    toastTimer = setTimeout(dismiss, left);
  };
  const pause = () => {
    clearTimeout(toastTimer);
    left = Math.max(1200, left - (Date.now() - started));
  };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', arm);
  arm();
}

// =================================================================================================
// Sheets and dialogs (§7.13): native <dialog> + showModal() for the focus trap, Esc and inert page.
// =================================================================================================

export interface SheetOpts {
  /** The sheet's title (title-2) with a close button beside it. Leave out to build your own head in `root`. */
  title?: string;
  /** Accessible name when there's no title (or before yours renders). */
  label?: string;
  /** Put into the scrolling body (when `title` is given). */
  content?: (Node | null)[];
  /** Sticky footer (the primary action), when `title` is given. */
  footer?: Node | null;
  /** 'sheet' = bottom sheet on phones, centered dialog on wide screens. 'dialog' = centered always (confirms). */
  kind?: 'sheet' | 'dialog';
  /** Called once, after it has closed (Esc, scrim, close button, swipe, or close()). */
  onClose?: () => void;
  className?: string;
}

export interface SheetHandle {
  dialog: HTMLDialogElement;
  /**
   * Where the content goes. `display: contents` inside the panel, so children with the classes
   * a-sheet__head / a-sheet__body / a-sheet__foot lay out as the sheet's own head, scrolling body and
   * sticky footer.
   */
  root: HTMLElement;
  close(): void;
}

let sheetSeq = 0;

export function sheet(o: SheetOpts = {}): SheetHandle {
  const opener = document.activeElement as HTMLElement | null;
  const kind = o.kind ?? 'sheet';
  const root = h('div.a-sheet__root');
  const panel = h('div.a-sheet__panel', {}, kind === 'sheet' ? h('div.a-sheet__grabber', { 'aria-hidden': 'true' }) : null, root);
  const dialog = h('dialog', { class: `${kind === 'sheet' ? 'a-sheet' : 'a-dialog'}${o.className ? ` ${o.className}` : ''}` }, panel) as HTMLDialogElement;
  if (o.label) dialog.setAttribute('aria-label', o.label);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.classList.add('is-closing');
    const done = () => {
      dialog.close();
      dialog.remove();
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      o.onClose?.();
    };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(done, reduce ? 0 : 200);
  };
  if (o.title) {
    const id = `a-sheet-title-${++sheetSeq}`;
    dialog.setAttribute('aria-labelledby', id);
    dialog.removeAttribute('aria-label');
    root.append(
      h('header.a-sheet__head', {}, h('h2.a-sheet__title', { id }, o.title), iconButton('close', 'Close', close)),
      h('div.a-sheet__body', {}, ...(o.content ?? []).filter((n): n is Node => !!n)),
    );
    if (o.footer) root.append(h('footer.a-sheet__foot', {}, o.footer));
  }
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  // A click on the scrim lands on the <dialog> itself (the panel fills everything else).
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  if (kind === 'sheet') swipeToClose(panel, close);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, root, close };
}

/** Drag the grabber or the head down to dismiss (the close button is always there too). */
function swipeToClose(panel: HTMLElement, close: () => void) {
  let y0 = 0;
  let dy = 0;
  let dragging = false;
  panel.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (e.pointerType === 'mouse' || !t.closest('.a-sheet__grabber, .a-sheet__head') || t.closest('button')) return;
    dragging = true;
    y0 = e.clientY;
    dy = 0;
    panel.setPointerCapture(e.pointerId);
  });
  panel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (dy > 90) close();
    else panel.style.transform = '';
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

export interface ConfirmOpts {
  title: string;
  body?: string;
  /** The action's label, e.g. "Remove". */
  action: string;
  danger?: boolean;
  cancel?: string;
}

/** A small centered dialog; resolves true when she confirms. Focus starts on Cancel for destructive ones. */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const act = button({
      label: o.action,
      variant: o.danger ? 'danger' : 'primary',
      onClick: () => {
        answer = true;
        haptic(o.danger ? 'warn' : 'success');
        s.close();
      },
    });
    const cancel = button({ label: o.cancel ?? 'Cancel', variant: 'secondary', onClick: () => s.close() });
    const s = sheet({ kind: 'dialog', label: o.title, onClose: () => resolve(answer) });
    const id = `a-dialog-title-${++sheetSeq}`;
    s.dialog.setAttribute('aria-labelledby', id);
    s.dialog.removeAttribute('aria-label');
    s.root.append(
      h('div.a-dialog__body', {}, h('h2.a-dialog__title', { id }, o.title), o.body ? h('p.a-dialog__text', {}, o.body) : null),
      h('div.a-dialog__actions', {}, cancel, act),
    );
    (o.danger ? cancel : act).focus();
  });
}

// =================================================================================================
// Menus: an action sheet on phones, a popover anchored to its button on wide screens (§7.13).
// =================================================================================================

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  /** Draws a divider above this item. */
  divider?: boolean;
  onSelect: () => void;
}

const wide = () => matchMedia('(min-width: 700px)').matches;

export function openMenu(anchor: HTMLElement, items: MenuItem[], label = 'More'): void {
  if (!items.length) return;
  if (wide()) return popover(anchor, items, label);
  const s = sheet({ label });
  const rows = items.map((it) =>
    h(
      'button.a-menu__item',
      {
        type: 'button',
        class: `${it.danger ? 'is-danger' : ''} ${it.divider ? 'has-divider' : ''}`,
        onclick: () => {
          s.close();
          it.onSelect();
        },
      },
      it.icon ? icon(it.icon, 22) : null,
      h('span', {}, it.label),
    ),
  );
  s.root.append(
    h('div.a-sheet__body.a-action-sheet', {}, h('div.a-group', { role: 'menu', 'aria-label': label }, ...rows)),
    h('footer.a-sheet__foot', {}, button({ label: 'Cancel', variant: 'secondary', size: 'lg', block: true, onClick: () => s.close() })),
  );
  rows.forEach((r) => r.setAttribute('role', 'menuitem'));
  rows[0]?.focus();
}

function popover(anchor: HTMLElement, items: MenuItem[], label: string) {
  document.querySelector('.a-menu')?.remove();
  const menu = h('div.a-menu', { role: 'menu', 'aria-label': label });
  const close = (refocus = true) => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus();
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close(false);
  };
  const onResize = () => close(false);
  const rows = items.map((it) =>
    h(
      'button.a-menu__item',
      {
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        class: `${it.danger ? 'is-danger' : ''} ${it.divider ? 'has-divider' : ''}`,
        onclick: () => {
          close();
          it.onSelect();
        },
      },
      it.icon ? icon(it.icon, 20) : null,
      h('span', {}, it.label),
    ),
  );
  menu.append(...rows);
  menu.addEventListener('keydown', (e) => {
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[(i + 1) % rows.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows[(i - 1 + rows.length) % rows.length].focus();
    } else if (e.key === 'Tab') close(false);
  });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 6 + menu.offsetHeight < window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = below ? `${r.bottom + 6}px` : `${Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
  menu.style.transformOrigin = `${r.right - left}px ${below ? 0 : menu.offsetHeight}px`;
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', onResize);
  rows[0].focus();
}

// =================================================================================================
// App v2 primitives: haptics, pill tabs, glass cards, rich action sheets, meters, and the large
// title that collapses into a glass header. New exports only; nothing above changed shape.
// =================================================================================================

/**
 * A short buzz on key confirmations (Android; iOS Safari has no vibration API and ignores it).
 * 'tap' for a selection, 'success' for something done, 'warn' for a refusal.
 */
export function haptic(kind: 'tap' | 'success' | 'warn' = 'tap') {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate?.(kind === 'success' ? [8, 40, 12] : kind === 'warn' ? [20, 60, 20] : 8);
  } catch {
    // not allowed here (no user gesture, or an iframe): stay quiet
  }
}

/**
 * A scrollable row of capsules: the phone's answer to a segmented control with more than 3–4
 * choices (a space's Team · Meetings · Tasks · Notes · Reports · GitHub). Same options and the same
 * `select()` as segmented(), so a screen can swap one for the other. Items may carry a count badge.
 */
export function pillTabs(o: {
  items: (SegItem & { count?: number })[];
  value: string;
  label: string;
  role?: 'tablist' | 'radiogroup';
  onChange: (value: string) => void;
}): SegmentedControl {
  const role = o.role ?? 'tablist';
  const itemRole = role === 'tablist' ? 'tab' : 'radio';
  const state = role === 'tablist' ? 'aria-selected' : 'aria-checked';
  const items = o.items.map((it) =>
    h(
      'button.a-pill',
      { type: 'button', role: itemRole, 'data-value': it.value, 'aria-controls': it.controls },
      it.icon ? icon(it.icon, 16) : null,
      h('span', {}, it.label),
      it.count ? badge(it.count) : null,
    ),
  );
  const el = h('div.a-pills', { role, 'aria-label': o.label }, ...items) as unknown as SegmentedControl;
  const reveal = (b: HTMLElement, smooth: boolean) => {
    // Keep the chosen pill in view without moving the page itself.
    const l = b.offsetLeft - el.clientWidth / 2 + b.offsetWidth / 2;
    if (el.scrollWidth > el.clientWidth) el.scrollTo({ left: Math.max(0, l), behavior: smooth ? 'smooth' : 'auto' });
  };
  el.select = (value: string) => {
    const i = Math.max(
      0,
      o.items.findIndex((it) => it.value === value),
    );
    items.forEach((b, j) => {
      b.setAttribute(state, String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    requestAnimationFrame(() => reveal(items[i], true));
  };
  el.select(o.value);
  requestAnimationFrame(() => reveal(items[Math.max(0, o.items.findIndex((it) => it.value === o.value))], false));
  const choose = (i: number, focus = false) => {
    const v = o.items[i].value;
    el.select(v);
    if (focus) items[i].focus();
    haptic();
    o.onChange(v);
  };
  items.forEach((b, i) => b.addEventListener('click', () => b.getAttribute(state) !== 'true' && choose(i)));
  el.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = items.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(next, true);
  });
  return el;
}

/**
 * A card. `glass` makes it translucent frosted glass over the aura; `href` makes the whole card a
 * link (with the press and hover states). Children go inside as given.
 */
export function glassCard(children: (Node | string | null)[], o: { glass?: boolean; href?: string; className?: string; style?: string; label?: string } = {}): HTMLElement {
  const cls = `a-card${o.glass !== false ? ' a-card--glass' : ''}${o.className ? ` ${o.className}` : ''}`;
  const attrs = { class: cls, style: o.style, 'aria-label': o.label };
  const kids = children.filter((c): c is Node | string => c !== null);
  return o.href ? h('a', { ...attrs, href: o.href }, ...kids) : h('div', attrs, ...kids);
}

export interface ActionItem {
  label: string;
  /** One line under the label saying what it does. */
  hint?: string;
  icon: IconName;
  /** The tile's color: 'accent' (ember) for the main thing, else a status hue, or neutral. */
  tone?: 'accent' | 'working' | 'done' | 'honey' | 'neutral';
  href?: string;
  onSelect?: () => void;
}

/**
 * A glass action sheet with big, described choices (the tab bar's Create). On wide screens it's the
 * same centered dialog every sheet becomes. Resolves when it closes; each choice closes it first.
 */
export function actionSheet(o: { title: string; sub?: string; actions: ActionItem[]; back?: { label: string; onClick: () => void } }): SheetHandle {
  const s = sheet({ label: o.title, className: 'a-sheet--actions' });
  const id = `a-actions-title-${++sheetSeq}`;
  s.dialog.setAttribute('aria-labelledby', id);
  s.dialog.removeAttribute('aria-label');
  const rows = actionRows(o.actions, () => s.close());
  s.root.append(
    h(
      'header.a-sheet__head',
      {},
      o.back ? iconButton('back', o.back.label, () => o.back!.onClick()) : null,
      h('h2.a-sheet__title', { id }, o.title),
      iconButton('close', 'Close', () => s.close()),
    ),
    h('div.a-sheet__body', {}, o.sub ? h('p.a-callout.a-actions__sub', {}, o.sub) : null, h('div.a-actions', {}, ...rows)),
  );
  (rows[0] as HTMLElement | undefined)?.focus({ preventScroll: true });
  return s;
}

/** The described choices of an action sheet (.a-action), for building or redrawing one in place. Each calls `close` first. */
export function actionRows(actions: ActionItem[], close: () => void): HTMLElement[] {
  return actions.map((a) => {
    const kids = [
      h('span.a-action__tile', { 'aria-hidden': 'true' }, icon(a.icon, 22)),
      h('span.a-action__text', {}, h('span.a-action__label', {}, a.label), a.hint ? h('span.a-action__hint', {}, a.hint) : null),
      h('span.a-action__chev', { 'aria-hidden': 'true' }, icon('forward', 18)),
    ];
    const pick = (e: Event) => {
      haptic();
      if (!a.href) e.preventDefault();
      close();
      a.onSelect?.();
    };
    return a.href
      ? h('a.a-action', { href: a.href, 'data-tone': a.tone ?? 'neutral', onclick: pick }, ...kids)
      : h('button.a-action', { type: 'button', 'data-tone': a.tone ?? 'neutral', onclick: pick }, ...kids);
  });
}

/** A thin capsule meter, 0–100. `level` colors it: 'near' honey, 'over' ember. */
export function meter(pct: number, label: string, level?: 'near' | 'over'): HTMLElement {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return h(
    'div.a-meter',
    { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(v), 'data-level': level, style: `--a-meter:${v}` },
    h('span.a-meter__fill'),
  );
}

/**
 * The iOS large title: `header` (an .a-header) turns to frosted glass, and its small title fades in,
 * once `title` (the big title in the content) has scrolled up under it. Returns a stop function.
 */
export function collapseHeader(header: HTMLElement, title: HTMLElement): () => void {
  const io = new IntersectionObserver(([e]) => header.classList.toggle('is-scrolled', !e.isIntersecting), { rootMargin: `-${56}px 0px 0px 0px` });
  io.observe(title);
  return () => io.disconnect();
}

// =================================================================================================
// Time in words (§9): "just now", "5 min ago", "2:14 PM", "Yesterday", "Mon", "Sep 22".
// =================================================================================================

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "4:10 PM" */
export function clockTime(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Whole days between `t`'s day and today (0 = today). */
function daysAgo(t: number): number {
  return Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
}

/** "Sep 22" (with the year when it isn't this year). */
export function shortDate(t: number): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "just now", "5 min ago", "2:14 PM" (today), "Yesterday", "Mon" (this week), "Sep 22". */
export function timeAgo(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const days = daysAgo(t);
  if (days <= 0) return clockTime(t);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
  return shortDate(t);
}

/** The compact form for list rows: "now", "5 min", "2:14 PM", "Yesterday", "Mon", "Sep 22". */
export function timeShort(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return timeAgo(t);
}

/** Day separators: "Today", "Yesterday", "Monday", "Sep 22". */
export function dayLabel(t: number): string {
  const days = daysAgo(t);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
  return shortDate(t);
}

/** "1.2 MB" with a non-breaking space. */
export function fileSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** "1 teammate" / "3 teammates". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// =================================================================================================
// Storage: theme, hidden spaces, drafts
// =================================================================================================

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}

export type ThemePref = 'auto' | 'light' | 'dark';
const THEME_KEY = 'hearth.theme';

export function themePref(): ThemePref {
  const v = readLocal(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** Applies a theme choice: <html data-theme>, <meta name="theme-color">, and remembers it on this device. */
export function applyTheme(pref: ThemePref = themePref(), save = false) {
  if (save) writeLocal(THEME_KEY, pref);
  document.documentElement.dataset.theme = pref;
  const head = document.head;
  head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  if (pref === 'auto') {
    head.append(h('meta', { name: 'theme-color', content: '#F4F2EE', media: '(prefers-color-scheme: light)' }));
    head.append(h('meta', { name: 'theme-color', content: '#0A0A0C', media: '(prefers-color-scheme: dark)' }));
  } else {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--a-theme-color').trim() || (pref === 'dark' ? '#0A0A0C' : '#F4F2EE');
    head.append(h('meta', { name: 'theme-color', content: c }));
  }
}

const HIDDEN_KEY = 'hearth.hiddenSpaces';
/** Fired on window when the hidden spaces change (Settings dispatches it too). */
export const SPACES_EVENT = 'app:spaces';

/** Spaces she turned off in Settings, on this device. */
export function hiddenSpaces(): Set<string> {
  try {
    const v = JSON.parse(readLocal(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setHiddenSpaces(ids: Iterable<string>) {
  writeLocal(HIDDEN_KEY, JSON.stringify([...ids]));
  window.dispatchEvent(new Event(SPACES_EVENT));
  store.emit('floors');
}

/** The spaces to show: every floor that isn't being set up or hidden on this device. */
export function visibleSpaces(): FloorInfo[] {
  const hidden = hiddenSpaces();
  return store.floors.filter((f) => !f.cloning && !hidden.has(f.id));
}

const draftKey = (workerId: string) => `hearth.draft.${workerId}`;

/** What she was typing to a teammate (kept per tab, survives reloads and navigation). */
export function loadDraft(workerId: string): string {
  try {
    return sessionStorage.getItem(draftKey(workerId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(workerId: string, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(workerId), text);
    else sessionStorage.removeItem(draftKey(workerId));
  } catch {
    // storage blocked
  }
}

// =================================================================================================
// Spaces: their emoji and tint
// =================================================================================================

const DEPT_BY_NAME = new Map<string, Department>(DEPARTMENTS.map((d) => [d.toLowerCase(), d]));

/** Words in a space's name, and the department (if the roster has one like it) whose icon it gets. */
const NAME_HINTS = (
  [
    [/trading/i, /trading/i],
    [/home/i, /home/i],
    [/financ|money|budget/i, /personal fin|money|budget/i],
  ] as const
)
  .map(([space, dept]) => [space, DEPARTMENTS.find((d) => dept.test(d))] as const)
  .filter((x): x is readonly [RegExp, Department] => !!x[1]);

/** The space's emoji: its department's icon, from its name or else from who works there. */
export function spaceEmoji(floor: { id: string; name: string } | string): string {
  const f = typeof floor === 'string' ? (store.floors.find((x) => x.id === floor) ?? { id: floor, name: floor }) : floor;
  const byName = DEPT_BY_NAME.get(f.name.toLowerCase()) ?? DEPARTMENTS.find((d) => f.name.toLowerCase().includes(d.toLowerCase()));
  if (byName) return DEPARTMENT_ICON[byName];
  // A space named for what it's about, like "Market Watch" or "Money Matters": the department
  // that sounds like it, whatever the roster calls it.
  const alike = NAME_HINTS.find(([space]) => space.test(f.name))?.[1];
  if (alike) return DEPARTMENT_ICON[alike];
  // Most common department among its teammates.
  const people = teamOn(f.id);
  const count = new Map<Department, number>();
  for (const w of people) {
    const g = w.role ? TEAM_BY_ID.get(w.role)?.group : undefined;
    if (g) count.set(g, (count.get(g) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? DEPARTMENT_ICON[top[0]] : '🏢';
}

/** The space's color, for tinting its tile (--a-space). */
export function spaceColor(floorId: string): string {
  const f = store.floors.find((x) => x.id === floorId);
  return FLOOR_PALETTES[(f?.palette ?? 0) % FLOOR_PALETTES.length].trim;
}

/**
 * A space's name in two parts: the office names floors like "Growth Floor · Ads, Social, SEO", which
 * wraps badly as a title. The part before " · " is the name; the rest is a quiet subtitle.
 */
export function splitSpaceName(name: string): { title: string; sub?: string } {
  const i = name.indexOf(' · ');
  if (i <= 0) return { title: name.trim() };
  const sub = name.slice(i + 3).trim();
  return { title: name.slice(0, i).trim(), sub: sub || undefined };
}

/** A space's full name as the office has it. */
function fullSpaceName(floorId: string): string {
  return store.floors.find((f) => f.id === floorId)?.name ?? teamData?.floors.find((f) => f.id === floorId)?.name ?? 'Space';
}

/** A space's name, for headers, captions and sentences ("Growth Floor"). */
export function spaceName(floorId: string): string {
  return splitSpaceName(fullSpaceName(floorId)).title;
}

/** What a space is about, when its name says ("Ads, Social, SEO"). */
export function spaceSubtitle(floorId: string): string | undefined {
  return splitSpaceName(fullSpaceName(floorId)).sub;
}

// =================================================================================================
// Everyone in the building: GET /api/team, polled while a screen listens, merged with the live
// workers of the space the socket is on (fresher). Falls back to that space alone if the route is
// missing (an office that hasn't been restarted since the app arrived).
// =================================================================================================

export type TeamFloor = TeamResponse['floors'][number];

let teamData: TeamResponse | null = null;
let teamLoaded = false;
let teamInflight: Promise<void> | null = null;
let teamTimer: ReturnType<typeof setInterval> | undefined;
let pokeTimer: ReturnType<typeof setTimeout> | undefined;
const teamSubs = new Set<() => void>();
const TEAM_POLL_MS = 5000;

const asEntry = (w: WorkerInfo): TeamEntry => ({
  id: w.id,
  name: w.name,
  role: w.role,
  emoji: w.role ? TEAM_BY_ID.get(w.role)?.emoji : undefined,
  color: w.color,
  status: w.status,
  acked: w.acked,
  waitingSince: w.waitingSince,
  activity: w.activity,
  title: w.title,
  parked: w.parked,
  meeting: w.meeting,
  kind: w.kind,
});

/** Every visible-or-not space with its teammates (agents only), live data merged in. Empty until loaded. */
export function teamFloors(): TeamFloor[] {
  const live = store.floor;
  const base: TeamFloor[] = teamData?.floors ?? [];
  const out: TeamFloor[] = base.map((f) => {
    if (f.id !== live) return f;
    // The socket's copy is fresher for the space it's on; keep lastMessageAt from the poll.
    const polled = new Map(f.workers.map((w) => [w.id, w]));
    return { ...f, workers: [...store.workers.values()].map((w) => ({ ...asEntry(w), lastMessageAt: polled.get(w.id)?.lastMessageAt })) };
  });
  if (live && !out.some((f) => f.id === live) && store.workers.size) {
    out.push({ id: live, name: fullSpaceName(live), workers: [...store.workers.values()].map(asEntry) });
  }
  return out.map((f) => ({ ...f, workers: f.workers.filter((w) => w.kind !== 'shell') }));
}

/** The teammates of one space. */
export function teamOn(floorId: string): TeamEntry[] {
  return teamFloors().find((f) => f.id === floorId)?.workers ?? [];
}

/** Whether the first answer (or failure) has come back. */
export function teamReady(): boolean {
  return teamLoaded;
}

export function refreshTeam(): Promise<void> {
  if (teamInflight) return teamInflight;
  teamInflight = (async () => {
    try {
      const res = await fetch('/api/team', { cache: 'no-store' });
      if (res.status === 401) {
        signInAgain();
        return;
      }
      if (res.ok) teamData = (await res.json()) as TeamResponse;
    } catch {
      // offline: keep what we had
    } finally {
      teamLoaded = true;
      teamInflight = null;
      teamSubs.forEach((fn) => fn());
    }
  })();
  return teamInflight;
}

/** Refresh soon (a worker changed somewhere); several pokes in a row make one request. */
export function pokeTeam() {
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => void refreshTeam(), 400);
  // The live space changed: listeners can redraw from the socket's copy right away.
  teamSubs.forEach((fn) => fn());
}

/** Listen to the team list; polls every few seconds while anyone listens. */
export function onTeam(fn: () => void): () => void {
  teamSubs.add(fn);
  if (!teamTimer) {
    teamTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshTeam();
    }, TEAM_POLL_MS);
    void refreshTeam();
  }
  return () => {
    teamSubs.delete(fn);
    if (!teamSubs.size && teamTimer) {
      clearInterval(teamTimer);
      teamTimer = undefined;
    }
  };
}

// =================================================================================================
// Who's signed in
// =================================================================================================

let myName: string | null = null;

/** The sign-in page, coming back to this very screen of the app afterwards. */
export function signInAgain() {
  location.href = '/login?next=' + encodeURIComponent('/app' + location.hash);
}

/** Her first name: the account's, else the saved profile's, else nothing. */
export function firstName(): string {
  const n = myName ?? store.me.account?.name ?? profileName() ?? '';
  return n.replace(/\s*📱\s*$/u, '').trim().split(/\s+/)[0] ?? '';
}

export function setMyName(name: string | null) {
  myName = name;
}

function profileName(): string | null {
  try {
    const p = JSON.parse(readLocal('agent-office.profile') ?? 'null');
    return typeof p?.name === 'string' ? p.name : null;
  } catch {
    return null;
  }
}

// =================================================================================================
// "Behind the scenes": the office's raw terminal for a teammate (permission prompts are answered
// there). Loaded on first use: it brings xterm and the 3D office's terminal colors with it.
// =================================================================================================

type TerminalModule = typeof import('../ui/terminal');
let terminalModule: TerminalModule | null = null;

/** The shell feeds every socket message through here, for an open terminal to pick up its own. */
export function routeToTerminal(msg: import('../../shared/protocol').ServerMsg) {
  terminalModule?.routeTerminalMessage(msg);
}

/** Opens a teammate's "Behind the scenes" view. Their space must be the one the socket is on. */
export async function openBehindTheScenes(net: import('../net').Net, workerId: string): Promise<void> {
  if (!terminalModule) {
    try {
      const [mod] = await Promise.all([import('../ui/terminal'), import('@xterm/xterm/css/xterm.css')]);
      terminalModule = mod;
    } catch {
      toast("Couldn't open that right now. Try again in a moment.", 'error');
      return;
    }
  }
  terminalModule.openTerminal(net, workerId);
}

// =================================================================================================
// Back: the browser's own history when she came from inside the app, else up to `fallback`.
// =================================================================================================

let inAppSteps = 0;

/** The shell says how many in-app steps are behind the current screen (a reload or a deep link starts at 0). */
export function setInAppSteps(n: number) {
  inAppSteps = Math.max(0, n);
}

export function goBack(go: (r: import('./context').Route) => void, fallback: import('./context').Route) {
  if (inAppSteps > 0) history.back();
  else go(fallback);
}

/** A header back button: chevron + the previous screen's name. */
export function backButton(label: string, go: (r: import('./context').Route) => void, fallback: import('./context').Route): HTMLElement {
  return h('a.a-back', {
    href: hrefOf(fallback),
    'aria-label': `Back to ${label}`,
    onclick: (e: Event) => {
      const me = e as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.button !== 0) return;
      e.preventDefault();
      goBack(go, fallback);
    },
  }, icon('back', 24), h('span', {}, label));
}

/** Where a route lives, as a hash: the one place URLs are spelled (main.ts parses them back). */
export function hrefOf(r: import('./context').Route): string {
  const f = 'floor' in r ? encodeURIComponent(r.floor) : '';
  switch (r.view) {
    case 'home':
      return '#/home';
    case 'chats':
      return '#/chats';
    case 'settings':
      return '#/settings';
    case 'space':
      return `#/space/${f}`;
    case 'memory':
      return `#/space/${f}/notes`;
    case 'reports':
      return `#/space/${f}/reports`;
    case 'hire':
      return `#/space/${f}/add`;
    case 'meeting':
      return `#/space/${f}/group`;
    case 'chat':
      return `#/chat/${f}/${encodeURIComponent(r.worker)}`;
    case 'meetings':
      return `#/space/${f}/meetings`;
    case 'tasks':
      return `#/space/${f}/tasks`;
    case 'github':
      return `#/space/${f}/github`;
    case 'office':
      return `#/space/${f}/office`;
    case 'terminal':
      return `#/term/${f}/${encodeURIComponent(r.worker)}`;
    case 'changes':
      return `#/changes/${f}/${encodeURIComponent(r.worker)}`;
  }
}
