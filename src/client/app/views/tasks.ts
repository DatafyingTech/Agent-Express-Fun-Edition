// The Tasks segment: the floor's task queue (the 📋 whiteboard of the 3D office, see ui/queue.ts and
// world/boards.ts). What's waiting, who's on what, and what finished, with its pull request. She adds
// a task (a message, a name if she likes, and which model thinks it through), moves the waiting ones
// up and down, retries or clears the finished ones, and sets how many teammates the queue keeps busy.
//
// Everything here is the office's own queue.* messages; the server seats a fresh teammate for the
// next task whenever there's room, so this screen only ever asks and then shows what the store says.

import type { AppContext, View } from '../context';
import type { AgentEffort, AgentProvider, ClaudeModel, ProjectInfo, QueueTask, WorkerInfo } from '../../../shared/protocol';
import { AGENT_EFFORTS, CLAUDE_MODELS } from '../../../shared/protocol';
import { CLAUDE_MODEL_LABEL, EFFORT_LABEL, PROVIDER_LABEL, modelBadge, rememberedChoice, resolvedProvider, supportedProviders } from '../../ui/provider';
import { icon } from '../icons';
import { avatar, button, confirmDialog, emptyState, h, hrefOf, iconButton, openMenu, plural, timeAgo, uiStatus, type MenuItem } from '../ui';

// =================================================================================================
// Choosing who thinks it through: provider, model and effort (shared with the GitHub segment)
// =================================================================================================

/** The same keys the 3D office's queue form remembers its choice under, so both start on the same thing. */
const PROVIDER_KEY = 'agent-office.provider';
const choiceKey = (kind: 'model' | 'effort', key: string) => `agent-office.claude-${kind}.${key}`;

function remember(k: string, v: string | undefined) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}

export interface TaskChoice {
  provider: AgentProvider;
  model?: string;
  effort?: AgentEffort;
}

/** "Opus 5.5 · High", "Codex", or "Office default". */
export function choiceLabel(c: TaskChoice, project: ProjectInfo | null): string {
  const badge = modelBadge(c.provider, c.model, c.effort);
  const multi = supportedProviders(project).length > 1;
  const who = c.provider !== resolvedProvider(project?.defaultProvider, project) || (multi && c.provider !== 'claude') ? PROVIDER_LABEL[c.provider] : '';
  return [who, badge].filter(Boolean).join(' · ') || 'Office default';
}

export interface ChoicePicker {
  el: HTMLElement;
  value(): TaskChoice;
  /** Called whenever the choice changes (to relabel whatever shows it). */
  onChange(fn: () => void): void;
}

/** A row of pills: one choice out of a few, as a radio group. */
function pills<T extends string>(label: string, options: { value: T; label: string }[], value: T, onPick: (v: T) => void): { el: HTMLElement; set(v: T): void } {
  const btns = options.map((o) =>
    h('button.a-of-pill', { type: 'button', role: 'radio', 'data-value': o.value, onclick: () => pick(o.value) }, o.label),
  ) as HTMLButtonElement[];
  const el = h('div.a-of-pills', { role: 'radiogroup', 'aria-label': label }, ...btns);
  const set = (v: T) => btns.forEach((b) => {
    const on = b.dataset.value === v;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const pick = (v: T) => {
    set(v);
    onPick(v);
  };
  el.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = btns[(i + d + btns.length) % btns.length];
    next.focus();
    pick(next.dataset.value as T);
  });
  set(value);
  return { el, set };
}

/**
 * Provider (when the office offers more than one), then the Claude model and effort, or an OpenCode
 * model id. `key` scopes what's remembered, as the 3D office's picker does ("queue" for the queue).
 */
