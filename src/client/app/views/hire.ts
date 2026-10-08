// Add teammates (route `hire`, a sheet over the space; DESIGN.md §6.5, REDESIGN.md §2.2). Everything
// the 3D office's hiring can do, as one calm sheet:
//   - People: anyone on the roster (shared/team.ts), by department, several at once. This space's
//     departments come first; the rest of the team is a tap (or a search) away.
//   - Crews: a crew sits down together, its lead first.
//   - A helper: a general helper with no brief, going by the job you give them.
// Then an optional first message, and how they start: asleep (parked: they keep a seat and nothing
// runs until they're woken), in their own git branch (floors on git), and for one teammate on their
// own, which model and effort they think with (their role's by default).
//
// It sends exactly what the 3D office sends (ui/crew.ts, ui/prompt.ts + main.ts hireAtDesk):
//   one teammate, awake    → worker.spawn { deskId, prompt, worktree, provider, model, effort, role }
//                            (model and effort left out while they're the role's own, as prompt.ts does)
//   a helper               → worker.spawn { deskId, prompt, worktree, provider, model, effort, label }
//   several, or asleep     → crew.hire { floor, roles, prompt, worktree, crew, parked }
//                            (no prompt when parked, as crew.ts does; the crew's own order when it's a crew)
// The seat is the first free desk, else the next bean bag (layout.ts nextFreeSeat), as the office picks.
//
// The shell opens the sheet (ui.ts sheet()) and hands this view its root; this view renders the head,
// the scrolling body and the sticky footer, and closes by going back to the space.

import type { View } from '../context';
import type { AgentEffort, AgentProvider, ClaudeModel, ClientMsg } from '../../../shared/protocol';
import { AGENT_EFFORTS, CLAUDE_MODELS } from '../../../shared/protocol';
import { CREWS, CREW_BY_ID, DEPARTMENTS, DEPARTMENT_ICON, TEAM, TEAM_BY_ID, type Crew, type Department, type TeamMember } from '../../../shared/team';
import { SEATS, nextFreeSeat } from '../../../shared/layout';
import { CLAUDE_MODEL_LABEL, EFFORT_LABEL, PROVIDER_LABEL, supportedProviders, resolvedProvider } from '../../ui/provider';
import { icon } from '../icons';
import { avatar, avatarStack, h, iconButton, onTeam, plural, spaceName, teamOn } from '../ui';
import { HIRE_PICK_KEY, glyph, tap } from './reports';

/** The most a single add sends (the office's own limit for a crew). */
const MAX = 16;
const pickKey = (floor: string) => `hearth.hire.${floor}`;
const msgKey = (floor: string) => `hearth.hire.msg.${floor}`;
/** The 3D office's "own worktree" choice, shared with it. */
const WT_KEY = 'agent-office.worktree';
const JOB_MAX = 24;

type Mode = 'people' | 'crews' | 'helper';

function readPicks(floor: string): string[] {
  const out: string[] = [];
  try {
    // Someone sent her here to add a particular teammate (Reports' "Add Budget Reports").
    const pre = sessionStorage.getItem(HIRE_PICK_KEY);
    sessionStorage.removeItem(HIRE_PICK_KEY);
    const saved = sessionStorage.getItem(pickKey(floor));
    for (const raw of [saved, pre]) {
      const v = raw ? JSON.parse(raw) : [];
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'string' && TEAM_BY_ID.has(id) && !out.includes(id)) out.push(id);
    }
  } catch {
    // storage blocked
  }
  return out;
}

function session(key: string, value?: string): string {
  try {
    if (value === undefined) return sessionStorage.getItem(key) ?? '';
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // storage blocked
  }
  return value ?? '';
}

/** "Chores & Upkeep, Meal Planner and Garden Helper". */
function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const shortModel = (m: ClaudeModel) => CLAUDE_MODEL_LABEL[m].split(' ')[0];

/** A row of pills that work as radio buttons. */
function pillRadio<T extends string>(o: { name: string; label: string; items: { value: T; label: string; note?: string }[]; value: T; onChange: (v: T) => void }) {
  const group = h('div.a-hs-pills', { role: 'radiogroup', 'aria-label': o.label });
  const btns = o.items.map((it) =>
    h(
      'button.a-hs-pill',
      { type: 'button', role: 'radio', 'data-value': it.value },
      h('span', {}, it.label),
      it.note ? h('span.a-hs-pill__note', {}, it.note) : null,
    ),
  );
  group.append(...btns);
  let cur = o.value;
  const set = (v: T) => {
    cur = v;
    btns.forEach((b, i) => {
      const on = o.items[i].value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  btns.forEach((b, i) =>
    b.addEventListener('click', () => {
      if (o.items[i].value === cur) return;
      set(o.items[i].value);
      tap();
      o.onChange(cur);
    }),
  );
  group.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + btns.length) % btns.length;
    btns[j].focus();
    btns[j].click();
  });
  set(o.value);
  return { el: group, set, value: () => cur };
}

