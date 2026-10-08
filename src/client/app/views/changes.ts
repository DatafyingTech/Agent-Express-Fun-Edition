// A teammate's changes (#/changes/<floor>/<worker>): what they changed in their checkout against the
// branch the office was opened on, as the 3D office's Changes window shows it (client/ui/changes.ts),
// made for a phone: a summary, the files with their +/− counts, and a unified diff you read full
// screen, tinted by what was added and removed. Commit, discard and open a pull request sit in a glass
// bar at the bottom.
//
// The office follows the checkout while anyone watches (changes.watch / changes.unwatch) and sends a
// `changes` message whenever it moves; each file's diff comes on request (changes.diff). A file's
// `sig` changes when its working copy does, which is when an open diff is fetched again.

import type { AppContext, View } from '../context';
import { changedImageType, type ChangedFile, type ChangesState, type ServerMsg, type WorkerInfo } from '../../../shared/protocol';
import { icon } from '../icons';
import { APP_NAME } from '../../../shared/edition';
import { avatar, button, confirmDialog, h, iconButton, setBusy, sheet, spaceColor } from '../ui';
import { followKeyboard, haptic, onNetStatus, onServer, phoneLayout, tmBack, tmIcon } from './terminal';
import { plainSpace } from './chat';

const STATUS_WORD: Record<ChangedFile['status'], string> = { M: 'Changed', A: 'Added', D: 'Deleted', R: 'Renamed', T: 'Type changed', '?': 'New file' };
const letter = (s: ChangedFile['status']) => (s === '?' ? 'A' : s);
const splitPath = (p: string) => {
  const i = p.lastIndexOf('/');
  return { dir: i >= 0 ? p.slice(0, i + 1) : '', base: p.slice(i + 1) };
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Five little squares, GitHub style: how much of the change was added versus removed. */
function ratioBar(a: number, d: number): HTMLElement {
  const total = a + d;
  const adds = total ? Math.round((a / total) * 5) : 0;
  const dels = total ? Math.min(5 - adds, Math.max(d ? 1 : 0, Math.round((d / total) * 5))) : 0;
  return h('span.a-tm-ratio', { 'aria-hidden': 'true' }, ...Array.from({ length: 5 }, (_, i) => h('i', { class: i < adds ? 'is-add' : i < adds + dels ? 'is-del' : '' })));
}

function counts(a: number, d: number, binary = false): HTMLElement {
  if (binary) return h('span.a-tm-counts', {}, h('span.a-tm-counts__bin', {}, 'binary'));
  return h('span.a-tm-counts', { 'aria-label': `${a} added, ${d} removed` }, h('span.is-add', {}, `+${a}`), h('span.is-del', {}, `−${d}`));
}

// =================================================================================================
// The diff: unified, line numbers that stay put, a light syntax tint on top of the add/remove tint
// =================================================================================================

type Lang = 'c' | 'hash' | 'json' | 'plain';
const LANG: Record<string, Lang> = {};
for (const e of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'swift', 'kt', 'php', 'dart', 'vue', 'svelte']) LANG[e] = 'c';
for (const e of ['py', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'yml', 'yaml', 'toml', 'rb', 'r', 'conf', 'ini', 'env', 'dockerfile', 'mk']) LANG[e] = 'hash';
for (const e of ['json', 'jsonc', 'json5']) LANG[e] = 'json';
const langOf = (path: string): Lang => LANG[(/\.([^./]+)$/.exec(path.toLowerCase())?.[1] ?? (/dockerfile$/i.test(path) ? 'dockerfile' : ''))] ?? 'plain';

const KEYWORDS = new Set(
  'abstract and as async await break case catch class const continue def default del do elif else enum except export extends false finally fn for from func function if impl implements import in interface is lambda let match mod new none not null of or package pass private protected pub public raise readonly return self static struct super switch then this throw true try type typeof undefined use var void while with yield fi esac param'.split(' '),
);
const TOKEN: Record<Lang, RegExp | null> = {
  c: /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g,
  hash: /(#.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$-]*)/g,
  json: /()("(?:\\.|[^"\\])*"?)|(-?\b\d[\d.eE+-]*\b)|(\btrue\b|\bfalse\b|\bnull\b)/g,
  plain: null,
};

