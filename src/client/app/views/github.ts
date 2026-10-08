// The GitHub segment (only on a space whose project is on GitHub): the 3D office's three boards by
// the north wall, made for a phone. Pull requests as cards (checks, review, who opened it) that open
// into a sheet with the description, the conversation, a diff that reads on a small screen, a comment
// box, merge (the office rings its gong for it, and so do we) and close. Issues, each one a tap from
// the task queue. And the services board: the web servers teammates are running, with links.
//
// Same sources as the 3D office (ui/pull.ts, ui/pulldiff.ts, ui/services.ts, world/boards.ts): the
// boards are store.pulls / store.issues / store.services, a PR's detail and diff come from
// GET /api/gh/pull(/diff), and everything that changes GitHub is a gh.* message answered by the server.

import type { AppContext, View } from '../context';
import type { GhCheck, GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhMergeMethod, GhPull, GhPullDetail, GhReviewComment, ServerMsg, ServiceInfo } from '../../../shared/protocol';
import { workerForPull } from '../../state';
import { markdown } from '../../ui/markdown';
import { parseDiff, type DiffFile, type DiffLine } from '../../ui/pulldiff';
import { icon } from '../icons';
import {
  avatar,
  button,
  emptyState,
  h,
  hrefOf,
  iconButton,
  openMenu,
  plural,
  segmented,
  setBusy,
  sheet,
  skeleton,
  timeAgo,
  toast,
  type MenuItem,
  type SheetHandle,
} from '../ui';
import { rememberedChoice } from '../../ui/provider';
import { branchGlyph, choiceLabel, choicePicker, glyph, haptic, prGlyph, type TaskChoice } from './tasks';
import { edition } from '../../../shared/edition';

// =================================================================================================
// Talking to the office
// =================================================================================================

type Answer<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;
const mergeWaiters = new Map<number, (m: Answer<'gh.merged'>) => void>();
const commentWaiters = new Map<string, (m: Answer<'gh.commented'>) => void>();
const closeWaiters = new Map<string, (m: Answer<'gh.closed'>) => void>();
let hooked = false;

/** One listener for the whole app (Net has no way to take one off): it hands answers to whoever waits. */
function hook(ctx: AppContext) {
  if (hooked) return;
  hooked = true;
  ctx.net.onMessage((msg) => {
    if (msg.t === 'gh.merged') mergeWaiters.get(msg.number)?.(msg);
    else if (msg.t === 'gh.commented') commentWaiters.get(`${msg.kind}#${msg.number}`)?.(msg);
    else if (msg.t === 'gh.closed') closeWaiters.get(`${msg.kind}:${msg.number}`)?.(msg);
    else if (msg.t === 'gong' && msg.why === 'merged' && document.querySelector('.a-of-gh')) celebrate(msg.pr, msg.by);
  });
}

async function getJson<T>(url: string, floor: string): Promise<T> {
  const r = await fetch(`${url}&floor=${encodeURIComponent(floor)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) throw new Error('signed out');
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function getText(url: string, floor: string): Promise<string> {
  const r = await fetch(`${url}&floor=${encodeURIComponent(floor)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.text();
}

/** The task a teammate gets for an issue: word for word what the 3D office gives (ui/boards.ts issuePrompt). */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title'>): string {
  return `Work on GitHub issue #${it.number}: "${it.title}".\n\nRead it first with \`gh issue view ${it.number} --comments\`. Create a new branch, implement the change, verify it, then open a pull request that closes #${it.number}.`;
}

function readPref<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, v: unknown) {
  try {
    if (v === '' || v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage blocked
  }
}

/** The 3D office's keys, so a merge method or a half-written comment is the same in both. */
const MERGE_KEY = 'agent-office.merge';
const DRAFT_KEY = 'agent-office.comment:';

// =================================================================================================
// Small pieces
// =================================================================================================

const ghGlyph = (size = 18) =>
  glyph('<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>', size);
const issueGlyph = (size = 16) => glyph('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>', size);
const globeGlyph = (size = 18) => glyph('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>', size);
const commentGlyph = (size = 14) => glyph('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', size);
const mergeGlyph = (size = 18) => glyph('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>', size);

/** owner/repo from a remote or an item URL. */
function repoName(url: string | undefined): string {
  if (!url) return '';
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?(?:\/|$)/.exec(url);
  return m ? m[1] : url.replace(/^https?:\/\//, '');
}

/** "5 min", "3 hr", "2 days": how long something has been going. */
function uptime(since: number): string {
  const m = Math.max(0, (Date.now() - since) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.floor(m)} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} hr`;
  return plural(Math.floor(m / 1440), 'day');
}

const isoAgo = (iso: string) => (iso ? timeAgo(Date.parse(iso)) : '');

/** A GitHub person: a letter on a color from their name (no GitHub images: they'd leak the phone's address). */
function ghAvatar(login: string, size: 24 | 32 | 40 = 24): HTMLElement {
  let x = 0;
  for (const ch of login) x = (x * 31 + ch.charCodeAt(0)) | 0;
  const hues = ['#C65D3B', '#3E7CB1', '#4F8A5B', '#8A5BA8', '#B08A2E', '#2E8C8C', '#A8475A', '#5B6DA8'];
  return avatar({ name: login, color: hues[Math.abs(x) % hues.length], size }, size);
}

/** A GitHub label: its own color as a dot, the name in our ink. */
function labelChip(l: { name: string; color: string }): HTMLElement {
  const c = /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : 'currentColor';
  return h('span.a-of-label', { style: `--a-of-label:${c}` }, h('span.a-of-label__dot', { 'aria-hidden': 'true' }), l.name);
}

type Tone = 'ok' | 'bad' | 'warn' | 'busy' | 'muted' | 'accent';

function chip(text: string, tone: Tone, glyphEl?: Element | null): HTMLElement {
  return h('span.a-of-chip', { 'data-tone': tone }, glyphEl ?? null, text);
}

function checksChip(checks: GhPull['checks']): HTMLElement | null {
  if (checks === 'pass') return chip('Checks passed', 'ok', icon('check', 14));
  if (checks === 'fail') return chip('Checks failing', 'bad', icon('close', 14));
  if (checks === 'pending') return chip('Checks running', 'busy', h('span.a-of-chip__spin', { 'aria-hidden': 'true' }));
  return null;
}

function reviewChip(p: Pick<GhPull, 'reviewDecision' | 'isDraft' | 'state'>): HTMLElement | null {
  if (p.state !== 'OPEN') return null;
  if (p.isDraft) return chip('Draft', 'muted');
  if (p.reviewDecision === 'APPROVED') return chip('Approved', 'ok');
  if (p.reviewDecision === 'CHANGES_REQUESTED') return chip('Changes requested', 'warn');
  if (p.reviewDecision === 'REVIEW_REQUIRED') return chip('Needs a review', 'muted');
  return null;
}

function stateChip(it: { state: string; isDraft?: boolean }, kind: 'pull' | 'issue'): HTMLElement {
  if (it.state === 'MERGED') return chip('Merged', 'ok', mergeGlyph(14));
  if (it.state === 'CLOSED') return chip('Closed', 'muted', kind === 'pull' ? prGlyph(14) : issueGlyph(14));
  if (it.isDraft) return chip('Draft', 'muted', prGlyph(14));
  return chip('Open', 'accent', kind === 'pull' ? prGlyph(14) : issueGlyph(14));
}

/** +12 −3, and a little bar of the two. */
function sizeBar(add: number, del: number): HTMLElement {
  const total = Math.max(1, add + del);
  const blocks = 5;
  const green = Math.round((add / total) * blocks);
  return h(
    'span.a-of-size',
    { 'aria-label': `${add} lines added, ${del} removed` },
    h('span.a-of-size__add.a-num', {}, `+${add}`),
    h('span.a-of-size__del.a-num', {}, `−${del}`),
    h('span.a-of-size__bar', { 'aria-hidden': 'true' }, ...Array.from({ length: blocks }, (_, i) => h('i', { 'data-k': i < green ? 'add' : 'del' }))),
  );
}

function md(src: string, itemUrl: string): HTMLElement {
  const box = h('div.a-prose.a-of-md');
  box.append(src.trim() ? markdown(src, itemUrl) : h('p.a-of-quiet', {}, 'No description.'));
  return box;
}

function loadingBlock(lines = 3): HTMLElement {
  return h('div.a-of-loading', { 'aria-busy': 'true', 'aria-label': 'Loading' }, ...Array.from({ length: lines }, (_, i) => skeleton('line', { width: `${[88, 72, 54, 80][i % 4]}%` })));
}

function errorBlock(text: string, retry?: () => void): HTMLElement {
  return h(
    'div.a-of-error',
    { role: 'alert' },
    icon('warning', 18),
    h('span', {}, `Couldn't load that from GitHub. ${/signed out/.test(text) ? 'Sign in again and try once more.' : 'Try again in a moment.'}`),
    retry ? button({ label: 'Try again', size: 'sm', variant: 'ghost', onClick: retry }) : null,
  );
}