/** A switch row: the label and a line under it, the switch at the end. The whole row toggles it. */
function switchRow(id: string, title: string, sub: HTMLElement) {
  const box = h('input.a-switch', { type: 'checkbox', role: 'switch', id, 'aria-describedby': `${id}-d` }) as HTMLInputElement;
  sub.id = `${id}-d`;
  const row = h('label.a-hs-opt', { for: id }, h('span.a-hs-opt__text', {}, h('span.a-hs-opt__title', {}, title), sub), box);
  return { row, box };
}

export const hireView: View = (root, ctx, route) => {
  if (!('floor' in route)) return;
  const floor = route.floor;
  const space = spaceName(floor);
  const close = () => ctx.go({ view: 'space', floor });
  const onGit = !!ctx.store.project?.branch;

  // ---- State ---------------------------------------------------------------------------------------
  const picked = new Set<string>(readPicks(floor));
  let mode: Mode = 'people';
  let crewId: string | undefined;
  let query = '';
  let showAll = false;
  /** Asleep by default, so nothing runs until she needs it; a first message wakes the idea up. */
  let asleep = true;
  let asleepTouched = false;
  let worktree = false;
  try {
    worktree = onGit && localStorage.getItem(WT_KEY) === '1';
  } catch {
    // storage blocked
  }
  /** Model and effort for one teammate on their own ('' = the role's own, or the office's for a helper). */
  let model: ClaudeModel | '' = '';
  let effort: AgentEffort | '' = '';
  const providers = supportedProviders(ctx.store.project);
  let provider: AgentProvider = resolvedProvider(ctx.store.project?.defaultProvider, ctx.store.project);
  let openModel = '';

  /** Roster ids already in this space. */
  const present = () => new Set(teamOn(floor).map((w) => w.role).filter((r): r is string => !!r));
  const takenSeats = () => new Set([...ctx.store.workers.values()].map((w) => w.deskId));

  /** The departments this space is about: its crews' and its teammates'. */
  const spaceDepts = (): Set<Department> => {
    const ds = new Set<Department>();
    for (const c of CREWS) if (c.floor === floor) for (const id of c.members) ds.add(TEAM_BY_ID.get(id)!.group);
    for (const r of present()) {
      const g = TEAM_BY_ID.get(r)?.group;
      if (g) ds.add(g);
    }
    return ds;
  };
  const crewBelongs = (c: Crew, ds: Set<Department>) => c.floor === floor || (!c.floor && c.members.every((id) => ds.has(TEAM_BY_ID.get(id)!.group)));

  // ---- Head ----------------------------------------------------------------------------------------
  const titleId = 'a-hire-title';
  const head = h(
    'header.a-sheet__head.a-hs-head',
    {},
    h('div.a-hs-head__titles', {}, h('h2.a-sheet__title.a-hs-title', { id: titleId }, 'Add teammates'), h('p.a-hs-sub', {}, 'to ', h('em', {}, space))),
    iconButton('close', 'Close', close),
  );

  // ---- Seats and the machine -----------------------------------------------------------------------
  const seats = h('div.a-hs-seats', { role: 'status', 'aria-live': 'polite' });
  const warnEl = h('p.a-hs-warn', { role: 'alert', hidden: true });

  // ---- Mode ------------------------------------------------------------------------------------------
  const modes = pillRadio<Mode>({
    name: 'mode',
    label: 'Who to add',
    value: mode,
    items: [
      { value: 'people', label: 'People' },
      { value: 'crews', label: 'Crews' },
      { value: 'helper', label: 'A helper' },
    ],
    onChange: (v) => {
      mode = v;
      render();
      body.scrollTo({ top: 0 });
    },
  });
  modes.el.classList.add('a-hs-modes');

  // ---- People --------------------------------------------------------------------------------------
  const search = h('input.a-hs-search__input', { type: 'search', placeholder: 'Search the team…', 'aria-label': 'Search the team', autocomplete: 'off', enterkeyhint: 'search' }) as HTMLInputElement;
  const searchEl = h('label.a-hs-search', {}, glyph('search', 18), search);
  const peopleEl = h('div.a-hs-people');
  const moreBtn = h('button.a-hs-more', { type: 'button', 'aria-expanded': 'false' });
  const peoplePanel = h('div.a-hs-panel', { 'data-mode': 'people' }, searchEl, peopleEl, moreBtn);

  // ---- Crews ---------------------------------------------------------------------------------------
  const crewsEl = h('div.a-hs-crews', { role: 'radiogroup', 'aria-label': 'Crews' });
  const crewsPanel = h('div.a-hs-panel', { 'data-mode': 'crews' }, crewsEl);

  // ---- Helper ----------------------------------------------------------------------------------------
  const job = h('input.a-field__control.a-hs-job', { type: 'text', id: 'a-hs-job', maxlength: JOB_MAX, placeholder: 'e.g. Tax paperwork', autocomplete: 'off', autocapitalize: 'sentences', 'aria-describedby': 'a-hs-job-d' }) as HTMLInputElement;
  const helperPanel = h(
    'div.a-hs-panel',
    { 'data-mode': 'helper' },
    h(
      'div.a-hs-helper',
      {},
      h('span.a-hs-helper__art', { 'aria-hidden': 'true' }, glyph('helper', 26)),
      h('div', {}, h('p.a-hs-helper__title', {}, 'A general helper'), h('p.a-hs-helper__text', {}, 'No brief and no role: they do what you ask, on the office’s usual settings.')),
    ),
    h('label.a-hs-label', { for: 'a-hs-job' }, 'Their job'),
    job,
    h('p.a-hs-hint', { id: 'a-hs-job-d' }, 'What they go by in the office. Leave it empty and they’re “Helper”.'),
  );

  // ---- First message, how they start ----------------------------------------------------------------
  const msg = h('textarea.a-field__control.a-hs-msg', { id: 'a-hs-msg', rows: 3, maxlength: 20000, autocapitalize: 'sentences', spellcheck: 'true', 'aria-describedby': 'a-hs-msg-d' }) as HTMLTextAreaElement;
  msg.value = session(msgKey(floor));
  const msgHint = h('p.a-hs-hint', { id: 'a-hs-msg-d' });

  const asleepSub = h('span.a-hs-opt__sub');
  const asleepRow = switchRow('a-hs-asleep', 'Start asleep', asleepSub);
  const wtSub = h('span.a-hs-opt__sub');
  const wtRow = switchRow('a-hs-wt', 'Their own branch', wtSub);
  const opts = h('div.a-hs-opts', {}, asleepRow.row, onGit ? wtRow.row : null);

  const tuneSummary = h('span.a-hs-tune__value');
  const modelHost = h('div.a-hs-tune__field');
  const effortHost = h('div.a-hs-tune__field');
  const providerHost = h('div.a-hs-tune__field');
  const tuneNote = h('p.a-hs-hint');
  const tune = h(
    'details.a-hs-tune',
    {},
    h('summary.a-hs-tune__sum', {}, h('span.a-hs-tune__label', {}, 'Model & effort'), tuneSummary, h('span.a-hs-tune__chev', { 'aria-hidden': 'true' }, icon('down', 18))),
    h('div.a-hs-tune__body', {}, providerHost, modelHost, effortHost, tuneNote),
  ) as HTMLDetailsElement;

  const details = h(
    'section.a-hs-details',
    { 'aria-labelledby': 'a-hs-details-h' },
    h('h3.a-hs-h', { id: 'a-hs-details-h' }, 'Getting started'),
    h('label.a-hs-label', { for: 'a-hs-msg' }, 'Their first message ', h('span.a-hs-optional', {}, 'optional')),
    msg,
    msgHint,
    opts,
    tune,
  );

  const body = h('div.a-sheet__body.a-hs', {}, seats, warnEl, modes.el, peoplePanel, crewsPanel, helperPanel, details);

  // ---- Footer ----------------------------------------------------------------------------------------
  const who = h('div.a-hs-who', { 'aria-hidden': 'true' });
  const addBtn = h('button.a-btn.a-btn--primary.a-btn--lg.a-btn--block.a-hs-add', { type: 'submit' }, h('span.a-btn__label', {}, 'Pick someone to add')) as HTMLButtonElement;
  const reason = h('p.a-hs-reason', { id: 'a-hs-reason', 'aria-live': 'polite' });
  const foot = h('footer.a-sheet__foot.a-hs-foot', {}, h('div.a-hs-foot__row', {}, who, addBtn), reason);

  const form = h('form.a-hire-sheet', { 'aria-labelledby': titleId }, head, body, foot) as HTMLFormElement;
  form.noValidate = true;
  root.replaceChildren(form);
  root.closest('dialog')?.setAttribute('aria-labelledby', titleId);

  // =================================================================================================
  // What would be sent
  // =================================================================================================

  interface Plan {
    /** Who, for the button and the toast. */
    label: string;
    toast: string;
    people: { emoji?: string; color?: string; name: string }[];
    count: number;
    msg?: ClientMsg;
    /** Why the button can't go yet. */
    blocked?: string;
    /** One teammate on their own (the model and effort apply). */
    single?: TeamMember | 'helper';
  }

  /** Crew order when the picks are exactly a crew (or everyone of it who isn't here yet), else roster order. */
  const crewOfPicks = (ids: Set<string>, here: Set<string>): Crew | undefined =>
    CREWS.find((c) => {
      const open = c.members.filter((id) => !here.has(id));
      const all = c.members.length === ids.size && c.members.every((id) => ids.has(id));
      return all || (open.length > 1 && open.length === ids.size && open.every((id) => ids.has(id)));
    });

  const room = () => {
    const free = SEATS.filter((d) => !takenSeats().has(d.id)).length;
    const m = ctx.store.machine;
    const office = m.limit !== undefined ? Math.max(0, m.limit - m.workers) : Infinity;
    return { free, office, room: Math.min(free, office) };
  };

  const plan = (): Plan => {
    const here = present();
    const text = msg.value.trim();
    const prompt = asleep ? undefined : text || undefined;
    const wt = onGit && worktree;
    const r = room();
    const noRoom = r.room <= 0 ? (r.office <= 0 ? `The office is at its limit of ${ctx.store.machine.limit}. Send someone home first.` : `Every seat in ${space} is taken. Send someone home first.`) : undefined;
    const tooMany = (n: number) => (n > r.room ? `There’s room for ${plural(r.room, 'more teammate', 'more teammates')} right now.` : n > MAX ? `Add up to ${MAX} at a time.` : undefined);

    if (mode === 'helper') {
      const label = job.value.replace(/\s+/g, ' ').trim().slice(0, JOB_MAX);
      const seat = nextFreeSeat((id) => takenSeats().has(id));
      const opt = tuneValues(undefined);
      return {
        label: label ? `Add a helper for ${label}` : 'Add a helper',
        toast: `${label || 'A helper'} is joining ${space}`,
        people: [{ name: label || 'Helper' }],
        count: 1,
        single: 'helper',
        blocked: noRoom ?? (seat ? undefined : `Every seat in ${space} is taken.`),
        msg: seat ? { t: 'worker.spawn', deskId: seat.id, prompt: text || undefined, worktree: wt, provider, model: opt.model, effort: opt.effort, label: label || undefined } : undefined,
      };
    }

    let ids: string[];
    let crew: Crew | undefined;
    if (mode === 'crews') {
      crew = crewId ? CREW_BY_ID.get(crewId) : undefined;
      if (!crew) return { label: 'Pick a crew', toast: '', people: [], count: 0, blocked: 'Pick a crew to add.' };
      const open = crew.members.filter((id) => !here.has(id));
      ids = open.length ? open : [];
      if (!ids.length) return { label: 'Everyone’s here', toast: '', people: [], count: 0, blocked: `Everyone in the ${crew.name} is already here.` };
    } else {
      crew = crewOfPicks(picked, here);
      ids = crew ? crew.members.filter((id) => picked.has(id)) : TEAM.filter((m) => picked.has(m.id)).map((m) => m.id);
      if (!ids.length) return { label: 'Pick someone to add', toast: '', people: [], count: 0, blocked: 'Pick a teammate, a crew or a helper.' };
    }
    const members = ids.map((id) => TEAM_BY_ID.get(id)!);
    const n = members.length;
    const people = members.map((m) => ({ emoji: m.emoji, color: m.color, name: m.name }));
    const blocked = noRoom ?? tooMany(n);
    const verb = asleep ? 'taking a seat' : 'joining';
    if (n === 1 && !asleep) {
      const m = members[0];
      const seat = nextFreeSeat((id) => takenSeats().has(id));
      const opt = tuneValues(m);
      return {
        label: `Add ${m.name}`,
        toast: `${m.name} is joining ${space}`,
        people,
        count: 1,
        single: m,
        blocked: blocked ?? (seat ? undefined : `Every seat in ${space} is taken.`),
        msg: seat ? { t: 'worker.spawn', deskId: seat.id, prompt, worktree: wt, provider, model: opt.model, effort: opt.effort, role: m.id } : undefined,
      };
    }
    return {
      label: n === 1 ? `Add ${members[0].name}` : crew ? `Add the ${crew.name}` : `Add ${plural(n, 'teammate')}`,
      toast: n === 1 ? `${members[0].name} is ${verb} in ${space}` : `${crew ? `The ${crew.name}` : `${n} teammates`} ${n === 1 ? 'is' : 'are'} ${verb} in ${space}`,
      people,
      count: n,
      single: n === 1 ? members[0] : undefined,
      blocked,
      msg: { t: 'crew.hire', floor, roles: ids, prompt, worktree: wt, crew: crew?.id, parked: asleep },
    };
  };

  /** The model and effort to send: nothing while they're the role's own (the office fills those in). */
  const tuneValues = (m: TeamMember | undefined): { model?: string; effort?: AgentEffort } => {
    if (provider === 'opencode') return { model: /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/\S+$/.test(openModel) ? openModel : undefined };
    if (provider !== 'claude') return {};
    return {
      model: model && (!m || model !== m.model) ? model : undefined,
      effort: effort && (!m || effort !== m.effort) ? effort : undefined,
    };
  };

  // =================================================================================================
  // Rendering
  // =================================================================================================

  const personRow = (m: TeamMember, here: Set<string>) => {
    const already = here.has(m.id);
    const id = `a-hire-${m.id}`;
    const on = picked.has(m.id);
    const box = h('input.a-hs-box', { type: 'checkbox', id, 'aria-describedby': `${id}-d` }) as HTMLInputElement;
    box.checked = on;
    box.addEventListener('change', () => {
      if (box.checked) picked.add(m.id);
      else picked.delete(m.id);
      tap();
      paint();
    });
    return h(
      'label.a-hs-person',
      { for: id, 'data-id': m.id, 'data-here': already ? 'true' : undefined, 'data-on': on ? 'true' : undefined },
      avatar({ emoji: m.emoji, color: m.color, name: m.name }, 40),
      h(
        'span.a-hs-person__text',
        {},
        h('span.a-hs-person__top', {}, h('span.a-hs-person__name', {}, m.name), h('span.a-sp-model', { 'data-model': m.model, title: `${CLAUDE_MODEL_LABEL[m.model]} · ${EFFORT_LABEL[m.effort]} effort` }, shortModel(m.model))),
        h('span.a-hs-person__pitch', { id: `${id}-d` }, already ? h('span.a-hs-here', {}, 'Already here · ') : null, m.pitch),
      ),
      box,
      h('span.a-hs-tick', { 'aria-hidden': 'true' }, icon('check', 16)),
    );
  };

  const deptBlock = (d: Department, here: Set<string>, people: TeamMember[]) => {
    const hid = `a-hs-d-${d.replace(/\W+/g, '-').toLowerCase()}`;
    const n = people.filter((m) => picked.has(m.id)).length;
    return h(
      'section.a-hs-dept',
      { 'aria-labelledby': hid },
      h('h3.a-hs-dept__head', { id: hid }, h('span.a-hs-dept__icon', { 'aria-hidden': 'true' }, DEPARTMENT_ICON[d]), h('span', {}, d), n ? h('span.a-hs-dept__n.a-num', {}, `${n} picked`) : null),
      h('div.a-hs-list', {}, ...people.map((m) => personRow(m, here))),
    );
  };

  const matches = (m: TeamMember, q: string) => [m.name, m.title, m.pitch, m.group].some((s) => s.toLowerCase().includes(q));

  const renderPeople = () => {
    const here = present();
    const ds = spaceDepts();
    const known = ds.size > 0;
    const q = query.trim().toLowerCase();
    // Everyone who works here is here already: the rest of the team comes straight up, this space's own last.
    const full = known && TEAM.filter((m) => ds.has(m.group)).every((m) => here.has(m.id));
    const everyone = showAll || !known || !!q || full;
    const depts = full && !q ? [...DEPARTMENTS.filter((d) => !ds.has(d)), ...DEPARTMENTS.filter((d) => ds.has(d))] : everyone ? [...DEPARTMENTS.filter((d) => ds.has(d)), ...DEPARTMENTS.filter((d) => !ds.has(d))] : DEPARTMENTS.filter((d) => ds.has(d));
    const blocks = depts
      .map((d) => {
        const people = TEAM.filter((m) => m.group === d && (!q || matches(m, q)));
        return people.length ? deptBlock(d, here, people) : null;
      })
      .filter((x): x is HTMLElement => !!x);
    peopleEl.replaceChildren(
      ...(full && !q ? [h('p.a-hs-note', {}, `Everyone who works in ${space} is already here. Anyone from the rest of the team can join too.`)] : []),
      ...(blocks.length ? blocks : [h('p.a-hs-note', {}, `No one on the team matches “${query.trim()}”.`)]),
    );
    moreBtn.hidden = !known || !!q || full;
    moreBtn.setAttribute('aria-expanded', String(showAll));
    moreBtn.replaceChildren(h('span', {}, showAll ? `Just ${space}’s people` : 'The rest of the team'), icon('down', 18));
    moreBtn.classList.toggle('is-open', showAll);
  };

  const crewCard = (c: Crew, here: Set<string>) => {
    const members = c.members.map((id) => TEAM_BY_ID.get(id)!).filter(Boolean);
    const open = members.filter((m) => !here.has(m.id));
    const hereCount = members.length - open.length;
    const meta = open.length === 0 ? 'Everyone’s already here' : hereCount ? `${plural(open.length, 'teammate')} to add · ${hereCount} already here` : plural(members.length, 'teammate');
    const on = crewId === c.id;
    return h(
      'button.a-hs-crew',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(on),
        'data-crew': c.id,
        'aria-disabled': open.length === 0 ? 'true' : undefined,
        onclick: () => {
          if (open.length === 0) return;
          crewId = on ? undefined : c.id;
          tap();
          renderCrews();
          paint();
        },
      },
      h('span.a-hs-crew__emoji', { 'aria-hidden': 'true' }, c.emoji),
      h(
        'span.a-hs-crew__text',
        {},
        h('span.a-hs-crew__name', {}, c.name),
        h('span.a-hs-crew__blurb', {}, c.blurb),
        h('span.a-hs-crew__foot', {}, h('span.a-hs-crew__faces', { 'aria-hidden': 'true' }, ...members.slice(0, 6).map((m) => avatar({ emoji: m.emoji, color: m.color, name: m.name, status: here.has(m.id) ? 'resting' : undefined }, 24))), h('span.a-hs-crew__meta', {}, meta)),
        h('span.a-sr-only', {}, `: ${namesList(members.map((m) => m.name))}`),
      ),
      h('span.a-hs-crew__mark', { 'aria-hidden': 'true' }, icon('check', 16)),
    );
  };

  const renderCrews = () => {
    const here = present();
    const ds = spaceDepts();
    const mine = CREWS.filter((c) => crewBelongs(c, ds));
    const rest = CREWS.filter((c) => !mine.includes(c));
    const hasRoom = (c: Crew) => c.members.some((id) => !here.has(id));
    // Crews with someone left to add first; crews who are all here already wait at the end.
    const open = mine.filter(hasRoom);
    const others = rest.filter(hasRoom);
    const done = [...mine, ...rest].filter((c) => !hasRoom(c));
    const section = (title: string, list: Crew[]) => (list.length ? [h('h3.a-hs-h', {}, title), h('div.a-hs-crewlist', {}, ...list.map((c) => crewCard(c, here)))] : []);
    crewsEl.replaceChildren(
      ...(mine.length && !open.length ? [h('p.a-hs-note', {}, `Every one of ${space}’s crews is already here. Another crew can join too.`)] : []),
      ...section(`${space}’s crews`, open),
      ...section(open.length ? 'Other crews' : 'Crews', others),
      ...section('Already here', done),
    );
  };

  const renderTune = (p: Plan) => {
    const single = p.single;
    const m = single && single !== 'helper' ? single : undefined;
    tune.hidden = !single || (asleep && single !== 'helper');
    if (tune.hidden) return;
    // The provider choice only when the office offers more than one engine.
    providerHost.replaceChildren();
    if (providers.length > 1) {
      const pr = pillRadio<AgentProvider>({
        name: 'provider',
        label: 'Engine',
        value: provider,
        items: providers.map((v) => ({ value: v, label: PROVIDER_LABEL[v] })),
        onChange: (v) => {
          provider = v;
          paint();
        },
      });
      providerHost.append(h('span.a-hs-tune__name', {}, 'Engine'), pr.el);
    }
    modelHost.replaceChildren();
    effortHost.replaceChildren();
    if (provider === 'opencode') {
      const inp = h('input.a-field__control', { type: 'text', value: openModel, placeholder: 'provider/model (optional)', 'aria-label': 'OpenCode model', autocomplete: 'off' }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        openModel = inp.value.trim();
        paintFoot(plan());
      });
      modelHost.append(h('span.a-hs-tune__name', {}, 'Model'), inp);
      tuneSummary.textContent = openModel || 'OpenCode’s own';
      tuneNote.textContent = '';
      return;
    }
    if (provider !== 'claude') {
      tuneSummary.textContent = PROVIDER_LABEL[provider];
      tuneNote.textContent = '';
      return;
    }
    const mv = model || m?.model || '';
    const ev = effort || m?.effort || '';
    const mp = pillRadio<ClaudeModel | ''>({
      name: 'model',
      label: 'Model',
      value: mv,
      items: [...(m ? [] : [{ value: '' as const, label: 'Usual' }]), ...CLAUDE_MODELS.map((x) => ({ value: x, label: shortModel(x), note: m?.model === x ? 'usual' : undefined }))],
      onChange: (v) => {
        model = v;
        paint();
      },
    });
    const ep = pillRadio<AgentEffort | ''>({
      name: 'effort',
      label: 'Effort',
      value: ev,
      items: [...(m ? [] : [{ value: '' as const, label: 'Usual' }]), ...AGENT_EFFORTS.map((x) => ({ value: x, label: EFFORT_LABEL[x], note: m?.effort === x ? 'usual' : undefined }))],
      onChange: (v) => {
        effort = v;
        paint();
      },
    });
    modelHost.append(h('span.a-hs-tune__name', {}, 'Model'), mp.el);
    effortHost.append(h('span.a-hs-tune__name', {}, 'Effort'), ep.el);
    const own = m && (!model || model === m.model) && (!effort || effort === m.effort);
    tuneSummary.textContent = mv ? `${shortModel(mv)} · ${ev ? EFFORT_LABEL[ev].toLowerCase() : 'usual'}${own ? ' (their usual)' : ''}` : 'The office’s usual';
    tuneNote.textContent = m ? `${m.name} usually thinks with ${CLAUDE_MODEL_LABEL[m.model]} at ${EFFORT_LABEL[m.effort].toLowerCase()} effort. Opus weighs things most carefully; Haiku is quickest and lightest.` : 'Opus weighs things most carefully; Haiku is quickest and lightest.';
  };

  const paintSeats = () => {
    const r = room();
    const m = ctx.store.machine;
    const total = SEATS.length;
    const used = total - r.free;
    const pct = Math.round((used / total) * 100);
    seats.replaceChildren(
      h('span.a-hs-seats__icon', { 'aria-hidden': 'true' }, glyph('seat', 18)),
      h(
        'span.a-hs-seats__text',
        {},
        h('span.a-hs-seats__main', {}, r.free ? `${plural(r.free, 'seat')} free` : 'No seats free', h('span.a-hs-seats__of', {}, ` of ${total} in ${space}`)),
        m.limit !== undefined ? h('span.a-hs-seats__machine', {}, `This computer runs up to ${m.limit} · ${m.workers} running now`) : null,
      ),
      h('span.a-hs-seats__bar', { 'aria-hidden': 'true', style: `--p:${pct}%` }),
    );
    seats.classList.toggle('is-full', r.room <= 0);
    if (m.pressure) {
      warnEl.hidden = false;
      warnEl.replaceChildren(icon('warning', 18), h('span', {}, `This computer is busy right now (${m.pressure}). Another teammate may slow the others down.`));
    } else warnEl.hidden = true;
  };

  const paintFoot = (p: Plan) => {
    const label = addBtn.querySelector('.a-btn__label')!;
    label.textContent = p.label;
    const blocked = !!p.blocked || !p.msg;
    addBtn.setAttribute('aria-disabled', String(blocked));
    if (blocked) addBtn.setAttribute('aria-describedby', 'a-hs-reason');
    else addBtn.removeAttribute('aria-describedby');
    who.replaceChildren(
      p.single === 'helper' ? h('span.a-hs-who__empty.is-helper', {}, glyph('helper', 20)) : p.people.length ? (p.people.length === 1 ? avatar(p.people[0].emoji ? { emoji: p.people[0].emoji, color: p.people[0].color, name: p.people[0].name } : { name: p.people[0].name }, 40) : avatarStack(p.people.map((x, i) => ({ id: String(i), name: x.name, color: x.color ?? '', emoji: x.emoji, status: 'idle', acked: true })), 3)) : h('span.a-hs-who__empty', {}, glyph('helper', 20)),
    );
    who.classList.toggle('is-many', p.people.length > 1);
    who.dataset.more = p.people.length > 3 ? `+${p.people.length - 3}` : '';
    const how = p.single === 'helper' || !asleep ? 'They’ll start right away.' : 'They’ll sit down asleep until you wake them.';
    const here = present();
    const again = mode === 'people' ? TEAM.filter((m) => picked.has(m.id) && here.has(m.id)).map((m) => m.name) : [];
    const twice = again.length ? ` ${namesList(again)} ${again.length === 1 ? 'is' : 'are'} already here, so this adds a second.` : '';
    reason.textContent = p.blocked ?? (p.people.length > 1 && p.people.length <= 4 ? `${namesList(p.people.map((x) => x.name))}. ${how}` : p.people.length > 4 ? `${namesList(p.people.slice(0, 3).map((x) => x.name))} and ${p.people.length - 3} more. ${how}` : how) + (p.blocked ? '' : twice);
    reason.classList.toggle('is-blocked', !!p.blocked && p.count > 0);
  };

  /** Everything that follows the picks: the boxes, the options' words, the footer. */
  const paint = () => {
    session(pickKey(floor), picked.size ? JSON.stringify([...picked]) : '');
    for (const row of peopleEl.querySelectorAll<HTMLElement>('.a-hs-person')) {
      const on = picked.has(row.dataset.id!);
      row.toggleAttribute('data-on', on);
      const box = row.querySelector<HTMLInputElement>('.a-hs-box');
      if (box) box.checked = on;
    }
    for (const sec of peopleEl.querySelectorAll<HTMLElement>('.a-hs-dept')) {
      const n = [...sec.querySelectorAll<HTMLElement>('.a-hs-person[data-on]')].length;
      let tag = sec.querySelector<HTMLElement>('.a-hs-dept__n');
      if (n && !tag) sec.querySelector('.a-hs-dept__head')!.append((tag = h('span.a-hs-dept__n.a-num')));
      if (tag) {
        if (n) tag.textContent = `${n} picked`;
        else tag.remove();
      }
    }
    for (const p of [peoplePanel, crewsPanel, helperPanel]) p.hidden = p.dataset.mode !== mode;

    const p = plan();
    // Asleep: a helper can't be (the office seats only roster teammates asleep).
    const helper = mode === 'helper';
    asleepRow.box.checked = asleep && !helper;
    asleepRow.box.disabled = helper;
    asleepSub.textContent = helper
      ? 'A helper starts right away.'
      : asleep && msg.value.trim()
        ? 'Asleep teammates don’t get the first message. Turn this off to send it.'
        : asleep
          ? 'They take a seat, and nothing runs (or costs anything) until you wake them.'
          : 'They start right away and say hello, or get to work on your message.';
    asleepRow.row.classList.toggle('is-warn', asleep && !helper && !!msg.value.trim());
    wtRow.box.checked = worktree;
    wtSub.textContent = p.single || helper ? 'Works in a separate copy of the code (a git worktree), so parallel work never collides.' : 'Each gets a separate copy of the code, when you give them a first message.';
    msg.placeholder =
      helper ? 'What should they start on?' : p.count === 1 && p.single && p.single !== 'helper' ? `What should ${p.single.name} start on?` : p.count > 1 ? 'One job for everyone: each takes the part that fits their role.' : 'What should they start on?';
    msgHint.textContent = msg.value.trim() ? '' : 'Leave it empty and they say hello and wait.';
    renderTune(p);
    paintFoot(p);
    paintSeats();
  };

  const render = () => {
    if (mode === 'people') renderPeople();
    if (mode === 'crews') renderCrews();
    paint();
  };

  // ---- Wiring --------------------------------------------------------------------------------------
  search.addEventListener('input', () => {
    query = search.value;
    renderPeople();
    paint();
  });
  moreBtn.addEventListener('click', () => {
    showAll = !showAll;
    const y = moreBtn.getBoundingClientRect().top;
    renderPeople();
    paint();
    // Keep the button under her thumb as the list above it grows or shrinks.
    if (!showAll) moreBtn.scrollIntoView({ block: 'nearest' });
    else body.scrollBy({ top: moreBtn.getBoundingClientRect().top - y });
    moreBtn.focus({ preventScroll: true });
  });
  job.addEventListener('input', () => paint());
  msg.addEventListener('input', () => {
    session(msgKey(floor), msg.value);
    // Writing a first message means she wants them to start: wake the idea up unless she chose asleep.
    if (msg.value.trim() && !asleepTouched && asleep) asleep = false;
    if (!msg.value.trim() && !asleepTouched) asleep = true;
    paint();
  });
  asleepRow.box.addEventListener('change', () => {
    asleep = asleepRow.box.checked;
    asleepTouched = true;
    tap();
    paint();
  });
  wtRow.box.addEventListener('change', () => {
    worktree = wtRow.box.checked;
    tap();
    paint();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = plan();
    if (p.blocked || !p.msg) {
      reason.classList.add('is-blocked');
      reason.textContent = p.blocked ?? 'Pick a teammate, a crew or a helper.';
      return;
    }
    ctx.net.send(p.msg);
    if (onGit) {
      try {
        localStorage.setItem(WT_KEY, worktree ? '1' : '0');
      } catch {
        // storage blocked
      }
    }
    session(pickKey(floor), '');
    session(msgKey(floor), '');
    tap(12);
    ctx.toast(p.toast);
    close();
  });

  render();
  // A single pick or a pick from Reports opens on People; nothing picked on a space with crews of its own opens on Crews.
  const off = onTeam(() => {
    const key = [...present()].sort().join(',');
    if (key !== hereKey) {
      hereKey = key;
      render();
    } else paintSeats();
  });
  let hereKey = [...present()].sort().join(',');
  const offWorkers = ctx.on('workers', () => paint());
  const offMachine = ctx.on('machine', () => paintSeats());

  return () => {
    off();
    offWorkers();
    offMachine();
  };
};