export function choicePicker(project: ProjectInfo | null, key: string, idBase: string): ChoicePicker {
  const start = rememberedChoice(project, key);
  let provider: AgentProvider = start.provider;
  let model: string | undefined = start.model;
  let effort: AgentEffort | undefined = start.effort;
  let openModel = '';
  const subs: (() => void)[] = [];
  const changed = () => subs.forEach((fn) => fn());

  const providers = supportedProviders(project);
  const provRow =
    providers.length > 1
      ? pills<AgentProvider>('Who does it', providers.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })), provider, (p) => {
          provider = p;
          remember(PROVIDER_KEY, p);
          paint();
          changed();
        })
      : null;

  const modelRow = pills<ClaudeModel | ''>(
    'Model',
    [{ value: '', label: 'Default' }, ...CLAUDE_MODELS.map((m) => ({ value: m, label: CLAUDE_MODEL_LABEL[m] }))],
    (model as ClaudeModel | undefined) ?? '',
    (m) => {
      model = m || undefined;
      remember(choiceKey('model', key), model);
      changed();
    },
  );
  const effortRow = pills<AgentEffort | ''>(
    'Effort',
    [{ value: '', label: 'Default' }, ...AGENT_EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))],
    effort ?? '',
    (e) => {
      effort = e || undefined;
      remember(choiceKey('effort', key), effort);
      changed();
    },
  );
  const ocInput = h('input.a-field__control.a-of-mono', {
    id: `${idBase}-oc`,
    type: 'text',
    placeholder: 'provider/model (optional)',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '256',
  }) as HTMLInputElement;
  ocInput.addEventListener('input', () => {
    openModel = ocInput.value.trim();
    changed();
  });

  const claudeBox = h(
    'div.a-of-choice__claude',
    {},
    h('div.a-of-choice__label', { id: `${idBase}-m` }, 'Model'),
    modelRow.el,
    h('div.a-of-choice__label', { id: `${idBase}-e` }, 'Effort'),
    effortRow.el,
  );
  modelRow.el.setAttribute('aria-labelledby', `${idBase}-m`);
  effortRow.el.setAttribute('aria-labelledby', `${idBase}-e`);
  const ocBox = h('div.a-of-choice__oc', {}, h('label.a-of-choice__label', { for: `${idBase}-oc` }, 'OpenCode model'), ocInput);

  const paint = () => {
    claudeBox.hidden = provider !== 'claude';
    ocBox.hidden = provider !== 'opencode';
  };
  paint();

  const el = h('div.a-of-choice', {}, provRow ? h('div.a-of-choice__label', {}, 'Who does it') : null, provRow?.el ?? null, claudeBox, ocBox);
  return {
    el,
    value: () => ({
      provider,
      model: provider === 'claude' ? model : provider === 'opencode' && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/\S+$/.test(openModel) ? openModel : undefined,
      effort: provider === 'claude' ? effort : undefined,
    }),
    onChange: (fn) => subs.push(fn),
  };
}

// =================================================================================================
// Words
// =================================================================================================

/** How a finished task ended, in a few words. */
function outcomeWords(t: QueueTask): string {
  switch (t.outcome) {
    case 'done':
      return 'Finished';
    case 'exited':
      return 'Stopped before finishing';
    case 'killed':
      return 'Sent home';
    case 'failed':
      return "Couldn't start";
    default:
      return 'Finished';
  }
}

/** "#12" and the rest of the title, when the task came from an issue. */
function splitTitle(t: QueueTask): { issue?: string; title: string } {
  if (t.issue === undefined) return { title: t.title || t.prompt };
  const m = new RegExp(`^#${t.issue}\\s*`).exec(t.title);
  return { issue: `#${t.issue}`, title: m ? t.title.slice(m[0].length) : t.title };
}

/** The first line of the message, when it says more than the title does. */
function promptLine(t: QueueTask): string | null {
  if (t.issue !== undefined) return null;
  const one = t.prompt.replace(/\s+/g, ' ').trim();
  if (!one || one === t.title || one.startsWith(t.title.replace(/…$/, ''))) return one.length > t.title.length + 8 ? one : null;
  return one;
}

const officeFull = (ctx: AppContext) => {
  const m = ctx.store.machine;
  return m.limit !== undefined && m.workers >= m.limit;
};

// =================================================================================================
// The view
// =================================================================================================