// =================================================================================================
// The merge gong: the office rings it for a merge, and the phone shows it
// =================================================================================================

const rung = new Map<number, number>();

export function celebrate(pr?: number, by?: string) {
  if (pr !== undefined) {
    const at = rung.get(pr) ?? 0;
    if (Date.now() - at < 15_000) return;
    rung.set(pr, Date.now());
  }
  document.querySelector('.a-of-gong')?.remove();
  const colors = ['var(--a-of-accent)', 'var(--a-moss)', 'var(--a-lake)', 'var(--a-honey)'];
  const bits = Array.from({ length: 28 }, (_, i) =>
    h('i.a-of-gong__bit', { style: `--x:${(i * 37) % 100}%;--d:${(i % 7) * 60}ms;--r:${(i * 53) % 360}deg;--c:${colors[i % colors.length]};--s:${0.7 + ((i * 13) % 6) / 10}` }),
  );
  const el = h(
    'div.a-of-gong',
    { role: 'status', 'aria-live': 'polite' },
    h('div.a-of-gong__confetti', { 'aria-hidden': 'true' }, ...bits),
    h(
      'div.a-of-gong__card',
      {},
      h('div.a-of-gong__disc', { 'aria-hidden': 'true' }, h('span.a-of-gong__ring'), h('span.a-of-gong__ring.is-2'), h('span.a-of-gong__face', {}, mergeGlyph(30))),
      h('p.a-of-gong__title', {}, 'Merged'),
      h('p.a-of-gong__sub', {}, pr !== undefined ? `Pull request #${pr}${by ? `, by ${by.replace(/\s*📱\s*$/u, '')}` : ''}. The gong is ringing in the office.` : 'The gong is ringing in the office.'),
    ),
  );
  document.body.append(el);
  try {
    navigator.vibrate?.([12, 60, 12]);
  } catch {
    // no buzz here
  }
  el.addEventListener('click', () => el.remove());
  setTimeout(() => el.classList.add('is-leaving'), 2600);
  setTimeout(() => el.remove(), 3100);
}

// =================================================================================================
// A diff that reads on a phone: files fold, lines wrap, nothing scrolls sideways
// =================================================================================================

const STATUS_NAME: Record<DiffFile['status'], string> = { A: 'Added', D: 'Deleted', M: 'Changed', R: 'Renamed' };

function diffLines(f: DiffFile, comments: GhReviewComment[], itemUrl: string): HTMLElement {
  const box = h('div.a-of-diff__lines', { role: 'table', 'aria-label': `Changes in ${f.path}` });
  const threads = comments.filter((c) => c.path === f.path && !c.replyTo && c.line != null);
  const replies = comments.filter((c) => c.replyTo);
  for (const l of f.lines) {
    box.append(lineRow(l));
    if (l.kind === 'hunk') continue;
    for (const c of threads) {
      const hit = c.side === 'LEFT' ? l.kind !== 'add' && l.old === c.line : l.kind !== 'del' && l.new === c.line;
      if (!hit) continue;
      box.append(
        h(
          'div.a-of-diff__thread',
          {},
          ...[c, ...replies.filter((r) => r.replyTo === c.id)].map((x) =>
            h('div.a-of-diff__comment', {}, h('div.a-of-diff__who', {}, ghAvatar(x.author, 24), h('b', {}, x.author), h('span', {}, isoAgo(x.createdAt))), md(x.body, itemUrl)),
          ),
        ),
      );
    }
  }
  return box;
}

function lineRow(l: DiffLine): HTMLElement {
  if (l.kind === 'hunk') {
    const m = /^@@[^@]*@@\s?(.*)$/.exec(l.text);
    return h('div.a-of-diff__hunk', { role: 'row' }, m?.[1] ? m[1] : '···');
  }
  if (l.kind === 'note') return h('div.a-of-diff__note', { role: 'row' }, l.text.replace(/^\\\s*/, ''));
  const n = l.kind === 'del' ? l.old : l.new;
  const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  return h('div.a-of-diff__line', { role: 'row', 'data-k': l.kind }, h('span.a-of-diff__n', { role: 'cell' }, n != null ? String(n) : ''), h('span.a-of-diff__sign', { 'aria-hidden': 'true' }, sign), h('span.a-of-diff__code', { role: 'cell' }, l.text || ' '));
}

function diffView(files: DiffFile[], comments: GhReviewComment[], itemUrl: string): HTMLElement {
  if (!files.length) return h('p.a-of-quiet', {}, 'No files changed.');
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  let budget = 0;
  const cards = files.map((f, i) => {
    const slash = f.path.lastIndexOf('/');
    const n = comments.filter((c) => c.path === f.path && !c.replyTo).length;
    const big = f.lines.length > 400 || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.lock)$/.test(f.path);
    // The first few small files open by themselves; the rest wait for a tap, so a big PR stays quick.
    const openNow = !big && i < 4 && budget + f.lines.length < 600;
    if (openNow) budget += f.lines.length;
    const body = h('div.a-of-diff__body');
    const det = h(
      'details.a-of-diff__file',
      {},
      h(
        'summary.a-of-diff__head',
        {},
        h('span.a-of-diff__st', { 'data-st': f.status, title: STATUS_NAME[f.status] }, f.status),
        h('span.a-of-diff__path', { title: f.path }, h('b', {}, f.path.slice(slash + 1)), slash >= 0 ? h('span', {}, f.path.slice(0, slash)) : null),
        n ? h('span.a-of-diff__c', { 'aria-label': plural(n, 'comment') }, commentGlyph(12), String(n)) : null,
        f.binary ? h('span.a-of-diff__bin', {}, 'binary') : h('span.a-of-diff__pm.a-num', {}, h('span.is-add', {}, `+${f.additions}`), h('span.is-del', {}, `−${f.deletions}`)),
        icon('down', 16),
      ),
      body,
    ) as HTMLDetailsElement;
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      body.append(f.binary ? h('p.a-of-quiet', {}, 'A binary file: nothing to read here.') : diffLines(f, comments, itemUrl));
    };
    det.addEventListener('toggle', () => det.open && build());
    if (openNow) {
      det.open = true;
      build();
    }
    return det;
  });
  return h(
    'div.a-of-diff',
    {},
    h('p.a-of-diff__sum', {}, plural(files.length, 'file'), ' changed ', h('span.a-of-dot', {}, '·'), ' ', h('span.is-add.a-num', {}, `+${adds}`), ' ', h('span.is-del.a-num', {}, `−${dels}`)),
    ...cards,
  );
}