/** A line of code as text nodes and tinted spans (never innerHTML: the code is whatever they wrote). */
function tint(code: string, lang: Lang): (Node | string)[] {
  const re = TOKEN[lang];
  if (!re || code.length > 2000) return [code];
  const out: (Node | string)[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] && (lang === 'json' || KEYWORDS.has(m[4].toLowerCase())) ? 'k' : '';
    if (!cls) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    out.push(h('span', { class: `t-${cls}` }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function renderDiff(text: string, truncated: boolean, path: string): HTMLElement {
  const lang = langOf(path);
  const lines = h('div.a-tm-diff__lines');
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  const row = (cls: string, o: string, n: string, sign: string, code: (Node | string)[]) =>
    h('div.a-tm-dl', { class: cls }, h('span.a-tm-dl__gut', {}, h('span', {}, o), h('span', {}, n)), h('span.a-tm-dl__sign', { 'aria-hidden': 'true' }, sign), h('span.a-tm-dl__code', {}, ...code));
  for (const raw of all) {
    if (raw.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/.exec(raw);
      if (m) {
        oldN = Number(m[1]);
        newN = Number(m[2]);
      }
      lines.append(h('div.a-tm-dl.is-hunk', {}, h('span.a-tm-hunk', {}, m ? `Line ${m[2]}` : raw, m?.[3] ? h('span.a-tm-hunk__ctx', {}, m[3]) : null)));
      continue;
    }
    if (!inHunk || raw.startsWith('diff --git')) {
      inHunk = false;
      // The file names are already in the header; keep only the lines that say something else.
      if (/^(diff --git|index |--- |\+\+\+ |similarity index|rename (from|to) )/.test(raw) || !raw.trim()) continue;
      lines.append(h('div.a-tm-dl.is-meta', {}, h('span.a-tm-dl__note', {}, raw)));
      continue;
    }
    if (raw.startsWith('+')) lines.append(row('is-add', '', String(newN++), '+', tint(raw.slice(1), lang)));
    else if (raw.startsWith('-')) lines.append(row('is-del', String(oldN++), '', '−', tint(raw.slice(1), lang)));
    else if (raw.startsWith('\\')) lines.append(h('div.a-tm-dl.is-meta', {}, h('span.a-tm-dl__note', {}, raw.replace(/^\\\s*/, ''))));
    else lines.append(row('is-ctx', String(oldN++), String(newN++), '', tint(raw.slice(1), lang)));
  }
  if (!lines.childElementCount) lines.append(h('div.a-tm-dl.is-meta', {}, h('span.a-tm-dl__note', {}, 'No line changes to show (only the file’s mode or name changed).')));
  if (truncated) lines.append(h('div.a-tm-dl.is-meta', {}, h('span.a-tm-dl__note', {}, '… the rest is too long to show here.')));
  return h('div.a-tm-diff__scroll', { tabindex: '0', 'aria-label': `Changes to ${path}` }, lines);
}

// =================================================================================================
// The screen
// =================================================================================================

export const changesView: View = (root, ctx, route) => {
  if (route.view !== 'changes') return;
  const { floor, worker: workerId } = route;
  const info = (): WorkerInfo | undefined => ctx.store.workers.get(workerId);
  const cleanups: (() => void)[] = [];
  document.body.classList.add('a-tm-immersive');
  cleanups.push(() => document.body.classList.remove('a-tm-immersive'));
  const w0 = info();
  const name = w0?.name ?? 'Teammate';
  const plain = plainSpace(floor, w0);
  document.title = `${name} · Changes · ${APP_NAME}`;

  let state: ChangesState | null = null;
  let selected: string | null = null;
  /** The signature the shown diff was fetched for; a new one means the file changed underneath. */
  let shownSig: string | null = null;
  let requestedSig = '';
  let loading = false;

  // ---- Frame ----
  const sub = h('span.a-tm-ch__sub');
  const header = h(
    'header.a-tm-head.a-tm-head--page',
    {},
    h(
      'div.a-tm-head__row',
      {},
      tmBack(name, ctx, { view: 'chat', floor, worker: workerId }),
      h('div.a-tm-ch__title', {}, w0 ? avatar(w0, 32) : null, h('div', {}, h('h1.a-tm-ch__h1', {}, 'Changes'), sub)),
      h('a.a-tm-round', { href: `#/term/${encodeURIComponent(floor)}/${encodeURIComponent(workerId)}`, 'aria-label': 'Terminal', title: 'Terminal' }, tmIcon('terminal', 20)),
    ),
  );
  const summary = h('section.a-tm-ch__summary', { 'aria-live': 'polite' });
  const list = h('div.a-tm-ch__files', { role: 'list', 'aria-label': 'Changed files' });
  const listPane = h('div.a-tm-ch__scroll', {}, h('div.a-tm-ch__inner', {}, summary, list));

  const diffTitle = h('div.a-tm-ch__dtitle');
  const diffMeta = h('div.a-tm-ch__dmeta');
  const diffBody = h('div.a-tm-ch__dbody');
  const prevBtn = iconButton('back', 'Previous file', () => move(-1), 20);
  const nextBtn = iconButton('forward', 'Next file', () => move(1), 20);
  const closeDiff = h('button.a-tm-ch__dback', { type: 'button', 'aria-label': 'All files' }, icon('back', 20), h('span', {}, 'Files'));
  const diffPane = h(
    'section.a-tm-ch__diff',
    { 'aria-label': 'Diff' },
    h('div.a-tm-ch__dhead', {}, closeDiff, diffTitle, h('div.a-tm-ch__dnav', {}, prevBtn, nextBtn)),
    diffMeta,
    diffBody,
  );

  const discardBtn = button({ label: 'Discard', icon: 'remove', variant: 'danger-quiet' }) as HTMLButtonElement;
  const commitBtn = button({ label: 'Commit', variant: 'primary' }) as HTMLButtonElement;
  const prSlot = h('span.a-tm-ch__pr');
  const busyEl = h('div.a-tm-ch__busy', { role: 'status' });
  const foot = h('footer.a-tm-ch__foot', {}, busyEl, h('div.a-tm-ch__acts', {}, discardBtn, prSlot, commitBtn));

  const el = h(
    'div.a-tm-changes',
    { style: `--a-who:${w0?.color ?? 'var(--a-accent, var(--a-clay))'};--a-space:${spaceColor(floor)}` },
    h('div.a-tm-aura', { 'aria-hidden': 'true' }, h('span'), h('span')),
    h('div.a-tm-ch__body', {}, listPane, diffPane),
    header,
    foot,
  );
  root.append(el);
  const ro = new ResizeObserver(() => {
    el.style.setProperty('--a-tm-head-h', `${header.offsetHeight}px`);
    el.style.setProperty('--a-tm-foot-h', `${foot.offsetHeight}px`);
  });
  ro.observe(header);
  ro.observe(foot);
  cleanups.push(() => ro.disconnect());
  cleanups.push(followKeyboard(el));
  listPane.addEventListener('scroll', () => header.classList.toggle('is-scrolled', listPane.scrollTop > 4), { passive: true });

  if (!w0) {
    summary.replaceChildren(h('div.a-tm-ch__empty', {}, h('p.a-tm-ch__empty-title', {}, 'This teammate isn’t here'), h('p', {}, 'They may have been sent home.')));
    foot.hidden = true;
    return () => cleanups.forEach((f) => f());
  }

  const where = () => (state?.dir ? state.dir : 'the shared project folder');
  const uncommitted = () => state?.files.filter((f) => f.uncommitted).length ?? 0;

  // ---- Choosing a file ----
  const wide = () => matchMedia('(min-width: 1024px)').matches;
  const openDiff = (open: boolean) => {
    el.classList.toggle('is-diff', open);
    if (open) diffPane.scrollTop = 0;
  };
  closeDiff.addEventListener('click', () => {
    openDiff(false);
    if (!wide()) selected = null;
    renderList();
  });

  const requestDiff = () => {
    const f = state?.files.find((x) => x.path === selected);
    if (!selected || !f) return;
    loading = true;
    requestedSig = f.sig;
    ctx.net.send({ t: 'changes.diff', workerId, path: selected });
  };

  const select = (p: string | null, show = true) => {
    if (p !== selected) {
      selected = p;
      shownSig = null;
      diffBody.replaceChildren(h('div.a-tm-ch__dload', { 'aria-busy': 'true' }, ...[70, 45, 82, 60, 38].map((w) => h('span', { style: `width:${w}%` }))));
      if (p) requestDiff();
    }
    renderList();
    renderDiffHead();
    if (show && p) openDiff(true);
  };

  const move = (delta: number) => {
    if (!state?.files.length) return;
    const i = state.files.findIndex((f) => f.path === selected);
    const next = state.files[Math.max(0, Math.min(state.files.length - 1, i + delta))];
    if (next) select(next.path);
  };

  // ---- Rendering ----
  const renderSummary = () => {
    const s = state;
    const w = info();
    sub.textContent = w ? (s?.branch && !plain ? `${w.name} · ${s.branch}` : w.name) : '';
    if (!s) {
      summary.replaceChildren(h('div.a-tm-ch__sumload', { 'aria-busy': 'true', 'aria-label': 'Loading' }, h('span'), h('span'), h('span')));
      return;
    }
    if (s.error) {
      summary.replaceChildren(h('div.a-tm-ch__empty', {}, h('p.a-tm-ch__empty-title', {}, 'Couldn’t read their changes'), h('p', {}, `Something went wrong reading ${where()}. Try again in a moment.`)));
      return;
    }
    if (!s.files.length) {
      summary.replaceChildren(
        h(
          'div.a-tm-ch__empty',
          {},
          h('span.a-tm-ch__empty-mark', { 'aria-hidden': 'true' }, tmIcon('branch', 28)),
          h('p.a-tm-ch__empty-title', {}, 'Nothing changed yet'),
          h('p', {}, s.base === 'HEAD' ? `Nothing uncommitted in ${where()}.` : `${name} hasn’t changed anything since ${s.base} yet.`),
          s.ahead ? h('p.a-tm-ch__empty-note', {}, `${plural(s.ahead, 'commit')} ahead of ${s.base}${s.subject ? `: “${s.subject}”` : ''}`) : h('p.a-tm-ch__empty-note', {}, 'This page follows along as they work.'),
          s.pr ? h('a.a-tm-ch__prlink', { href: s.pr.url, target: '_blank', rel: 'noopener' }, tmIcon('pr', 16), `Pull request #${s.pr.number}`, icon('external', 14)) : null,
        ),
      );
      return;
    }
    const adds = s.files.reduce((n, f) => n + f.additions, 0);
    const dels = s.files.reduce((n, f) => n + f.deletions, 0);
    const u = uncommitted();
    const bits = [plural(s.files.length + s.more, 'file'), u ? `${u} not committed` : 'all committed'];
    if (s.ahead) bits.push(`${plural(s.ahead, 'commit')} ahead of ${s.base}`);
    summary.replaceChildren(
      h(
        'div.a-tm-ch__card',
        {},
        h('div.a-tm-ch__big', {}, h('span.is-add', {}, `+${adds.toLocaleString()}`), h('span.is-del', {}, `−${dels.toLocaleString()}`), ratioBar(adds, dels)),
        h('p.a-tm-ch__line', {}, bits.join(' · ')),
        h(
          'div.a-tm-ch__chips',
          {},
          s.branch ? h('span.a-tm-ch__chip.is-mono', { title: `Branch ${s.branch}` }, tmIcon('branch', 14), s.branch) : null,
          s.base !== 'HEAD' ? h('span.a-tm-ch__chip', {}, `vs ${s.base}`) : null,
          s.pr ? h('a.a-tm-ch__chip.is-link', { href: s.pr.url, target: '_blank', rel: 'noopener' }, tmIcon('pr', 14), `#${s.pr.number}`, icon('external', 12)) : null,
        ),
        !s.dir ? h('p.a-tm-ch__warn', {}, icon('info', 16), h('span', {}, 'They work in the shared project folder, so this is everyone’s uncommitted work there, not just theirs.')) : null,
      ),
    );
  };

  const fileRow = (f: ChangedFile) => {
    const { dir, base } = splitPath(f.path);
    const b = h(
      'button.a-tm-file',
      { type: 'button', role: 'listitem', 'aria-current': f.path === selected ? 'true' : undefined, 'aria-label': `${f.path}, ${STATUS_WORD[f.status].toLowerCase()}, ${f.binary ? 'binary' : `${f.additions} added, ${f.deletions} removed`}${f.uncommitted ? ', not committed' : ''}` },
      h('span.a-tm-file__st', { 'data-st': letter(f.status), 'aria-hidden': 'true' }, letter(f.status)),
      h('span.a-tm-file__name', {}, h('span.a-tm-file__base', {}, base), dir || f.from ? h('span.a-tm-file__dir', {}, f.from ? `from ${f.from}` : dir) : null),
      h('span.a-tm-file__end', {}, counts(f.additions, f.deletions, f.binary), f.binary ? null : ratioBar(f.additions, f.deletions)),
      f.uncommitted ? h('span.a-tm-file__dirty', { title: 'Not committed yet', 'aria-hidden': 'true' }) : null,
    );
    b.addEventListener('click', () => select(f.path));
    return b;
  };

  const renderList = () => {
    const s = state;
    if (!s || s.error || !s.files.length) return list.replaceChildren();
    list.replaceChildren(...s.files.map(fileRow), s.more ? h('p.a-tm-ch__more', {}, `…and ${s.more} more`) : '');
  };

  const renderDiffHead = () => {
    const f = state?.files.find((x) => x.path === selected);
    if (!f) {
      diffTitle.replaceChildren();
      diffMeta.replaceChildren();
      return;
    }
    const { dir, base } = splitPath(f.path);
    diffTitle.replaceChildren(h('span.a-tm-ch__dbase', { title: f.path }, base), dir ? h('span.a-tm-ch__ddir', {}, dir) : '');
    const i = state!.files.indexOf(f);
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= state!.files.length - 1;
    const discardOne = h('button.a-tm-ch__dmini', { type: 'button' }, tmIcon('undo', 16), h('span', {}, 'Discard'));
    discardOne.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Discard the changes to ${base}?`,
        body: `This puts ${f.path} back to its last commit. ${f.status === '?' ? 'It’s a new file, so it’s deleted.' : 'Anything already committed stays.'}`,
        action: 'Discard',
        danger: true,
      });
      if (!ok) return;
      ctx.net.send({ t: 'changes.discard', workerId, path: f.path });
      haptic();
    });
    diffMeta.replaceChildren(
      h('span.a-tm-file__st', { 'data-st': letter(f.status) }, letter(f.status)),
      h('span.a-tm-ch__dword', {}, f.uncommitted ? `${STATUS_WORD[f.status]} · not committed` : STATUS_WORD[f.status]),
      counts(f.additions, f.deletions, f.binary),
      h('span.a-tm-ch__dspacer'),
      f.uncommitted && !state?.busy ? discardOne : '',
    );
  };

  const renderFoot = () => {
    const s = state;
    const busy = !!s?.busy;
    const u = uncommitted();
    busyEl.replaceChildren();
    busyEl.hidden = !busy;
    if (busy) busyEl.append(h('span.a-spinner', { 'aria-hidden': 'true' }), h('span', {}, s!.busy!));
    discardBtn.disabled = busy || !u;
    commitBtn.disabled = busy || !u;
    commitBtn.querySelector('.a-btn__label')!.textContent = u ? `Commit ${u}` : 'Commit';
    commitBtn.setAttribute('aria-label', u ? `Commit ${plural(u, 'file')}` : 'Commit');
    prSlot.replaceChildren();
    const remote = !!ctx.store.project?.remote;
    // Nothing to commit and no pull request to open: no bar.
    foot.hidden = !s || !!s.error || (!s.files.length && !(remote && (s.pr || (s.prBase && s.ahead))));
    if (!s || !remote) return;
    if (s.pr) {
      prSlot.append(button({ label: `PR #${s.pr.number}`, variant: 'secondary', href: s.pr.url, attrs: { target: '_blank', rel: 'noopener', 'aria-label': `Pull request #${s.pr.number} on GitHub` } }));
    } else if (s.prBase) {
      const why = busy ? 'Busy' : u ? 'Commit first' : !s.ahead ? `Nothing new for ${s.prBase} yet` : '';
      // The one ember button: Commit while there's something to commit, then the pull request.
      const pr = button({ label: 'Open PR', variant: u ? 'secondary' : 'primary', disabled: !!why, attrs: { title: why || `Push ${s.branch} and open a pull request against ${s.prBase}` }, onClick: () => openPrSheet() });
      pr.prepend(tmIcon('pr', 18));
      prSlot.append(pr);
    }
    commitBtn.classList.toggle('a-btn--primary', !!u || !s.prBase || !!s.pr);
    commitBtn.classList.toggle('a-btn--secondary', !u && !!s.prBase && !s.pr);
  };

  const render = () => {
    renderSummary();
    renderList();
    renderDiffHead();
    renderFoot();
  };

  // ---- Actions ----
  const openCommitSheet = () => {
    const n = uncommitted();
    if (!n) return;
    const msg = h('textarea.a-tm-field', { rows: 4, placeholder: 'What changed, and why…', 'aria-label': 'Commit message', autocapitalize: 'sentences' }) as HTMLTextAreaElement;
    const go = button({ label: `Commit ${plural(n, 'file')}`, variant: 'primary', size: 'lg', block: true, disabled: true }) as HTMLButtonElement;
    msg.addEventListener('input', () => (go.disabled = !msg.value.trim()));
    const s = sheet({
      title: `Commit ${plural(n, 'file')}`,
      className: 'a-tm-sheet a-tm-sheet--form',
      content: [h('p.a-tm-sheet__lead', {}, `Stages everything in ${where()} and commits it${state?.branch ? ` on ${state.branch}` : ''}.`), msg],
      footer: go,
    });
    go.addEventListener('click', () => {
      const text = msg.value.trim();
      if (!text) return;
      ctx.net.send({ t: 'changes.commit', workerId, message: text });
      setBusy(go, true);
      haptic();
      s.close();
    });
    if (!phoneLayout()) setTimeout(() => msg.focus(), 60);
  };

  const openPrSheet = () => {
    const s0 = state;
    if (!s0?.prBase) return;
    const title = h('input.a-tm-field', { type: 'text', value: s0.subject ?? '', placeholder: 'Title', 'aria-label': 'Pull request title' }) as HTMLInputElement;
    const body = h('textarea.a-tm-field', { rows: 5, placeholder: 'What it does, and anything a reviewer should know… (optional)', 'aria-label': 'Description' }) as HTMLTextAreaElement;
    const go = button({ label: 'Open pull request', variant: 'primary', size: 'lg', block: true, disabled: !title.value.trim() }) as HTMLButtonElement;
    go.prepend(tmIcon('pr', 20));
    title.addEventListener('input', () => (go.disabled = !title.value.trim()));
    const s = sheet({
      title: 'Open a pull request',
      className: 'a-tm-sheet a-tm-sheet--form',
      content: [h('p.a-tm-sheet__lead', {}, `Pushes ${s0.branch} to GitHub and opens a pull request against ${s0.prBase}.`), h('label.a-tm-label', {}, 'Title'), title, h('label.a-tm-label', {}, 'Description'), body],
      footer: go,
    });
    go.addEventListener('click', () => {
      if (!title.value.trim()) return;
      ctx.net.send({ t: 'changes.pr', workerId, title: title.value.trim(), body: body.value.trim() });
      setBusy(go, true);
      haptic();
      s.close();
    });
  };

  commitBtn.addEventListener('click', openCommitSheet);
  discardBtn.addEventListener('click', async () => {
    const n = uncommitted();
    if (!n) return;
    const ok = await confirmDialog({
      title: `Discard ${name}’s uncommitted changes?`,
      body: `This puts ${plural(n, 'file')} in ${where()} back to the last commit and deletes new files. Commits stay.${state?.dir ? '' : ' That folder is shared, so anyone’s uncommitted edits there go too.'}`,
      action: 'Discard everything',
      danger: true,
    });
    if (!ok) return;
    ctx.net.send({ t: 'changes.discard', workerId });
    haptic();
  });

  // ---- The office ----
  const onState = (s: ChangesState) => {
    state = s;
    const f = selected ? s.files.find((x) => x.path === selected) : undefined;
    if (selected && !f) {
      selected = null;
      shownSig = null;
      openDiff(false);
    }
    // Wide screens show a diff beside the list from the start.
    if (!selected && wide() && s.files.length) select(s.files[0].path, false);
    render();
    const cur = selected ? s.files.find((x) => x.path === selected) : undefined;
    if (cur && shownSig !== null && shownSig !== cur.sig && !loading) requestDiff();
  };

  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'changes' && msg.state.workerId === workerId) onState(msg.state);
    else if (msg.t === 'changes.diff' && msg.workerId === workerId && msg.path === selected) {
      loading = false;
      shownSig = requestedSig;
      const f = state?.files.find((x) => x.path === selected);
      const text = msg.error ? h('div.a-tm-ch__empty', {}, h('p', {}, 'Couldn’t show this file’s changes.')) : renderDiff(msg.diff, msg.truncated, msg.path);
      const type = f ? changedImageType(f.path) : undefined;
      // A picture's diff only says it differs, so show the picture instead. An SVG is text too: its diff stays below.
      if (f && type) diffBody.replaceChildren(renderPreview(floor, workerId, f), ...(type === 'image/svg+xml' ? [text] : []));
      else diffBody.replaceChildren(text);
      // The file changed again while the diff was on its way: fetch the fresh one.
      if (f && f.sig !== shownSig) requestDiff();
    }
  };
  cleanups.push(onServer(ctx.net, onMsg));
  cleanups.push(onNetStatus(ctx.net, (up) => up && ctx.net.send({ t: 'changes.watch', workerId })));
  cleanups.push(
    ctx.on('workers', () => {
      if (!info()) ctx.go({ view: 'space', floor });
    }),
  );
  cleanups.push(ctx.on('project', renderFoot));
  ctx.net.send({ t: 'changes.watch', workerId });
  cleanups.push(() => ctx.net.send({ t: 'changes.unwatch', workerId }));
  // Arrow keys (or j / k) step through the files on a keyboard.
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, dialog')) return;
    if (e.key === 'ArrowDown' || e.key === 'j') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
    else if (e.key === 'Escape' && el.classList.contains('is-diff') && !wide()) closeDiff.click();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));
  render();

  return () => cleanups.forEach((f) => f());
};

/** A changed picture, before and after; new and deleted files only have the one side. */
function renderPreview(floor: string, workerId: string, f: ChangedFile): HTMLElement {
  const sides: ('old' | 'new')[] = f.status === '?' || f.status === 'A' ? ['new'] : f.status === 'D' ? ['old'] : ['old', 'new'];
  return h(
    'div.a-tm-ch__pics',
    {},
    ...sides.map((side) => {
      const q = new URLSearchParams({ floor, worker: workerId, path: f.path, side, v: f.sig });
      const label = side === 'old' ? 'Before' : 'After';
      const size = h('span');
      const img = h('img', { src: `/api/changes/file?${q}`, alt: `${f.path} (${label.toLowerCase()})`, loading: 'lazy' }) as HTMLImageElement;
      const frame = h('div.a-tm-ch__picframe', {}, img);
      img.addEventListener('load', () => (size.textContent = `${img.naturalWidth} × ${img.naturalHeight}`));
      img.addEventListener('error', () => frame.replaceChildren(h('p', {}, `Couldn’t load the picture ${side === 'old' ? 'from before' : 'as it is now'}.`)));
      return h('figure', {}, h('figcaption', {}, h('b', {}, label), size), frame);
    }),
  );
}