export const tasksView: View = (root, ctx) => {
  const floor = ctx.floor()!;
  const send = ctx.net.send.bind(ctx.net);

  // ---- The head: how the queue is doing, and how many at once --------------------------------------
  const headline = h('h2.a-of-q__headline');
  const lede = h('p.a-of-q__lede');
  const limitValue = h('span.a-of-stepper__value.a-num', { 'aria-live': 'polite' });
  const minus = h('button.a-of-stepper__btn', { type: 'button', 'aria-label': 'Fewer at once' }, icon('minus', 18)) as HTMLButtonElement;
  const plus = h('button.a-of-stepper__btn', { type: 'button', 'aria-label': 'More at once' }, icon('add', 18)) as HTMLButtonElement;
  const setLimit = (n: number) => {
    const next = Math.max(0, n);
    if (next === ctx.store.queue.maxWorkers) return;
    send({ t: 'queue.limit', maxWorkers: next });
    haptic();
  };
  minus.addEventListener('click', () => setLimit(ctx.store.queue.maxWorkers - 1));
  plus.addEventListener('click', () => setLimit(ctx.store.queue.maxWorkers + 1));
  const stepper = h(
    'div.a-of-stepper',
    { role: 'group', 'aria-label': 'How many teammates the queue keeps busy at once' },
    h('span.a-of-stepper__label', {}, 'At once'),
    minus,
    limitValue,
    plus,
  );
  const fullNote = h('p.a-of-note', { hidden: true });
  const head = h('section.a-of-q', {}, h('div.a-of-q__text', {}, headline, lede), stepper);

  // ---- Add a task ---------------------------------------------------------------------------------
  const ta = h('textarea.a-field__control.a-of-add__text', {
    id: `a-of-task-${floor}`,
    rows: 3,
    placeholder: 'Describe a task for the next free teammate…',
    'aria-label': 'New task',
  }) as HTMLTextAreaElement;
  const titleInput = h('input.a-field__control', { id: `a-of-task-title-${floor}`, type: 'text', placeholder: 'A short name (optional)', maxlength: '120', autocomplete: 'off' }) as HTMLInputElement;
  const picker = choicePicker(ctx.store.project, 'queue', `a-of-q-${floor}`);
  const optionsLabel = h('span.a-of-add__opt-value');
  const optionsBtn = h(
    'button.a-of-add__opt',
    { type: 'button', 'aria-expanded': 'false', 'aria-controls': `a-of-add-more-${floor}` },
    icon('settings', 16),
    h('span', {}, 'Options'),
    optionsLabel,
    icon('down', 16),
  );
  const more = h(
    'div.a-of-add__more',
    { id: `a-of-add-more-${floor}`, hidden: true },
    h('div.a-field', {}, h('label.a-field__label', { for: titleInput.id }, 'Name'), titleInput),
    picker.el,
  );
  const addBtn = button({ label: 'Add to the queue', variant: 'primary', type: 'submit', icon: 'add' }) as HTMLButtonElement;
  const form = h(
    'form.a-of-add',
    { 'aria-label': 'Add a task' },
    h('label.a-of-add__label', { for: ta.id }, 'Add a task'),
    ta,
    more,
    h('div.a-of-add__foot', {}, optionsBtn, addBtn),
  ) as HTMLFormElement;
  form.noValidate = true;
  const paintOptions = () => (optionsLabel.textContent = choiceLabel(picker.value(), ctx.store.project));
  picker.onChange(paintOptions);
  paintOptions();
  const syncAdd = () => addBtn.toggleAttribute('disabled', !ta.value.trim());
  syncAdd();
  ta.addEventListener('input', syncAdd);
  optionsBtn.addEventListener('click', () => {
    const open = !!more.hidden;
    more.hidden = !open;
    optionsBtn.setAttribute('aria-expanded', String(open));
    form.classList.toggle('is-open', open);
  });
  const submit = () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    const c = picker.value();
    const title = titleInput.value.trim();
    send({ t: 'queue.add', prompt, ...(title ? { title } : {}), provider: c.provider, model: c.model, effort: c.effort });
    ta.value = '';
    titleInput.value = '';
    syncAdd();
    haptic();
    ctx.toast('Added to the queue');
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  // ---- The lists ----------------------------------------------------------------------------------
  const lists = h('div.a-of-q__lists');
  root.append(h('div.a-of-tasks', {}, head, fullNote, form, lists));

  const workerOf = (t: QueueTask): WorkerInfo | undefined => (t.workerId ? ctx.store.workers.get(t.workerId) : undefined);

  /** Where focus was, by task and action, so a redraw after a tap keeps it there. */
  const focusKey = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-fk]')?.dataset.fk;

  const lead = (t: QueueTask, pos: number): HTMLElement => {
    if (t.status === 'queued') return h('span.a-of-task__pos.a-num', { 'aria-hidden': 'true' }, String(pos));
    const w = workerOf(t);
    if (t.status === 'running') {
      return w ? avatar(w, 40) : avatar({ name: t.workerName ?? '?', status: 'working', size: 40 });
    }
    const ok = t.outcome === 'done';
    return h('span.a-of-task__done', { 'data-ok': String(ok), 'aria-hidden': 'true' }, icon(ok ? 'check' : t.outcome === 'failed' ? 'warning' : 'minus', 20));
  };

  const card = (t: QueueTask, i: number, n: number): HTMLElement => {
    const { issue, title } = splitTitle(t);
    const w = workerOf(t);
    const line = promptLine(t);
    const model = choiceLabel({ provider: resolvedProvider(t.provider, ctx.store.project), model: t.model, effort: t.effort }, ctx.store.project);
    const meta: (HTMLElement | string)[] = [];
    const actions: HTMLElement[] = [];
    const menu: MenuItem[] = [];

    if (t.status === 'running') {
      const who = w?.name ?? t.workerName ?? 'A teammate';
      meta.push(h('span.a-of-task__who', {}, who, ' ', w ? h('span.a-of-task__state', {}, uiStatus(w) === 'needs' ? 'needs you' : uiStatus(w) === 'resting' ? 'is resting' : 'is on it') : 'has gone home'));
      if (t.startedAt) meta.push(`Started ${timeAgo(t.startedAt)}`);
      if (w) {
        const chat = button({ label: 'Chat', size: 'sm', icon: 'chats', href: hrefOf({ view: 'chat', floor, worker: w.id }), attrs: { 'aria-label': `Chat with ${w.name}` } });
        chat.dataset.fk = `${t.id}:chat`;
        actions.push(chat);
        menu.push({
          label: `Stop ${w.name}`,
          icon: 'rest',
          danger: true,
          onSelect: async () => {
            const ok = await confirmDialog({ title: `Stop ${w.name}?`, body: `${w.name} goes home and the task counts as stopped. You can put it back on the queue afterwards.`, action: 'Stop', danger: true });
            if (ok) send({ t: 'worker.kill', workerId: w.id });
          },
        });
      }
    } else if (t.status === 'queued') {
      meta.push(`Added by ${t.addedBy.replace(/\s*📱\s*$/u, '')}`, timeAgo(t.addedAt));
      const up = iconButton('back', 'Move up', () => send({ t: 'queue.move', taskId: t.id, delta: -1 }), 20);
      const down = iconButton('back', 'Move down', () => send({ t: 'queue.move', taskId: t.id, delta: 1 }), 20);
      up.classList.add('a-of-move', 'is-up');
      down.classList.add('a-of-move', 'is-down');
      up.disabled = i === 0;
      down.disabled = i === n - 1;
      up.dataset.fk = `${t.id}:up`;
      down.dataset.fk = `${t.id}:down`;
      up.setAttribute('aria-label', `Move “${title}” up`);
      down.setAttribute('aria-label', `Move “${title}” down`);
      actions.push(h('span.a-of-move-pair', {}, up, down));
      if (i > 0) menu.push({ label: 'Move to the top', icon: 'send', onSelect: () => send({ t: 'queue.move', taskId: t.id, delta: -i }) });
      menu.push({
        label: 'Take off the queue',
        icon: 'remove',
        danger: true,
        divider: i > 0,
        onSelect: async () => {
          const ok = await confirmDialog({ title: `Take “${title}” off the queue?`, body: 'Nobody has started it yet, so nothing is lost but the task itself.', action: 'Remove', danger: true });
          if (ok) send({ t: 'queue.remove', taskId: t.id });
        },
      });
    } else {
      meta.push(h('span.a-of-task__outcome', { 'data-ok': String(t.outcome === 'done') }, outcomeWords(t)));
      if (t.workerName) meta.push(t.workerName);
      if (t.finishedAt) meta.push(timeAgo(t.finishedAt));
      if (t.pr) {
        const merged = t.pr.state === 'MERGED';
        const pr = h(
          'a.a-of-prchip',
          { href: t.pr.url, target: '_blank', rel: 'noopener noreferrer', 'data-state': t.pr.state.toLowerCase(), title: t.pr.title, 'data-fk': `${t.id}:pr` },
          prGlyph(),
          h('span', {}, `PR #${t.pr.number}`),
          h('span.a-of-prchip__state', {}, merged ? 'merged' : t.pr.state === 'CLOSED' ? 'closed' : t.pr.state === 'DRAFT' ? 'draft' : 'open'),
        );
        actions.push(pr);
      }
      const retry = button({ label: 'Retry', size: 'sm', icon: 'retry', onClick: () => (send({ t: 'queue.retry', taskId: t.id }), haptic()), attrs: { 'aria-label': `Put “${title}” back on the queue` } });
      retry.dataset.fk = `${t.id}:retry`;
      actions.push(retry);
      if (w) menu.push({ label: `Chat with ${w.name}`, icon: 'chats', onSelect: () => ctx.go({ view: 'chat', floor, worker: w.id }) });
      menu.push({
        label: 'Remove from the list',
        icon: 'remove',
        danger: true,
        divider: !!w,
        onSelect: async () => {
          const ok = await confirmDialog({ title: `Remove “${title}”?`, body: t.pr ? 'It comes off this list. Its pull request stays on GitHub.' : 'It comes off this list.', action: 'Remove', danger: true });
          if (ok) send({ t: 'queue.remove', taskId: t.id });
        },
      });
    }

    const moreBtn = menu.length ? iconButton('more', `More for “${title}”`, (e) => openMenu(e.currentTarget as HTMLElement, menu, title), 20) : null;
    if (moreBtn) {
      moreBtn.classList.add('a-of-task__more');
      moreBtn.dataset.fk = `${t.id}:more`;
      moreBtn.setAttribute('aria-haspopup', 'menu');
    }
    return h(
      'article.a-of-task',
      { 'data-status': t.status, 'data-outcome': t.outcome ?? '', 'aria-label': title },
      h('div.a-of-task__lead', {}, lead(t, i + 1)),
      h(
        'div.a-of-task__body',
        {},
        h('h3.a-of-task__title', {}, issue ? h('span.a-of-task__issue.a-num', {}, issue) : null, title),
        line ? h('p.a-of-task__prompt', {}, line) : null,
        h('p.a-of-task__meta', {}, ...meta.flatMap((m, k) => (k ? [h('span.a-of-dot', { 'aria-hidden': 'true' }, '·'), m] : [m]))),
        h(
          'div.a-of-task__foot',
          {},
          h('div.a-of-task__tags', {}, h('span.a-of-tag', {}, sparkGlyph(), model), t.branch ? h('span.a-of-tag.a-of-mono', { title: t.branch }, branchGlyph(), t.branch) : null, t.error && t.outcome !== 'done' ? h('span.a-of-tag.is-warn', { title: t.error }, t.error) : null),
          actions.length ? h('div.a-of-task__actions', {}, ...actions) : null,
        ),
      ),
      moreBtn,
    );
  };

  const section = (title: string, tasks: QueueTask[], extra?: HTMLElement | null): HTMLElement | null => {
    if (!tasks.length) return null;
    return h(
      'section.a-of-sec',
      { 'aria-label': title },
      h('header.a-of-sec__head', {}, h('h3.a-overline', {}, title, h('span.a-of-sec__count.a-num', {}, String(tasks.length))), extra ?? null),
      h('div.a-of-sec__list', {}, ...tasks.map((t, i) => card(t, i, tasks.length))),
    );
  };

  let first = true;
  const render = () => {
    const q = ctx.store.queue;
    const running = q.tasks.filter((t) => t.status === 'running');
    const queued = q.tasks.filter((t) => t.status === 'queued');
    const done = q.tasks.filter((t) => t.status === 'done').slice().reverse();

    // The head.
    limitValue.textContent = q.maxWorkers === 0 ? 'Paused' : String(q.maxWorkers);
    stepper.dataset.paused = String(q.maxWorkers === 0);
    minus.disabled = q.maxWorkers <= 0;
    headline.replaceChildren(...headlineOf(running.length, queued.length, done.length, q.maxWorkers));
    lede.textContent =
      q.maxWorkers === 0
        ? 'The queue is paused. Turn “at once” up to get it going again.'
        : `Whenever there's room, the next task gets a fresh teammate, up to ${plural(q.maxWorkers, 'at a time', 'at a time')}. It keeps going while you're away.`;
    const full = queued.length > 0 && officeFull(ctx);
    fullNote.hidden = !full;
    if (full) fullNote.replaceChildren(icon('info', 18), h('span', {}, `The office is at its limit of ${plural(ctx.store.machine.limit ?? 0, 'teammate')}, so the next task waits until someone goes home.`));

    // The lists, keeping focus where it was.
    const fk = focusKey();
    const clear = done.length
      ? button({
          label: 'Clear',
          size: 'sm',
          variant: 'ghost',
          onClick: async () => {
            const ok = await confirmDialog({ title: `Clear ${plural(done.length, 'finished task')}?`, body: 'They come off this list. Pull requests stay on GitHub.', action: 'Clear' });
            if (ok) send({ t: 'queue.clear' });
          },
          attrs: { 'aria-label': 'Clear the finished tasks', 'data-fk': 'clear' },
        })
      : null;
    const parts = [section('Working on it', running), section('Up next', queued), section('Finished', done, clear)].filter((n): n is HTMLElement => !!n);
    if (!parts.length) {
      parts.push(
        h(
          'div.a-of-q__empty',
          {},
          emptyState({
            emoji: '📋',
            title: 'Nothing on the queue',
            text: ctx.store.project?.remote ? 'Add a task above, or put an issue on the queue from the GitHub tab. A teammate picks it up as soon as there’s room.' : 'Add a task above. A teammate picks it up as soon as there’s room.',
          }),
        ),
      );
    }
    lists.classList.toggle('a-v-stagger', first);
    lists.replaceChildren(...parts);
    first = false;
    if (fk) lists.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]:not([disabled])`)?.focus({ preventScroll: true });
  };

  ctx.on('queue', render);
  ctx.on('workers', render);
  let fullKey = '';
  ctx.on('machine', () => {
    const k = `${officeFull(ctx)}|${ctx.store.machine.limit}`;
    if (k !== fullKey) {
      fullKey = k;
      render();
    }
  });
  ctx.on('project', paintOptions);
  render();
  // Keeps "5 min ago" honest.
  const tick = setInterval(render, 30_000);
  return () => clearInterval(tick);
};

/** The big line at the top: "2 on it, 3 waiting". */
function headlineOf(running: number, queued: number, done: number, max: number): (Node | string)[] {
  const em = (n: number) => h('em', {}, String(n));
  if (!running && !queued) return done ? ['All caught up'] : ['Nothing ', h('em', {}, 'waiting')];
  const parts: (Node | string)[] = [];
  if (running) parts.push(em(running), ' on it');
  if (running && queued) parts.push(', ');
  if (queued) parts.push(em(queued), ' waiting');
  if (max === 0) parts.push(h('span.a-of-q__paused', {}, ' · paused'));
  return parts;
}

/** A light tap on a phone that has one (Android); nothing elsewhere. */
export function haptic() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // not allowed here
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An icon icons.ts doesn't have, on the same 24 grid with the same 1.75 stroke. */
export function glyph(paths: string, size = 16): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'a-icon');
  svg.innerHTML = paths;
  return svg;
}

/** Lucide git-pull-request. */
export const prGlyph = (size = 16) => glyph('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>', size);
/** Lucide sparkles: who thinks it through. */
export const sparkGlyph = (size = 14) => glyph('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>', size);
/** Lucide git-branch. */
export const branchGlyph = (size = 14) => glyph('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>', size);