// =================================================================================================
// Conversation pieces
// =================================================================================================

const REVIEW_WORDS: Record<string, [string, Tone]> = {
  APPROVED: ['approved these changes', 'ok'],
  CHANGES_REQUESTED: ['asked for changes', 'warn'],
  COMMENTED: ['reviewed', 'muted'],
  DISMISSED: ['review dismissed', 'muted'],
};

function commentCard(c: GhComment, itemUrl: string, verb: string, tone?: Tone): HTMLElement {
  return h(
    'article.a-of-cmt',
    { 'data-tone': tone ?? '' },
    h('header.a-of-cmt__head', {}, ghAvatar(c.author, 24), h('b', {}, c.author), h('span', {}, verb), h('span.a-of-cmt__time', {}, isoAgo(c.createdAt))),
    c.body.trim() ? md(c.body, itemUrl) : null,
  );
}

function checksList(checks: GhCheck[]): HTMLElement {
  const order: GhCheck['state'][] = ['fail', 'pending', 'pass', 'skip'];
  const words: Record<GhCheck['state'], string> = { fail: 'Failed', pending: 'Running', pass: 'Passed', skip: 'Skipped' };
  return h(
    'ul.a-of-checks',
    {},
    ...[...checks]
      .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
      .map((c) =>
        h(
          'li.a-of-check',
          { 'data-state': c.state },
          h('span.a-of-check__dot', { 'aria-hidden': 'true' }, c.state === 'pass' ? icon('check', 12) : c.state === 'fail' ? icon('close', 12) : null),
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.name) : h('span', {}, c.name),
          h('span.a-of-check__state', {}, words[c.state]),
        ),
      ),
  );
}

interface MergeStatus {
  text: string;
  tone: Tone;
  can: boolean;
  auto: boolean;
}

const conflicted = (d: GhPullDetail) => d.state === 'OPEN' && !d.isDraft && (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY');

/** Whether it can merge, in a sentence (the 3D office's mergeStatus, in Hearth's words). */
function mergeStatus(d: GhPullDetail): MergeStatus {
  const failing = d.checks.filter((c) => c.state === 'fail').length;
  const pending = d.checks.filter((c) => c.state === 'pending').length;
  if (d.state === 'MERGED') return { text: 'Merged.', tone: 'ok', can: false, auto: false };
  if (d.state === 'CLOSED') return { text: 'Closed without merging.', tone: 'muted', can: false, auto: false };
  if (d.isDraft) return { text: 'Still a draft. Mark it ready for review on GitHub before merging.', tone: 'muted', can: false, auto: false };
  if (conflicted(d)) return { text: `It conflicts with ${d.baseRefName}. Someone needs to sort that out before it can merge.`, tone: 'bad', can: false, auto: false };
  if (d.mergeStateStatus === 'BEHIND') return { text: `It's behind ${d.baseRefName}, and this repo wants it up to date first.`, tone: 'warn', can: true, auto: true };
  if (d.mergeStateStatus === 'BLOCKED') {
    const why = d.reviewDecision === 'CHANGES_REQUESTED' ? 'changes were asked for' : d.reviewDecision === 'REVIEW_REQUIRED' ? 'it needs an approving review' : failing ? `${plural(failing, 'check')} failing` : pending ? 'required checks are still running' : 'a branch rule isn’t met yet';
    return { text: `Blocked: ${why}.`, tone: 'bad', can: true, auto: true };
  }
  if (failing) return { text: `${plural(failing, 'check')} failing. It can still be merged.`, tone: 'warn', can: true, auto: false };
  if (pending || d.mergeStateStatus === 'UNSTABLE') return { text: 'Checks are still running. Merge now, or once they pass.', tone: 'busy', can: true, auto: true };
  if (d.mergeStateStatus === 'UNKNOWN' || d.mergeable === 'UNKNOWN') return { text: 'GitHub is still working out whether this can merge.', tone: 'muted', can: true, auto: false };
  return { text: `Ready to merge: no conflicts with ${d.baseRefName}${d.checks.length ? ', and every check passed' : ''}.`, tone: 'ok', can: true, auto: false };
}

/**
 * The comment box at the end of a conversation. It posts through the office's gh, so as that GitHub
 * account; the draft is kept (under the 3D office's key) until it goes.
 */
function commentBox(ctx: AppContext, kind: 'issue' | 'pull', number: number, itemUrl: string, onPosted: (c: GhComment) => void): { el: HTMLElement; setViewer(v: string): void; dispose(): void } {
  const key = `${DRAFT_KEY}${itemUrl}`;
  const waitKey = `${kind}#${number}`;
  const id = `a-of-cmt-${kind}-${number}`;
  const ta = h('textarea.a-field__control.a-of-compose__text', { id, rows: 3, placeholder: 'Write a comment…', 'aria-label': 'Comment' }) as HTMLTextAreaElement;
  ta.value = readPref<string>(key, '');
  const who = h('span.a-of-compose__who', {}, "Posts to GitHub as the office's account");
  const post = button({ label: 'Comment', variant: 'primary', size: 'sm', icon: 'send' }) as HTMLButtonElement;
  const err = h('p.a-field__error', { hidden: true });
  let timer = 0;
  const sync = () => (post.disabled = !ta.value.trim() || post.getAttribute('aria-busy') === 'true');
  const settle = () => {
    commentWaiters.delete(waitKey);
    clearTimeout(timer);
    setBusy(post, false);
    ta.readOnly = false;
    sync();
  };
  ta.addEventListener('input', () => {
    writePref(key, ta.value || '');
    sync();
  });
  post.addEventListener('click', () => {
    const body = ta.value;
    if (!body.trim()) return;
    err.hidden = true;
    setBusy(post, true);
    ta.readOnly = true;
    commentWaiters.set(waitKey, (msg) => {
      settle();
      if (msg.comment) {
        ta.value = '';
        writePref(key, '');
        sync();
        haptic();
        onPosted(msg.comment);
      } else {
        err.textContent = "GitHub didn't take the comment. Try again in a moment.";
        err.hidden = false;
      }
    });
    // The office drops messages while it's offline, and then no answer ever comes.
    timer = window.setTimeout(() => {
      settle();
      err.textContent = "No answer from the office. Reload to see whether it went through before posting again.";
      err.hidden = false;
    }, 45_000);
    ctx.net.send({ t: 'gh.comment', kind, number, body });
  });
  sync();
  return {
    el: h('div.a-of-compose', {}, h('label.a-of-compose__label', { for: id }, 'Add a comment'), ta, err, h('div.a-of-compose__foot', {}, who, post)),
    setViewer: (v) => v && (who.textContent = `Posts to GitHub as @${v}`),
    dispose: settle,
  };
}

/** A sheet's head: its title (with "#12" before it) and a close button. */
function sheetHead(s: SheetHandle, number: number, title: string, extra: HTMLElement): HTMLElement {
  const id = `a-of-gh-title-${number}-${Math.random().toString(36).slice(2, 7)}`;
  s.dialog.setAttribute('aria-labelledby', id);
  s.dialog.removeAttribute('aria-label');
  return h(
    'header.a-sheet__head.a-of-ghs__head',
    {},
    h('div.a-of-ghs__titles', {}, h('h2.a-sheet__title.a-of-ghs__title', { id }, h('span.a-of-ghs__num.a-num', {}, `#${number}`), ' ', title), extra),
    iconButton('close', 'Close', () => s.close()),
  );
}

// =================================================================================================
// Merge and close dialogs
// =================================================================================================

const METHOD_WORDS: Record<GhMergeMethod, string> = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' };

function openMerge(ctx: AppContext, it: GhPull, d: GhPullDetail, onMerged: () => void) {
  const st = mergeStatus(d);
  const methods = d.repo.methods.length ? d.repo.methods : (['squash', 'merge', 'rebase'] as GhMergeMethod[]);
  const saved = readPref<{ method?: GhMergeMethod; deleteBranch?: boolean }>(MERGE_KEY, {});
  let method: GhMergeMethod = saved.method && methods.includes(saved.method) ? saved.method : methods[0];
  const s = sheet({ kind: 'dialog', label: `Merge #${it.number}`, className: 'a-of-merge' });
  const del = h('input.a-switch', { type: 'checkbox', role: 'switch', id: `a-of-del-${it.number}` }) as HTMLInputElement;
  del.checked = saved.deleteBranch ?? true;
  const auto = h('input.a-switch', { type: 'checkbox', role: 'switch', id: `a-of-auto-${it.number}` }) as HTMLInputElement;
  auto.checked = st.auto && st.tone !== 'ok';
  const go = button({ label: 'Merge', variant: 'primary', icon: undefined }) as HTMLButtonElement;
  const label = go.querySelector('.a-btn__label')!;
  const paint = () => (label.textContent = auto.checked && st.auto ? 'Merge when ready' : `${METHOD_WORDS[method]} and merge`);
  const save = () => writePref(MERGE_KEY, { method, deleteBranch: del.checked });
  const methodPills = h(
    'div.a-of-pills',
    { role: 'radiogroup', 'aria-label': 'How to merge' },
    ...methods.map((m) => {
      const b = h('button.a-of-pill', { type: 'button', role: 'radio', 'aria-checked': String(m === method) }, METHOD_WORDS[m]);
      b.addEventListener('click', () => {
        method = m;
        methodPills.querySelectorAll('.a-of-pill').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        save();
        paint();
      });
      return b;
    }),
  );
  del.addEventListener('change', save);
  auto.addEventListener('change', paint);
  const result = h('p.a-field__error', { hidden: true, role: 'alert' });
  const cancel = button({ label: 'Cancel', onClick: () => s.close() });
  s.root.append(
    h(
      'div.a-dialog__body.a-of-merge__body',
      {},
      h('div.a-of-merge__icon', { 'aria-hidden': 'true' }, mergeGlyph(26)),
      h('h2.a-dialog__title', { id: `a-of-merge-t-${it.number}` }, `Merge #${it.number}?`),
      h('p.a-dialog__text', {}, it.title),
      h('div.a-of-status', { 'data-tone': st.tone }, h('span.a-of-status__dot', { 'aria-hidden': 'true' }), st.text),
      h('div.a-of-merge__opts', {}, methodPills,
        h('label.a-of-toggle', { for: del.id }, h('span', {}, 'Delete the branch afterwards', h('code.a-of-mono', {}, it.headRefName)), del),
        st.auto ? h('label.a-of-toggle', { for: auto.id }, h('span', {}, 'Merge by itself once everything passes'), auto) : null,
      ),
      result,
    ),
    h('div.a-dialog__actions', {}, cancel, go),
  );
  s.dialog.setAttribute('aria-labelledby', `a-of-merge-t-${it.number}`);
  s.dialog.removeAttribute('aria-label');
  paint();
  if (!st.can) go.disabled = true;
  go.addEventListener('click', () => {
    if (go.getAttribute('aria-busy') === 'true') return;
    setBusy(go, true);
    result.hidden = true;
    const asked = auto.checked && st.auto;
    mergeWaiters.set(it.number, (msg) => {
      mergeWaiters.delete(it.number);
      setBusy(go, false);
      if (msg.error) {
        result.textContent = `GitHub said no: ${msg.error}`;
        result.hidden = false;
        return;
      }
      s.close();
      if (asked) toast(`#${it.number} will merge once everything passes`);
      else celebrate(it.number);
      onMerged();
    });
    ctx.net.send({ t: 'gh.merge', number: it.number, method, deleteBranch: del.checked, auto: asked });
    haptic();
  });
  (st.can ? go : cancel).focus();
}

function openClose(ctx: AppContext, kind: 'issue' | 'pull', it: GhIssue | GhPull, onClosed: () => void) {
  const pull = kind === 'pull' ? (it as GhPull) : null;
  const key = `${kind}:${it.number}`;
  let reason: GhCloseReason = 'completed';
  const s = sheet({ kind: 'dialog', label: `Close #${it.number}` });
  const comment = h('textarea.a-field__control', { rows: 3, placeholder: 'Say why (optional)', 'aria-label': 'Closing comment' }) as HTMLTextAreaElement;
  const del = h('input.a-switch', { type: 'checkbox', role: 'switch', id: `a-of-cdel-${it.number}` }) as HTMLInputElement;
  const reasons = h(
    'div.a-of-pills',
    { role: 'radiogroup', 'aria-label': 'Why' },
    ...(['completed', 'not planned'] as GhCloseReason[]).map((r) => {
      const b = h('button.a-of-pill', { type: 'button', role: 'radio', 'aria-checked': String(r === reason) }, r === 'completed' ? 'It’s done' : 'Not planned');
      b.addEventListener('click', () => {
        reason = r;
        reasons.querySelectorAll('.a-of-pill').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      });
      return b;
    }),
  );
  const result = h('p.a-field__error', { hidden: true, role: 'alert' });
  const go = button({ label: pull ? 'Close pull request' : 'Close issue', variant: 'danger' }) as HTMLButtonElement;
  const cancel = button({ label: 'Cancel', onClick: () => s.close() });
  const tid = `a-of-close-t-${kind}-${it.number}`;
  s.root.append(
    h(
      'div.a-dialog__body.a-of-merge__body',
      {},
      h('h2.a-dialog__title', { id: tid }, `Close #${it.number}?`),
      h('p.a-dialog__text', {}, pull ? `“${it.title}” won't be merged. It can be reopened on GitHub later.` : `“${it.title}”`),
      h('div.a-of-merge__opts', {}, pull ? h('label.a-of-toggle', { for: del.id }, h('span', {}, 'Delete the branch too', h('code.a-of-mono', {}, pull.headRefName)), del) : reasons, comment),
      result,
    ),
    h('div.a-dialog__actions', {}, cancel, go),
  );
  s.dialog.setAttribute('aria-labelledby', tid);
  s.dialog.removeAttribute('aria-label');
  cancel.focus();
  go.addEventListener('click', () => {
    if (go.getAttribute('aria-busy') === 'true') return;
    setBusy(go, true);
    result.hidden = true;
    closeWaiters.set(key, (msg) => {
      closeWaiters.delete(key);
      setBusy(go, false);
      if (msg.error) {
        result.textContent = `GitHub said no: ${msg.error}`;
        result.hidden = false;
        return;
      }
      s.close();
      toast(`Closed #${it.number}`);
      onClosed();
    });
    ctx.net.send({ t: 'gh.close', kind, number: it.number, comment: comment.value.trim() || undefined, reason: pull ? undefined : reason, deleteBranch: !!pull && del.checked });
  });
}

// =================================================================================================
// The pull request sheet
// =================================================================================================

function openPull(ctx: AppContext, first: GhPull) {
  const floor = ctx.floor()!;
  let it = first;
  let detail: GhPullDetail | null = null;
  let detailErr = '';
  let files: DiffFile[] | null = null;
  let diffErr = '';
  let tab: 'talk' | 'files' = 'talk';

  const s = sheet({ label: `Pull request #${it.number}`, className: 'a-sheet--wide a-of-ghs', onClose: () => (unsub(), comment.dispose()) });
  const meta = h('div.a-of-ghs__meta');
  const tabs = segmented({
    label: 'Pull request',
    value: tab,
    items: [
      { value: 'talk', label: 'Conversation' },
      { value: 'files', label: 'Changes' },
    ],
    onChange: (v) => {
      tab = v as typeof tab;
      paintTabs();
    },
  });
  const tabBar = h('div.a-of-ghs__tabs', {}, tabs);
  const talk = h('div.a-of-ghs__pane');
  const thread = h('div.a-of-ghs__thread');
  const mergeBox = h('section.a-of-mergebox');
  const comment = commentBox(ctx, 'pull', it.number, it.url, (c) => {
    detail?.comments.push(c);
    paintTalk();
  });
  talk.append(thread, mergeBox, comment.el);
  const filesPane = h('div.a-of-ghs__pane', { hidden: true });
  const body = h('div.a-sheet__body.a-of-ghs__body', {}, meta, tabBar, talk, filesPane);
  const foot = h('footer.a-sheet__foot.a-of-ghs__foot');
  s.root.append(sheetHead(s, it.number, it.title, h('span')), body, foot);

  const paintTabs = () => {
    talk.hidden = tab !== 'talk';
    filesPane.hidden = tab !== 'files';
    body.scrollTop = 0;
  };

  const paintMeta = () => {
    const w = workerForPull(ctx.store.workers.values(), it);
    meta.replaceChildren(
      h('div.a-of-ghs__chips', {}, stateChip(it, 'pull'), reviewChip(it), checksChip(it.checks), ...it.labels.slice(0, 4).map(labelChip)),
      h(
        'p.a-of-ghs__by',
        {},
        ghAvatar(it.author, 24),
        h('b', {}, it.author),
        h('span', {}, it.state === 'MERGED' ? ' merged into ' : ' wants to merge into '),
        h('code.a-of-mono', {}, it.baseRefName),
        h('span', {}, ' from '),
        h('code.a-of-mono', { title: it.headRefName }, it.headRefName),
      ),
      h('div.a-of-ghs__stats', {}, sizeBar(it.additions, it.deletions), detail ? h('span', {}, plural(detail.commits, 'commit')) : null, h('span', {}, `Updated ${isoAgo(it.updatedAt)}`)),
      w ? h('a.a-of-ghs__who', { href: hrefOf({ view: 'chat', floor, worker: w.id }) }, avatar(w, 24), h('span', {}, `${w.name} made this`), icon('forward', 16)) : '',
    );
    const conflicts = !!detail && conflicted(detail);
    const st = detail ? mergeStatus(detail) : null;
    const isOpen = it.state === 'OPEN';
    const merge = button({
      label: 'Merge…',
      variant: 'primary',
      block: true,
      size: 'lg',
      disabled: !detail || !st?.can,
      onClick: () => detail && openMerge(ctx, it, detail, reload),
    });
    const more: MenuItem[] = [
      { label: 'Open on GitHub', icon: 'external', onSelect: () => window.open(it.url, '_blank', 'noopener') },
      ...(isOpen ? [{ label: 'Close without merging', icon: 'close' as const, danger: true, divider: true, onSelect: () => openClose(ctx, 'pull', it, reload) }] : []),
    ];
    const moreBtn = iconButton('more', 'More', (e) => openMenu(e.currentTarget as HTMLElement, more, `#${it.number}`), 22);
    moreBtn.classList.add('a-of-ghs__more');
    moreBtn.setAttribute('aria-haspopup', 'menu');
    foot.replaceChildren(
      isOpen
        ? h('div.a-of-ghs__actions', {}, moreBtn, conflicts ? h('p.a-of-ghs__why', {}, 'It has conflicts, so it can’t merge from here.') : merge)
        : h('div.a-of-ghs__actions', {}, button({ label: 'Open on GitHub', icon: 'external', size: 'lg', block: true, href: it.url, attrs: { target: '_blank', rel: 'noopener noreferrer' } })),
    );
  };

  const paintTalk = () => {
    thread.replaceChildren(commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt }, it.url, 'opened this'));
    mergeBox.replaceChildren();
    if (detailErr) return thread.append(errorBlock(detailErr, reload));
    if (!detail) return thread.append(loadingBlock(3));
    const d = detail;
    const replies = d.reviewComments.filter((c) => c.replyTo);
    const items: { at: string; node: HTMLElement }[] = [
      ...d.comments.map((c) => ({ at: c.createdAt, node: commentCard(c, it.url, 'commented') })),
      ...d.reviews.filter((r) => r.body.trim() || r.state !== 'COMMENTED').map((r) => {
        const [verb, tone] = REVIEW_WORDS[r.state ?? ''] ?? ['reviewed', 'muted'];
        return { at: r.createdAt, node: commentCard(r, it.url, verb, tone) };
      }),
      ...d.reviewComments
        .filter((c) => !c.replyTo)
        .map((c) => ({
          at: c.createdAt,
          node: h(
            'article.a-of-cmt.a-of-cmt--line',
            {},
            h('button.a-of-cmt__where', { type: 'button', onclick: () => showFiles() }, commentGlyph(12), h('code.a-of-mono', {}, `${c.path.split('/').pop()}${c.line ? `:${c.line}` : ''}`), c.line == null ? h('span', {}, 'outdated') : null),
            ...[c, ...replies.filter((r) => r.replyTo === c.id)].map((x) => h('div.a-of-cmt__reply', {}, h('header.a-of-cmt__head', {}, ghAvatar(x.author, 24), h('b', {}, x.author), h('span.a-of-cmt__time', {}, isoAgo(x.createdAt))), md(x.body, it.url))),
          ),
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    thread.append(...items.map((x) => x.node));
    const st = mergeStatus(d);
    mergeBox.dataset.tone = st.tone;
    mergeBox.append(h('div.a-of-status', { 'data-tone': st.tone }, h('span.a-of-status__dot', { 'aria-hidden': 'true' }), st.text), d.checks.length ? checksList(d.checks) : '');
  };

  const showFiles = () => {
    tab = 'files';
    tabs.select('files');
    paintTabs();
  };

  const paintFiles = () => {
    const label = tabs.querySelector('[data-value="files"] span');
    if (label) label.textContent = files ? `Changes · ${files.length}` : 'Changes';
    if (diffErr) return filesPane.replaceChildren(errorBlock(diffErr, reload));
    if (!files) return filesPane.replaceChildren(loadingBlock(4));
    filesPane.replaceChildren(diffView(files, detail?.reviewComments ?? [], it.url));
  };

  let gen = 0;
  function reload() {
    const g = ++gen;
    detailErr = '';
    diffErr = '';
    getJson<GhPullDetail>(`/api/gh/pull?number=${it.number}`, floor)
      .then((d) => {
        if (g !== gen) return;
        detail = d;
        comment.setViewer(d.viewer);
        it = { ...it, state: d.state, isDraft: d.isDraft, reviewDecision: d.reviewDecision };
      })
      .catch((e) => g === gen && (detailErr = (e as Error).message))
      .finally(() => {
        if (g !== gen) return;
        paintMeta();
        paintTalk();
        if (files) paintFiles();
      });
    getText(`/api/gh/pull/diff?number=${it.number}`, floor)
      .then((t) => g === gen && (files = parseDiff(t)))
      .catch((e) => g === gen && (diffErr = (e as Error).message))
      .finally(() => g === gen && paintFiles());
  }

  const unsub = ctx.store.on('pulls', () => {
    const fresh = ctx.store.pulls.items.find((p) => p.number === it.number);
    if (!fresh) return;
    it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
    paintMeta();
  });
  paintMeta();
  paintTalk();
  paintFiles();
  reload();
}

// =================================================================================================
// The issue sheet
// =================================================================================================

function queueState(ctx: AppContext, n: number): { on: boolean; words?: string } {
  const t = ctx.store.taskForIssue(n);
  if (!t || t.status === 'done') return { on: false };
  return { on: true, words: t.status === 'running' ? `${t.workerName ?? 'A teammate'} is on it` : 'On the task queue' };
}

function queueIssue(ctx: AppContext, it: GhIssue, c: TaskChoice) {
  ctx.net.send({ t: 'queue.add', prompt: issuePrompt(it), title: `#${it.number} ${it.title}`, issue: it.number, provider: c.provider, model: c.model, effort: c.effort });
  haptic();
  toast(`#${it.number} is on the task queue`, 'info', { label: 'See the queue', onClick: () => ctx.go({ view: 'tasks', floor: ctx.floor()! }) });
}

function openIssue(ctx: AppContext, first: GhIssue) {
  const floor = ctx.floor()!;
  let it = first;
  let detail: GhIssueDetail | null = null;
  let err = '';
  const s = sheet({ label: `Issue #${it.number}`, className: 'a-sheet--wide a-of-ghs', onClose: () => (unsubs.forEach((u) => u()), comment.dispose()) });
  const meta = h('div.a-of-ghs__meta');
  const thread = h('div.a-of-ghs__thread');
  const comment = commentBox(ctx, 'issue', it.number, it.url, (c) => {
    detail?.comments.push(c);
    paint();
  });
  const picker = choicePicker(ctx.store.project, 'queue', `a-of-iq-${it.number}`);
  const pickerBox = h('div.a-of-ghs__picker', { hidden: true }, picker.el);
  const body = h('div.a-sheet__body.a-of-ghs__body', {}, meta, thread, comment.el);
  const foot = h('footer.a-sheet__foot.a-of-ghs__foot');
  s.root.append(sheetHead(s, it.number, it.title, h('span')), body, foot);

  const optLabel = h('span.a-of-ghs__optval');
  const optBtn = h('button.a-of-add__opt', { type: 'button', 'aria-expanded': 'false' }, icon('settings', 16), h('span', {}, 'Options'), optLabel, icon('down', 16));
  optBtn.addEventListener('click', () => {
    const open = !!pickerBox.hidden;
    pickerBox.hidden = !open;
    optBtn.setAttribute('aria-expanded', String(open));
  });
  const paintOpt = () => (optLabel.textContent = choiceLabel(picker.value(), ctx.store.project));
  picker.onChange(paintOpt);
  paintOpt();
  const queueBtn = button({
    label: 'Put on the task queue',
    variant: 'primary',
    size: 'lg',
    block: true,
    icon: 'add',
    onClick: () => {
      queueIssue(ctx, it, picker.value());
      s.close();
    },
  }) as HTMLButtonElement;

  const paintFrame = () => {
    const isOpen = it.state === 'OPEN';
    const q = queueState(ctx, it.number);
    meta.replaceChildren(
      h('div.a-of-ghs__chips', {}, stateChip(it, 'issue'), q.words ? chip(q.words, 'busy') : null, ...it.labels.slice(0, 5).map(labelChip)),
      it.assignees.length ? h('p.a-of-ghs__by', {}, h('span', {}, `Assigned to ${it.assignees.join(', ')}`)) : '',
    );
    const more: MenuItem[] = [
      { label: 'Open on GitHub', icon: 'external', onSelect: () => window.open(it.url, '_blank', 'noopener') },
      ...(isOpen ? [{ label: 'Close issue', icon: 'check' as const, divider: true, onSelect: () => openClose(ctx, 'issue', it, load) }] : []),
    ];
    const moreBtn = iconButton('more', 'More', (e) => openMenu(e.currentTarget as HTMLElement, more, `#${it.number}`), 22);
    moreBtn.classList.add('a-of-ghs__more');
    moreBtn.setAttribute('aria-haspopup', 'menu');
    if (!isOpen) foot.replaceChildren(h('div.a-of-ghs__actions', {}, button({ label: 'Open on GitHub', icon: 'external', size: 'lg', block: true, href: it.url, attrs: { target: '_blank', rel: 'noopener noreferrer' } })));
    else if (q.on) foot.replaceChildren(h('div.a-of-ghs__actions', {}, moreBtn, h('p.a-of-ghs__why', {}, `${q.words}. See it under Tasks.`)));
    else foot.replaceChildren(pickerBox, h('div.a-of-ghs__optrow', {}, optBtn), h('div.a-of-ghs__actions', {}, moreBtn, queueBtn));
  };
  const paint = () => {
    thread.replaceChildren(commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt }, it.url, 'opened this'));
    if (err) thread.append(errorBlock(err, load));
    else if (!detail) thread.append(loadingBlock(2));
    else thread.append(...detail.comments.map((c) => commentCard(c, it.url, 'commented')));
  };
  let gen = 0;
  function load() {
    const g = ++gen;
    err = '';
    paint();
    getJson<GhIssueDetail>(`/api/gh/issue?number=${it.number}`, floor)
      .then((d) => {
        if (g !== gen) return;
        detail = d;
        it = { ...it, state: d.state };
        comment.setViewer(d.viewer);
      })
      .catch((e) => g === gen && (err = (e as Error).message))
      .finally(() => g === gen && (paintFrame(), paint()));
  }
  const unsubs = [
    ctx.store.on('issues', () => {
      const fresh = ctx.store.issues.items.find((i) => i.number === it.number);
      if (!fresh) return;
      it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
      paintFrame();
    }),
    ctx.store.on('queue', paintFrame),
  ];
  paintFrame();
  load();
}

// =================================================================================================
// The segment
// =================================================================================================

type Board = 'pulls' | 'issues' | 'services';
const BOARD_KEY = 'hearth.github.board';

export const githubView: View = (root, ctx) => {
  hook(ctx);
  const floor = ctx.floor()!;
  let board: Board = (() => {
    try {
      const v = sessionStorage.getItem(`${BOARD_KEY}.${floor}`);
      return v === 'issues' || v === 'services' ? v : 'pulls';
    } catch {
      return 'pulls';
    }
  })();
  const showClosed = { pulls: false, issues: false };

  // ---- Head: the repository, when the boards were last fetched, refresh ----------------------------
  const repo = repoName(ctx.store.project?.remote);
  const fetched = h('span.a-of-gh__fetched');
  const refresh = iconButton('retry', 'Check GitHub again', () => {
    ctx.net.send({ t: 'gh.refresh' });
    refresh.classList.add('is-spinning');
    setTimeout(() => refresh.classList.remove('is-spinning'), 1200);
  }, 20);
  const head = h(
    'header.a-of-gh__head',
    {},
    h('span.a-of-gh__mark', { 'aria-hidden': 'true' }, ghGlyph(20)),
    h(
      'div.a-of-gh__id',
      {},
      h('a.a-of-gh__repo', { href: ctx.store.project?.remote?.replace(/\.git$/, '') ?? '#', target: '_blank', rel: 'noopener noreferrer' }, repo.includes('/') ? h('span.a-of-gh__owner', {}, `${repo.split('/')[0]} / `) : null, h('b', {}, repo.split('/').pop() ?? repo)),
      fetched,
    ),
    refresh,
  );

  const switcher = h('div.a-of-gh__boards', { role: 'tablist', 'aria-label': 'GitHub boards' });
  const panel = h('div.a-of-gh__panel', { role: 'tabpanel' });
  root.append(h('div.a-of-gh', {}, head, switcher, panel));

  const paintSwitch = () => {
    const openPulls = ctx.store.pulls.items.filter((p) => p.state === 'OPEN').length;
    const openIssues = ctx.store.issues.items.filter((i) => i.state === 'OPEN').length;
    const items: [Board, string, number, SVGElement][] = [
      ['pulls', 'Pull requests', openPulls, prGlyph(16)],
      ['issues', 'Issues', openIssues, issueGlyph(16)],
      ['services', 'Services', ctx.store.services.items.length, globeGlyph(16)],
    ];
    switcher.replaceChildren(
      ...items.map(([b, label, n, g]) => {
        const btn = h('button.a-of-gh__board', { type: 'button', role: 'tab', 'aria-selected': String(b === board), tabindex: b === board ? 0 : -1 }, g, h('span', {}, label), n ? h('span.a-of-gh__n.a-num', {}, String(n)) : null);
        btn.addEventListener('click', () => {
          if (board === b) return;
          board = b;
          try {
            sessionStorage.setItem(`${BOARD_KEY}.${floor}`, b);
          } catch {
            // storage blocked
          }
          paintSwitch();
          paint(true);
        });
        return btn;
      }),
    );
  };
  switcher.addEventListener('keydown', (e) => {
    const tabs = [...switcher.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (i < 0 || !d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length];
    next.click();
    switcher.querySelectorAll<HTMLButtonElement>('[role=tab]')[(i + d + tabs.length) % tabs.length]?.focus();
  });

  // ---- Pull request cards ---------------------------------------------------------------------------
  const pullCard = (p: GhPull): HTMLElement => {
    const w = workerForPull(ctx.store.workers.values(), p);
    return h(
      'button.a-of-pr',
      { type: 'button', 'data-state': p.state.toLowerCase(), 'data-draft': String(p.isDraft), onclick: () => openPull(ctx, p), 'aria-label': `Pull request ${p.number}: ${p.title}` },
      h('div.a-of-pr__top', {}, h('span.a-of-pr__num.a-num', {}, `#${p.number}`), h('span.a-of-pr__time', {}, isoAgo(p.updatedAt)), p.isDraft ? chip('Draft', 'muted') : null),
      h('h3.a-of-pr__title', {}, p.title),
      h('div.a-of-pr__by', {}, ghAvatar(p.author, 24), h('span.a-of-pr__author', {}, p.author), h('span.a-of-pr__branch.a-of-mono', {}, branchGlyph(12), p.headRefName)),
      h('div.a-of-pr__chips', {}, checksChip(p.checks), reviewChip({ ...p, isDraft: false }), ...p.labels.slice(0, 3).map(labelChip)),
      h('div.a-of-pr__foot', {}, sizeBar(p.additions, p.deletions), w ? h('span.a-of-pr__who', {}, avatar(w, 24), w.name) : null),
    );
  };

  const compactRow = (label: string, number: number, title: string, when: string, onOpen: () => void, st: HTMLElement) =>
    h('button.a-of-mini', { type: 'button', onclick: onOpen }, st, h('span.a-of-mini__title', {}, h('span.a-num', {}, `#${number}`), ' ', title), h('span.a-of-mini__time', {}, when));

  const section = (title: string, n: number, ...kids: (HTMLElement | null)[]) =>
    h('section.a-of-sec', { 'aria-label': title }, h('header.a-of-sec__head', {}, h('h3.a-overline', {}, title, h('span.a-of-sec__count.a-num', {}, String(n)))), h('div.a-of-sec__list', {}, ...kids));

  const moreToggle = (which: 'pulls' | 'issues', n: number, label: string) =>
    n
      ? button({
          label: showClosed[which] ? `Hide ${label}` : `Show ${plural(n, label.replace(/s$/, ''), label)}`,
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            showClosed[which] = !showClosed[which];
            paint(false, true);
          },
        })
      : null;

  const boardProblem = (state: { error?: string; loading: boolean; fetchedAt: number }, noun: string): HTMLElement | null => {
    if (state.error) return emptyState({ icon: 'warning', title: `Couldn't read the ${noun}`, text: /no GitHub remote/i.test(state.error) ? 'This space isn’t on GitHub yet.' : 'GitHub didn’t answer. Check again in a moment.', action: { label: 'Check again', onClick: () => ctx.net.send({ t: 'gh.refresh' }) } });
    if (state.loading && !state.fetchedAt) return h('div.a-of-sec__list', { 'aria-busy': 'true' }, skeleton('block', { height: 132 }), skeleton('block', { height: 132 }));
    return null;
  };

  const paintPulls = (): HTMLElement[] => {
    const st = ctx.store.pulls;
    const problem = boardProblem(st, 'pull requests');
    if (problem) return [problem];
    const open = st.items.filter((p) => p.state === 'OPEN').sort((a, b) => Number(a.isDraft) - Number(b.isDraft) || b.updatedAt.localeCompare(a.updatedAt));
    const merged = st.items.filter((p) => p.state === 'MERGED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const closed = st.items.filter((p) => p.state === 'CLOSED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const out: HTMLElement[] = [];
    out.push(
      open.length
        ? section('Open', open.length, ...open.map(pullCard))
        : h('div.a-of-gh__calm', {}, emptyState({ emoji: '🌿', title: 'No open pull requests', text: 'When a teammate finishes something on its own branch, its pull request shows up here.' })),
    );
    const past = [...merged, ...closed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (past.length) {
      const shown = showClosed.pulls ? past : past.slice(0, 4);
      out.push(
        section(
          'Recently done',
          past.length,
          h('div.a-of-minis', {}, ...shown.map((p) => compactRow(p.state, p.number, p.title, isoAgo(p.updatedAt), () => openPull(ctx, p), stateChip(p, 'pull')))),
          past.length > 4 ? moreToggle('pulls', past.length, 'older ones') : null,
        ),
      );
    }
    return out;
  };

  // ---- Issues ---------------------------------------------------------------------------------------
  const issueCard = (it: GhIssue): HTMLElement => {
    const q = queueState(ctx, it.number);
    const card = h(
      'div.a-of-issue',
      {},
      h(
        'button.a-of-issue__main',
        { type: 'button', onclick: () => openIssue(ctx, it), 'aria-label': `Issue ${it.number}: ${it.title}` },
        h('div.a-of-pr__top', {}, h('span.a-of-pr__num.a-num', {}, `#${it.number}`), h('span.a-of-pr__time', {}, isoAgo(it.updatedAt)), it.comments ? h('span.a-of-issue__c', {}, commentGlyph(12), String(it.comments)) : null),
        h('h3.a-of-pr__title', {}, it.title),
        it.labels.length || it.assignees.length ? h('div.a-of-pr__chips', {}, ...it.labels.slice(0, 3).map(labelChip), it.assignees.length ? h('span.a-of-issue__who', {}, `→ ${it.assignees.join(', ')}`) : null) : null,
      ),
      it.state === 'OPEN'
        ? h(
            'div.a-of-issue__foot',
            {},
            q.on
              ? chip(q.words!, 'busy')
              : button({
                  label: 'Put on the queue',
                  icon: 'add',
                  size: 'sm',
                  onClick: () => queueIssue(ctx, it, rememberedChoice(ctx.store.project, 'queue')),
                  attrs: { 'aria-label': `Put issue ${it.number} on the task queue` },
                }),
          )
        : null,
    );
    return card;
  };

  const paintIssues = (): HTMLElement[] => {
    const st = ctx.store.issues;
    const problem = boardProblem(st, 'issues');
    if (problem) return [problem];
    const open = st.items.filter((i) => i.state === 'OPEN');
    const busy = open.filter((i) => i.assignees.length > 0 || queueState(ctx, i.number).on || i.labels.some((l) => /progress|doing|wip|started/i.test(l.name)));
    const todo = open.filter((i) => !busy.includes(i));
    const closed = st.items.filter((i) => i.state !== 'OPEN').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const out: HTMLElement[] = [];
    if (!open.length) out.push(h('div.a-of-gh__calm', {}, emptyState({ emoji: '🎉', title: 'No open issues', text: 'Nothing on GitHub is waiting for the team.' })));
    if (busy.length) out.push(section('Being worked on', busy.length, ...busy.map(issueCard)));
    if (todo.length) out.push(section('Open', todo.length, ...todo.map(issueCard)));
    if (closed.length) {
      const shown = showClosed.issues ? closed.slice(0, 40) : closed.slice(0, 3);
      out.push(
        section(
          'Recently closed',
          closed.length,
          h('div.a-of-minis', {}, ...shown.map((i) => compactRow('closed', i.number, i.title, isoAgo(i.updatedAt), () => openIssue(ctx, i), stateChip(i, 'issue')))),
          closed.length > 3 ? moreToggle('issues', closed.length, 'closed ones') : null,
        ),
      );
    }
    return out;
  };

  // ---- Services -------------------------------------------------------------------------------------
  const serviceUrl = (port: number) => `${location.protocol}//${location.hostname}:${port}`;
  const svcCard = (svc: ServiceInfo): HTMLElement => {
    const w = ctx.store.workers.get(svc.workerId);
    const url = serviceUrl(svc.port);
    return h(
      'article.a-of-svc',
      {},
      h('div.a-of-svc__icon', { 'aria-hidden': 'true' }, globeGlyph(22), h('span.a-of-svc__live')),
      h(
        'div.a-of-svc__body',
        {},
        h('h3.a-of-svc__title', {}, svc.title || svc.command),
        svc.title ? h('p.a-of-svc__cmd.a-of-mono', {}, svc.command) : null,
        h('p.a-of-svc__meta', {}, w ? avatar(w, 24) : null, h('span', {}, [w?.name ?? 'A teammate', svc.cwd ? svc.cwd : null, `up ${uptime(svc.since)}`].filter(Boolean).join(' · '))),
      ),
      h('div.a-of-svc__go', {}, h('span.a-of-svc__port.a-num', {}, `:${svc.port}`), button({ label: 'Open', icon: 'external', size: 'sm', href: url, attrs: { target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${svc.title || svc.command} on port ${svc.port}` } })),
    );
  };
  const paintServices = (): HTMLElement[] => {
    const items = ctx.store.services.items;
    if (!items.length) return [h('div.a-of-gh__calm', {}, emptyState({ emoji: '🌐', title: 'Nothing running yet', text: 'When a teammate starts a web server, like a dev server or a preview, it shows up here within a few seconds.' }))];
    return [
      section('Running now', items.length, ...items.map(svcCard)),
      h('p.a-of-gh__foot-note', {}, `Open goes to the office computer’s address on that port. A server that only listens on its own machine won’t load from a phone${edition.has3d ? '; the 3D office’s services board has a tunnel command for that' : ''}.`),
    ];
  };

  // ---- Paint ----------------------------------------------------------------------------------------
  const paintFetched = () => {
    const at = Math.max(ctx.store.pulls.fetchedAt, ctx.store.issues.fetchedAt);
    const loading = ctx.store.pulls.loading || ctx.store.issues.loading;
    fetched.textContent = loading && at ? 'Checking…' : at ? `Checked ${timeAgo(at)}` : '';
  };
  let lastSig = '';
  let dataSig = '';
  /** What the board on screen is drawn from: an update that changes none of it (a teammate typing) redraws nothing. */
  const sigNow = () => {
    const who = (p: { number: number; headRefName: string }) => workerForPull(ctx.store.workers.values(), p)?.name ?? '';
    if (board === 'pulls') return JSON.stringify([showClosed.pulls, ctx.store.pulls.error, ctx.store.pulls.loading && !ctx.store.pulls.fetchedAt, ctx.store.pulls.items.map((p) => [p.number, p.state, p.isDraft, p.updatedAt, p.checks, p.reviewDecision, p.title, who(p)])]);
    if (board === 'issues') return JSON.stringify([showClosed.issues, ctx.store.issues.error, ctx.store.issues.loading && !ctx.store.issues.fetchedAt, ctx.store.issues.items.map((i) => [i.number, i.state, i.updatedAt, i.title, i.comments, i.assignees, queueState(ctx, i.number).words ?? ''])]);
    return JSON.stringify(ctx.store.services.items.map((v) => [v.port, v.title, v.command, v.since, ctx.store.workers.get(v.workerId)?.name ?? '']));
  };
  const paint = (animate = false, force = false) => {
    paintFetched();
    const sig0 = `${board}|${sigNow()}`;
    if (!animate && !force && sig0 === dataSig) return;
    dataSig = sig0;
    const parts = board === 'pulls' ? paintPulls() : board === 'issues' ? paintIssues() : paintServices();
    const sig = `${board}|${animate}`;
    panel.classList.toggle('a-v-stagger', animate || sig !== lastSig);
    lastSig = `${board}|false`;
    const y = window.scrollY;
    panel.replaceChildren(...parts);
    if (!animate) window.scrollTo({ top: y });
  };

  const repaint = () => {
    paintSwitch();
    paint();
  };
  ctx.on('pulls', repaint);
  ctx.on('issues', repaint);
  ctx.on('services', repaint);
  ctx.on('queue', () => board === 'issues' && paint());
  ctx.on('workers', () => board !== 'issues' && paint());
  paintSwitch();
  paint(true);
  const tick = setInterval(paintFetched, 30_000);
  return () => clearInterval(tick);
};
