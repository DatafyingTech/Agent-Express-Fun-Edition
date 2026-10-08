// Call a meeting (route #/space/<floor>/group): a sheet over the space, with everything the 3D
// office's form has (ui/meeting.ts meetingForm), laid out for a thumb:
//
//   how they meet (a card per pattern, in plain words) · what it's about · who sits at the table
//   (a big avatar picker per chair, crews and "everyone awake" to fill the table, each chair's
//   optional job) · the PR for a review, the parts for divide & combine · rounds and the token
//   budget · and, folded away, the title, provider / model / effort and the output file.
//
// The sticky Start button says who's coming. A chair with nobody picked gets a general helper, named
// by its job, and Start asks first ("Start with general helpers?"), as the 3D office does. It sends
// exactly the 3D office's meeting.start (checked against server/meetings.ts start()).
//
// The shell opens the sheet and hands this view its root; closing = back to the space (Esc, the
// scrim, a swipe or the close button). What she's filled in is kept for the tab (sessionStorage), so
// closing by mistake loses nothing.

import { filePicker } from '../filepicker';
import type { View } from '../context';
import type { AgentEffort, AgentProvider, ClaudeModel, MeetingPattern, MeetingRequest, WorkerInfo } from '../../../shared/protocol';
import { AGENT_EFFORTS, CLAUDE_MODELS, fmtTokens } from '../../../shared/protocol';
import { MAX_MEETING_BUDGET, MEETING_PATTERNS, MEETING_PATTERN_IDS, TOKENS_PER_SEAT, outputProblem, slugify } from '../../../shared/meetings';
import { CREWS, DEPARTMENTS, DEPARTMENT_ICON, TEAM, TEAM_BY_ID, type Crew, type Department, type TeamMember } from '../../../shared/team';
import { CLAUDE_MODEL_LABEL, EFFORT_LABEL, PROVIDER_LABEL, resolvedProvider, supportedProviders } from '../../ui/provider';
import { icon } from '../icons';
import { avatar, confirmDialog, h, iconButton, isResting, onTeam, plural, spaceName, teamOn, uiStatus, type TeamEntry } from '../ui';
import { PATTERN_WORDS, btn, buzz, glyph, namesList, patternBounds, patternTile } from './meetings';
import { edition } from '../../../shared/edition';

// ---- What's kept between openings (this tab only) ---------------------------------------------------

interface Draft {
  pattern: MeetingPattern;
  topic: string;
  title: string;
  roles: string[];
  members: string[];
  rounds?: number;
  parts: string;
}

const draftKey = (floor: string) => `hearth.mtg.draft.${floor}`;

function loadDraft(floor: string): Partial<Draft> {
  try {
    const v = JSON.parse(sessionStorage.getItem(draftKey(floor)) ?? 'null');
    if (!v || typeof v !== 'object') return {};
    const strs = (x: unknown) => (Array.isArray(x) ? x.map((s) => (typeof s === 'string' ? s : '')) : undefined);
    return {
      pattern: MEETING_PATTERN_IDS.includes(v.pattern) ? v.pattern : undefined,
      topic: typeof v.topic === 'string' ? v.topic : undefined,
      title: typeof v.title === 'string' ? v.title : undefined,
      roles: strs(v.roles),
      members: strs(v.members)?.map((m) => (TEAM_BY_ID.has(m) ? m : '')),
      rounds: typeof v.rounds === 'number' ? v.rounds : undefined,
      parts: typeof v.parts === 'string' ? v.parts : undefined,
    };
  } catch {
    return {};
  }
}

function saveDraft(floor: string, d: Draft | null) {
  try {
    if (d) sessionStorage.setItem(draftKey(floor), JSON.stringify(d));
    else sessionStorage.removeItem(draftKey(floor));
  } catch {
    // storage blocked
  }
}

/** The pattern a "Ways to meet" card asked for (read once). */
function takeAskedPattern(floor: string): MeetingPattern | undefined {
  try {
    const k = `hearth.mtg.pattern.${floor}`;
    const v = sessionStorage.getItem(k);
    sessionStorage.removeItem(k);
    return v && MEETING_PATTERN_IDS.includes(v as MeetingPattern) ? (v as MeetingPattern) : undefined;
  } catch {
    return undefined;
  }
}

// ---- The provider rules of ui/provider.ts, remembered under the same keys as the 3D office's meeting form -----

const PROVIDER_KEY = 'agent-office.provider';
const choiceKey = (kind: 'model' | 'effort') => `agent-office.claude-${kind}.meeting`;
const readLocal = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLocal = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // storage blocked
  }
};

/** An OpenCode provider/model id, as ui/provider.ts checks it. */
function validModel(value: string): boolean {
  if (value.length === 0 || value.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.length >= 2 && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(parts[0]) && parts.slice(1).every((p) => p.length > 0);
}

/** Budget steps for the slider, in tokens: fine at the bottom, coarse at the top. */
const BUDGET_STEPS: number[] = (() => {
  const out: number[] = [];
  for (let v = 250_000; v < 2_000_000; v += 250_000) out.push(v);
  for (let v = 2_000_000; v < 10_000_000; v += 500_000) out.push(v);
  for (let v = 10_000_000; v <= MAX_MEETING_BUDGET; v += 1_000_000) out.push(v);
  return out;
})();
const nearestStep = (v: number) => BUDGET_STEPS.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(BUDGET_STEPS[best] - v) ? i : best), 0);

export const meetingView: View = (root, ctx, route) => {
  if (!('floor' in route)) return;
  const floor = route.floor;
  const store = ctx.store;
  const offs: (() => void)[] = [];
  const close = () => ctx.go({ view: 'space', floor });

  // ---- State ---------------------------------------------------------------------------------------
  const draft = loadDraft(floor);
  // A conversation is the default; a half-written structured meeting opens as she left it.
  let pattern: MeetingPattern = takeAskedPattern(floor) ?? (draft.topic?.trim() ? draft.pattern : undefined) ?? 'talk';
  if (pattern === 'review' && !store.project?.remote) pattern = 'debate';
  const def = () => MEETING_PATTERNS[pattern];
  const isTalk = () => pattern === 'talk';
  /** The structured pattern to go to from a conversation: the last one she used, else a debate. */
  let lastStructured: MeetingPattern = draft.pattern && draft.pattern !== 'talk' ? draft.pattern : 'debate';
  let roles: string[];
  /** Who sits in each chair: a roster id, or '' for a general helper. */
  let members: string[];
  if (isTalk()) {
    // A conversation starts with nobody at the table: she picks who's coming (helpers only on purpose).
    const keep = draft.pattern === 'talk' ? (draft.members ?? []).map((id, i) => ({ id, role: draft.roles?.[i] ?? '' })).filter((x) => x.id || x.role === 'Helper') : [];
    members = keep.slice(0, MEETING_PATTERNS.talk.seats.max).map((x) => x.id);
    roles = members.map((id) => (id ? '' : 'Helper'));
  } else {
    const startCount = Math.max(def().seats.min, Math.min(def().seats.max, draft.roles?.length || def().seats.default));
    roles = Array.from({ length: startCount }, (_, i) => draft.roles?.[i] ?? def().roles[i] ?? `Worker ${i + 1}`);
    members = Array.from({ length: startCount }, (_, i) => draft.members?.[i] ?? '');
  }
  let rounds = Math.max(def().rounds.min, Math.min(def().rounds.max, draft.rounds ?? def().rounds.default));
  let active: number | null = null;
  let everyone = false;
  let outputTouched = false;
  let budgetTouched = false;
  let prPick = 0;

  const persist = () => saveDraft(floor, { pattern, topic: topic.value, title: titleIn.value, roles, members, rounds, parts: partsIn.value });

  // ---- Who can sit down ------------------------------------------------------------------------------
  /** Teammates on this floor from the roster, one per roster member (their live copy for the rings). */
  const hereMates = (): Map<string, TeamEntry> => {
    const out = new Map<string, TeamEntry>();
    for (const w of teamOn(floor)) if (w.role && TEAM_BY_ID.has(w.role) && w.kind !== 'shell' && !out.has(w.role)) out.set(w.role, w);
    return out;
  };
  /** The departments that work on this floor: its crews', and its teammates'. */
  const floorDepts = (here: Map<string, TeamEntry>): Set<Department> => {
    const ds = new Set<Department>();
    for (const c of CREWS) if (c.floor === floor) for (const id of c.members) ds.add(TEAM_BY_ID.get(id)!.group);
    for (const id of here.keys()) ds.add(TEAM_BY_ID.get(id)!.group);
    return ds;
  };
  const crewsHere = (): Crew[] => {
    const ds = floorDepts(hereMates());
    return CREWS.filter((c) => c.floor === floor || (!c.floor && c.members.every((id) => ds.has(TEAM_BY_ID.get(id)!.group))));
  };
  /** Awake on this floor, not at a table already: who "@awake" seats. */
  const awakeIds = (): string[] => [...new Set([...store.workers.values()].filter((w: WorkerInfo) => w.role && TEAM_BY_ID.has(w.role) && w.kind === 'agent' && w.status !== 'offline' && w.status !== 'exited' && !w.meeting).map((w) => w.role!))];

  // ---- The pieces ------------------------------------------------------------------------------------
  const busy = h('div.a-mtg-form__busy', { 'aria-live': 'polite' });
  const patternsEl = h('div.a-mtg-patterns', { role: 'radiogroup', 'aria-labelledby': 'a-mtg-f-how' });
  const patternLine = h('p.a-mtg-form__hint', { 'aria-live': 'polite' });

  const topic = h('textarea.a-field__control.a-mtg-form__topic', {
    id: 'a-mtg-f-topic',
    rows: 3,
    placeholder: 'The question to settle, or the job to do. For example: “Should we hire a part-time designer now, or after the holidays?”',
    autocapitalize: 'sentences',
    spellcheck: 'true',
    maxlength: 20000,
  }) as HTMLTextAreaElement;
  topic.value = draft.topic ?? '';
  // Screenshots and PDFs for the table: a chart, a statement, a page of the plan.
  const files = filePicker({ pasteInto: topic, dropOn: topic, label: 'Add screenshots or PDFs', toast: (t, l) => ctx.toast(t, l) });

  const fillRow = h('div.a-mtg-fill', { role: 'group', 'aria-label': 'Fill the table' });
  const chairsEl = h('div.a-mtg-chairs');
  const chairsNote = h('p.a-mtg-form__hint');

  const prSec = h('section.a-mtg-form__sec', { 'aria-labelledby': 'a-mtg-f-pr' });
  const prList = h('div.a-mtg-prs', { role: 'radiogroup', 'aria-labelledby': 'a-mtg-f-pr' });
  prSec.append(h('h3.a-mtg-form__label', { id: 'a-mtg-f-pr' }, 'Which pull request'), prList);

  const partsIn = h('textarea.a-field__control.a-mtg-form__mono', { id: 'a-mtg-f-parts', rows: 4, spellcheck: 'false', placeholder: 'src/server/\nsrc/client/\nsrc/shared/' }) as HTMLTextAreaElement;
  partsIn.value = draft.parts ?? '';
  const partsNote = h('p.a-mtg-form__hint');
  const partsSec = h('section.a-mtg-form__sec', {}, h('label.a-mtg-form__label', { for: 'a-mtg-f-parts' }, 'The pieces, one per line'), partsIn, partsNote);

  const roundsVal = h('span.a-mtg-stepper__val', { 'aria-live': 'polite' });
  const roundsMinus = h('button.a-mtg-stepper__btn', { type: 'button', 'aria-label': 'One round fewer' }, icon('minus', 18)) as HTMLButtonElement;
  const roundsPlus = h('button.a-mtg-stepper__btn', { type: 'button', 'aria-label': 'One round more' }, icon('add', 18)) as HTMLButtonElement;
  const roundsNote = h('p.a-mtg-form__hint');

  const budgetIn = h('input.a-mtg-range', { type: 'range', min: 0, max: BUDGET_STEPS.length - 1, step: 1, id: 'a-mtg-f-budget', 'aria-label': 'Token budget' }) as HTMLInputElement;
  const budgetVal = h('span.a-mtg-budgetpick__val');
  const budgetNote = h('p.a-mtg-form__hint');
  const budget = () => BUDGET_STEPS[Number(budgetIn.value)] ?? TOKENS_PER_SEAT;

  const titleIn = h('input.a-field__control', { id: 'a-mtg-f-title', type: 'text', maxlength: 100, placeholder: 'The first line of what it’s about', autocapitalize: 'sentences' }) as HTMLInputElement;
  titleIn.value = draft.title ?? '';
  const outputIn = h('input.a-field__control.a-mtg-form__mono', { id: 'a-mtg-f-output', type: 'text', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' }) as HTMLInputElement;
  const outputNote = h('p.a-mtg-form__hint', { id: 'a-mtg-f-output-note' });

  // Provider, model and effort.
  const providers = () => supportedProviders(store.project);
  let provider: AgentProvider = (() => {
    const saved = readLocal(PROVIDER_KEY) as AgentProvider | null;
    const opts = providers();
    return saved && opts.includes(saved) ? saved : resolvedProvider(store.project?.defaultProvider, store.project);
  })();
  let claudeModel = ((): ClaudeModel | '' => {
    const v = readLocal(choiceKey('model'));
    return v && (CLAUDE_MODELS as readonly string[]).includes(v) ? (v as ClaudeModel) : '';
  })();
  let effort = ((): AgentEffort | '' => {
    const v = readLocal(choiceKey('effort'));
    return v && (AGENT_EFFORTS as readonly string[]).includes(v) ? (v as AgentEffort) : '';
  })();
  const providerEl = h('div.a-mtg-provider');
  const openCodeIn = h('input.a-field__control.a-mtg-form__mono', { id: 'a-mtg-f-ocmodel', type: 'text', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: 'provider/model (optional)', maxlength: 256 }) as HTMLInputElement;
  const more = h('details.a-mtg-more') as HTMLDetailsElement;
  const moreSum = h('span.a-mtg-more__sum');

  const whoLine = h('div.a-mtg-foot__who', { 'aria-live': 'polite' });
  const start = btn({ label: 'Start the meeting', variant: 'primary', size: 'lg', block: true, type: 'submit', cls: 'a-mtg-start' }) as HTMLButtonElement;
  const reason = h('p.a-mtg-foot__reason', { id: 'a-mtg-f-reason' });

  // A conversation: who's coming (the people they've picked, and the tiles to pick from), and the
  // opening message. The structured patterns are a step away, under "Or run a structured meeting".
  const talkPeople = h('div.a-mtg-people', { 'aria-live': 'polite' });
  const talkPicker = h('div.a-mtg-picker.a-mtg-picker--talk', { role: 'group', 'aria-label': 'Pick who’s coming' });
  const talkNote = h('p.a-mtg-form__hint');
  const talkSec = h(
    'section.a-mtg-form__sec.a-mtg-talkpick',
    { 'aria-labelledby': 'a-mtg-f-coming' },
    h('div.a-mtg-form__labelrow', {}, h('h3.a-mtg-form__label', { id: 'a-mtg-f-coming' }, 'Who’s coming'), h('span.a-mtg-form__count.a-mtg-talkpick__count', { 'aria-live': 'polite' })),
    talkPeople,
    fillRow,
    talkPicker,
    talkNote,
  );
  const hero = h(
    'div.a-mtg-hero',
    {},
    patternTile('talk', 'lg'),
    h('div.a-mtg-hero__text', {}, h('p.a-mtg-hero__name', {}, 'A conversation'), h('p.a-mtg-hero__line', {}, 'Talk with everyone at the table, or just a few of them. No rounds: it goes on until you end it, and Haiku keeps a shared memory so nobody loses the thread.')),
  );
  const toStructured = h('button.a-mtg-switch', { type: 'button' }, h('span.a-mtg-switch__text', {}, h('b', {}, 'Or run a structured meeting'), h('small', {}, 'Debate, lead & team, divide & combine, red / blue, review')), h('span.a-mtg-switch__chev', { 'aria-hidden': 'true' }, icon('forward', 18)));
  toStructured.addEventListener('click', () => {
    pickPattern(lastStructured === 'review' && !store.project?.remote ? 'debate' : lastStructured);
    form.querySelector('.a-mtg-form__body')?.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  const toTalk = h('button.a-mtg-back', { type: 'button' }, icon('back', 16), h('span', {}, 'A conversation instead'));
  toTalk.addEventListener('click', () => pickPattern('talk'));
  const howSec = h('section.a-mtg-form__sec', { 'aria-labelledby': 'a-mtg-f-how' }, h('div.a-mtg-form__labelrow', {}, h('h3.a-mtg-form__label', { id: 'a-mtg-f-how' }, 'How should they meet?'), toTalk), patternsEl, patternLine);
  const topicLabel = h('label.a-mtg-form__label', { for: 'a-mtg-f-topic' }, 'What’s it about?');
  const topicSec = h('section.a-mtg-form__sec', {}, topicLabel, topic, h('div.a-fp', {}, files.chips, files.button));
  const whoSec = h('section.a-mtg-form__sec', { 'aria-labelledby': 'a-mtg-f-who' }, h('div.a-mtg-form__labelrow', {}, h('h3.a-mtg-form__label', { id: 'a-mtg-f-who' }, 'Who sits at the table'), h('span.a-mtg-form__count.a-mtg-chairs__count', { 'aria-live': 'polite' })), chairsEl, chairsNote);
  const roundsBound = h('div.a-mtg-bound', {}, h('span.a-mtg-form__label', { id: 'a-mtg-f-rounds' }, 'Rounds'), h('div.a-mtg-stepper', { role: 'group', 'aria-labelledby': 'a-mtg-f-rounds' }, roundsMinus, roundsVal, roundsPlus), roundsNote);
  const budgetBound = h('div.a-mtg-bound', {}, h('label.a-mtg-form__label', { for: 'a-mtg-f-budget' }, 'Token budget'), h('div.a-mtg-budgetpick', {}, budgetVal, budgetIn), budgetNote);
  const boundsSec = h('section.a-mtg-form__sec.a-mtg-bounds', {}, roundsBound, budgetBound);
  const moreBody = h(
    'div.a-mtg-more__body',
    {},
    h('div.a-mtg-form__field', {}, h('label.a-mtg-form__label', { for: 'a-mtg-f-title' }, 'Title (optional)'), titleIn),
    providerEl,
    h('div.a-mtg-form__field', {}, h('label.a-mtg-form__label', { for: 'a-mtg-f-output' }, 'The file it writes'), outputIn, outputNote),
  );

  const form = h(
    'form.a-mtg-form',
    { 'aria-labelledby': 'a-mtg-f-title-h', novalidate: true },
    h(
      'header.a-sheet__head.a-mtg-form__head',
      {},
      h('div.a-mtg-form__titles', {}, h('h2.a-sheet__title.a-mtg-form__title', { id: 'a-mtg-f-title-h' }, 'Call a meeting'), h('p.a-mtg-form__sub', {}, `In the ${spaceName(floor)} meeting room`)),
      iconButton('close', 'Close', close),
    ),
    h('div.a-sheet__body.a-mtg-form__body', {}, busy, hero, howSec, talkSec, topicSec, prSec, partsSec, whoSec, boundsSec, h('section.a-mtg-form__sec', {}, more), toStructured),
    h('footer.a-sheet__foot.a-mtg-foot', {}, whoLine, start, reason),
  ) as HTMLFormElement;
  // The chairs' fill row belongs to whichever "who" section is showing.
  whoSec.insertBefore(fillRow, chairsEl);
  more.append(h('summary', {}, h('span.a-mtg-more__title', {}, 'More options'), moreSum, h('span.a-mtg-more__chev', { 'aria-hidden': 'true' }, icon('down', 18))), moreBody);
  root.replaceChildren(form);

  /** Shows a conversation's form or a structured meeting's, and moves the shared pieces to match. */
  const layout = () => {
    const talk = isTalk();
    hero.hidden = !talk;
    toStructured.hidden = !talk;
    talkSec.hidden = !talk;
    howSec.hidden = talk;
    whoSec.hidden = talk;
    roundsBound.hidden = talk;
    // Rounds don't apply to a conversation, so its budget goes under More options.
    if (talk && budgetBound.parentElement !== moreBody) moreBody.prepend(budgetBound);
    if (!talk && budgetBound.parentElement !== boundsSec) boundsSec.append(budgetBound);
    boundsSec.hidden = talk;
    if (talk && fillRow.parentElement !== talkSec) talkSec.insertBefore(fillRow, talkPicker);
    if (!talk && fillRow.parentElement !== whoSec) whoSec.insertBefore(fillRow, chairsEl);
    topicLabel.textContent = talk ? 'Your opening message' : 'What’s it about?';
    topic.placeholder = talk ? 'Say what you want to talk through. Everyone at the table answers, and then you can talk to all of them or just a few.' : 'The question to settle, or the job to do. For example: “Should we hire a part-time designer now, or after the holidays?”';
    (start.querySelector('.a-btn__label') as HTMLElement).dataset.talk = String(talk);
  };

  // ---- Patterns ------------------------------------------------------------------------------------
  // The carousel is the structured meetings; a conversation has its own form.
  const visiblePatterns = () => MEETING_PATTERN_IDS.filter((p) => p !== 'talk' && (p !== 'review' || !!store.project?.remote || pattern === 'review'));
  let patternBtns: HTMLButtonElement[] = [];
  const renderPatterns = () => {
    patternBtns = visiblePatterns().map((p) => {
      const b = h(
        'button.a-mtg-pattern',
        { type: 'button', role: 'radio', 'data-pattern': p },
        h('span.a-mtg-pattern__top', {}, patternTile(p, 'md'), h('span.a-mtg-pattern__check', { 'aria-hidden': 'true' }, icon('check', 14))),
        h('span.a-mtg-pattern__name', {}, PATTERN_WORDS[p].name),
        h('span.a-mtg-pattern__short', {}, PATTERN_WORDS[p].short),
        h('span.a-mtg-pattern__meta', {}, patternBounds(p)),
      ) as HTMLButtonElement;
      b.addEventListener('click', () => pickPattern(p));
      return b;
    });
    patternsEl.replaceChildren(...patternBtns);
  };
  patternsEl.addEventListener('keydown', (e) => {
    const list = visiblePatterns();
    const i = list.indexOf(pattern);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    pickPattern(list[(i + d + list.length) % list.length]);
    patternBtns[list.indexOf(pattern)]?.focus();
  });

  const pickPattern = (p: MeetingPattern) => {
    const was = def();
    const fromTalk = isTalk();
    pattern = p;
    const d = def();
    if (p !== 'talk') lastStructured = p;
    if (p === 'talk') {
      // Into a conversation: the people she picked come along; the empty chairs don't.
      members = members.filter(Boolean).slice(0, d.seats.max);
      roles = members.map(() => '');
    } else {
      // Keep who she picked; grow or shrink the table to fit, and swap in the new pattern's jobs where
      // a chair still had the old one's (a conversation's chairs have no jobs).
      const n = Math.max(d.seats.min, Math.min(d.seats.max, roles.length));
      roles = Array.from({ length: n }, (_, i) => {
        const r = roles[i];
        return fromTalk || r === undefined || !r.trim() || r === was.roles[i] ? (d.roles[i] ?? `Worker ${i + 1}`) : r;
      });
      members = Array.from({ length: n }, (_, i) => members[i] ?? '');
    }
    rounds = Math.max(d.rounds.min, Math.min(d.rounds.max, d.rounds.default));
    if (active !== null && active >= roles.length) active = null;
    persist();
    paint(true);
    // The picked card slides into view on the carousel.
    patternBtns.find((b) => b.dataset.pattern === p)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  // ---- Chairs ------------------------------------------------------------------------------------
  const nameOf = (id: string) => TEAM_BY_ID.get(id)?.name ?? '';

  const fill = (ids: readonly string[], label: string) => {
    const d = def();
    if (!ids.length) return ctx.toast(label === '@awake' ? 'Nobody from the roster is awake here right now. Wake a few, or pick people for each chair.' : 'That crew has nobody in it.', 'warn');
    const n = Math.max(d.seats.min, Math.min(d.seats.max, ids.length));
    if (isTalk()) {
      // A conversation adds them to whoever's already coming.
      const all = [...new Set([...members.filter(Boolean), ...ids])];
      const helpers = members.filter((x) => !x).length;
      members = [...all, ...Array.from({ length: helpers }, () => '')].slice(0, d.seats.max);
      roles = members.map((id) => (id ? '' : 'Helper'));
      if (all.length + helpers > d.seats.max) ctx.toast(`A conversation seats ${d.seats.max} at most: the first ${d.seats.max} are coming.`, 'warn');
      buzz();
      persist();
      paint(true);
      return;
    }
    roles = Array.from({ length: n }, (_, i) => roles[i] ?? d.roles[i] ?? TEAM_BY_ID.get(ids[i] ?? '')?.name ?? `Worker ${i + 1}`);
    members = Array.from({ length: n }, (_, i) => ids[i] ?? '');
    active = null;
    if (ids.length > n) ctx.toast(`${PATTERN_WORDS[pattern].name} seats ${d.seats.max} at most: the first ${n} sit down.`, 'warn');
    buzz();
    persist();
    paint(true);
  };

  const renderFill = () => {
    const awake = awakeIds();
    const chip = (label: (Node | string)[], title: string, onClick: () => void) => h('button.a-mtg-fillchip', { type: 'button', title, onclick: onClick }, ...label);
    fillRow.replaceChildren(
      h('span.a-mtg-fill__label', {}, 'Fill with'),
      chip([h('span.a-mtg-fillchip__dot', { 'aria-hidden': 'true' }), `Everyone awake`, h('span.a-mtg-fillchip__n', {}, String(awake.length))], 'Seat the teammates who are awake here', () => fill(awakeIds(), '@awake')),
      ...crewsHere().map((c) => chip([h('span.a-mtg-fillchip__emoji', { 'aria-hidden': 'true' }, c.emoji), c.name, h('span.a-mtg-fillchip__n', {}, String(c.members.length))], c.blurb, () => fill(c.members, c.name))),
    );
  };

  const chairCard = (i: number, here: Map<string, TeamEntry>) => {
    const d = def();
    const id = members[i];
    const m = id ? TEAM_BY_ID.get(id) : undefined;
    const w = id ? here.get(id) : undefined;
    const job = roles[i] ?? '';
    const open = active === i;
    const face = m
      ? w
        ? avatar({ emoji: m.emoji, color: w.color, name: m.name, status: uiStatus(w) }, 48)
        : avatar({ emoji: m.emoji, color: m.color, name: m.name, status: 'ready' }, 48)
      : h('span.a-mtg-chair__empty', { 'aria-hidden': 'true' }, glyph('users', 22));
    const sub = m ? (w ? (isResting(w) ? 'Resting · wakes up to join' : 'Here now') : m.title) : 'Tap to choose. Nobody picked means a general helper';
    const jobIn = h('input.a-mtg-chair__job', {
      type: 'text',
      value: job,
      maxlength: 40,
      placeholder: d.roles[i] ?? 'Their job at the table (optional)',
      'aria-label': `Chair ${i + 1}’s job at the table (optional)`,
      autocapitalize: 'sentences',
    }) as HTMLInputElement;
    jobIn.addEventListener('input', () => {
      roles[i] = jobIn.value;
      persist();
      paintFoot();
    });
    const whoBtn = h(
      'button.a-mtg-chair__who',
      { type: 'button', 'aria-expanded': String(open), 'aria-controls': `a-mtg-picker-${i}`, 'aria-label': `${i === 0 ? 'Who leads' : `Who sits in chair ${i + 1}`}: ${m ? m.name : 'nobody picked yet'}. Change` },
      h('span.a-mtg-chair__face', {}, face, i === 0 ? h('span.a-mtg-chair__crown', { 'aria-hidden': 'true' }, glyph('crown', 11)) : null),
      h('span.a-mtg-chair__text', {}, h('span.a-mtg-chair__over', {}, i === 0 ? 'Leads' : `Chair ${i + 1}`), h('span.a-mtg-chair__name', {}, m ? m.name : 'Pick someone'), h('span.a-mtg-chair__sub', {}, sub)),
      h('span.a-mtg-chair__chev', { 'aria-hidden': 'true' }, icon('down', 18)),
    );
    whoBtn.addEventListener('click', () => {
      active = open ? null : i;
      paint();
      if (active !== null) (chairsEl.querySelector(`#a-mtg-picker-${i} .a-mtg-tile[aria-pressed="true"], #a-mtg-picker-${i} .a-mtg-tile`) as HTMLElement | null)?.focus({ preventScroll: true });
      chairsEl.querySelector(`[data-chair="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    const remove =
      roles.length > d.seats.min
        ? iconButton('close', `Remove chair ${i + 1}`, () => {
            roles.splice(i, 1);
            members.splice(i, 1);
            if (active === i) active = null;
            else if (active !== null && active > i) active--;
            persist();
            paint(true);
          }, 18)
        : null;
    remove?.classList.add('a-mtg-chair__remove');
    return h(
      'div.a-mtg-chair',
      { 'data-chair': i, 'data-open': open ? 'true' : undefined, 'data-empty': m ? undefined : 'true', style: `--i:${Math.min(i, 5)}` },
      h('div.a-mtg-chair__main', {}, whoBtn, remove),
      h('div.a-mtg-chair__jobrow', {}, h('span.a-mtg-chair__joblabel', { 'aria-hidden': 'true' }, 'Job'), jobIn),
      open ? picker(i, here) : null,
    );
  };

  /** The big avatar picker under a chair: this floor's people first, then their departments', then (on request) everyone. */
  const picker = (i: number, here: Map<string, TeamEntry>) => {
    const ds = floorDepts(here);
    const seatedAt = new Map(members.map((id, j) => [id, j] as const).filter(([id]) => !!id));
    const tile = (m: TeamMember | null) => {
      const on = m ? members[i] === m.id : !members[i];
      const w = m ? here.get(m.id) : undefined;
      const elsewhere = m ? seatedAt.get(m.id) : undefined;
      const face = m ? (w ? avatar({ emoji: m.emoji, color: w.color, name: m.name, status: uiStatus(w) }, 48) : avatar({ emoji: m.emoji, color: m.color, name: m.name, status: 'ready' }, 48)) : h('span.a-mtg-tile__helper', {}, glyph('dice', 22));
      const note = m ? (elsewhere !== undefined && elsewhere !== i ? (elsewhere === 0 ? 'Leading' : `In chair ${elsewhere + 1}`) : w ? (isResting(w) ? 'Resting' : 'Awake') : '') : 'Anyone';
      const b = h(
        'button.a-mtg-tile',
        { type: 'button', 'aria-pressed': String(on), 'data-away': elsewhere !== undefined && elsewhere !== i ? 'true' : undefined, title: m ? `${m.name}: ${m.title}` : 'A general helper, not one of your teammates' },
        h('span.a-mtg-tile__face', {}, face, on ? h('span.a-mtg-tile__on', { 'aria-hidden': 'true' }, icon('check', 12)) : null),
        h('span.a-mtg-tile__name', {}, m ? m.name : 'A helper'),
        note ? h('span.a-mtg-tile__note', {}, note) : null,
      );
      b.addEventListener('click', () => {
        const id = m?.id ?? '';
        // Someone sits in one chair at a time: taking them here frees their other chair.
        if (id) members = members.map((x, j) => (x === id && j !== i ? '' : x));
        members[i] = id;
        // A helper is named by their job, so an empty job gets the pattern's back.
        if (!roles[i]?.trim()) roles[i] = def().roles[i] ?? `Worker ${i + 1}`;
        // On to the next chair nobody's picked for, else close.
        const next = members.findIndex((x, j) => j > i && !x);
        active = id && next >= 0 ? next : null;
        buzz();
        persist();
        paint();
        const focus = active !== null ? chairsEl.querySelector<HTMLElement>(`#a-mtg-picker-${active} .a-mtg-tile`) : chairsEl.querySelector<HTMLElement>(`[data-chair="${i}"] .a-mtg-chair__who`);
        focus?.focus({ preventScroll: true });
        if (active !== null) chairsEl.querySelector(`[data-chair="${active}"]`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      });
      return b;
    };
    const onFloor = [...here.keys()].map((id) => TEAM_BY_ID.get(id)!).sort((a, b) => Number(isResting(here.get(a.id)!)) - Number(isResting(here.get(b.id)!)));
    const onFloorIds = new Set(onFloor.map((m) => m.id));
    const dept = TEAM.filter((m) => ds.has(m.group) && !onFloorIds.has(m.id));
    const shown = new Set([...onFloorIds, ...dept.map((m) => m.id)]);
    const groups: HTMLElement[] = [];
    groups.push(h('div.a-mtg-picker__grid', {}, tile(null), ...onFloor.map(tile)));
    if (dept.length) groups.push(h('p.a-mtg-picker__group', {}, onFloor.length ? 'Also on the team' : 'The team'), h('div.a-mtg-picker__grid', {}, ...dept.map(tile)));
    if (everyone) {
      for (const g of DEPARTMENTS) {
        const people = TEAM.filter((m) => m.group === g && !shown.has(m.id));
        if (people.length) groups.push(h('p.a-mtg-picker__group', {}, `${DEPARTMENT_ICON[g]} ${g}`), h('div.a-mtg-picker__grid', {}, ...people.map(tile)));
      }
    }
    const others = TEAM.filter((m) => !shown.has(m.id)).length;
    const toggle = others
      ? btn({
          label: everyone ? 'Just this team' : `Everyone in the building (${others} more)`,
          variant: 'ghost',
          size: 'sm',
          cls: 'a-mtg-picker__all',
          onClick: () => {
            everyone = !everyone;
            paint();
          },
        })
      : null;
    return h('div.a-mtg-picker', { id: `a-mtg-picker-${i}`, role: 'group', 'aria-label': i === 0 ? 'Who leads' : `Who sits in chair ${i + 1}` }, ...groups, toggle);
  };

  const renderChairs = () => {
    const d = def();
    const here = hereMates();
    const focusedJob = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('a-mtg-chair__job') ? (document.activeElement.closest('.a-mtg-chair') as HTMLElement | null)?.dataset.chair : undefined;
    const cards = roles.map((_, i) => chairCard(i, here));
    const add =
      roles.length < d.seats.max
        ? h(
            'button.a-mtg-addchair',
            {
              type: 'button',
              onclick: () => {
                roles.push(d.roles[roles.length] ?? `Worker ${roles.length + 1}`);
                members.push('');
                active = roles.length - 1;
                persist();
                paint(true);
                chairsEl.querySelector(`[data-chair="${active}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              },
            },
            icon('add', 18),
            'Add a chair',
          )
        : null;
    chairsEl.replaceChildren(...cards, ...(add ? [add] : []));
    if (focusedJob !== undefined) {
      const el = chairsEl.querySelector<HTMLInputElement>(`[data-chair="${focusedJob}"] .a-mtg-chair__job`);
      if (el) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    chairsNote.textContent = d.seats.min === d.seats.max ? `This one seats exactly ${d.seats.min}. The lead (the first chair) writes it up.` : `${d.seats.min} to ${d.seats.max} chairs. The lead, in the first chair, writes it up. Each teammate brings their own model and brief.`;
    (form.querySelector('.a-mtg-chairs__count') as HTMLElement).textContent = `${roles.length} of ${d.seats.max}`;
    // Everyone at the table is a running teammate: say so when the office's limit would turn some away.
    const mc = ctx.store.machine;
    if (mc.limit !== undefined && roles.length > Math.max(0, mc.limit - mc.workers)) {
      chairsNote.textContent += ` Heads up: this computer runs up to ${mc.limit} teammates at once and ${mc.workers} ${mc.workers === 1 ? 'is' : 'are'} running, so send some home first or seat fewer.`;
    }
    if (roles.length > 5 && edition.has3d) chairsNote.textContent += ' In the 3D office the table has five chairs; everyone past that takes part without a seat you can see.';
  };

  /**
   * A conversation's people: who's coming, as faces she can take off again, then the same tiles as a
   * chair's picker, except that each tap adds or takes away someone (no chairs, no jobs).
   */
  const renderTalk = () => {
    const d = def();
    const here = hereMates();
    const ds = floorDepts(here);
    const face = (m: TeamMember, size: 40 | 48) => {
      const w = here.get(m.id);
      return w ? avatar({ emoji: m.emoji, color: w.color, name: m.name, status: uiStatus(w) }, size) : avatar({ emoji: m.emoji, color: m.color, name: m.name, status: 'ready' }, size);
    };
    const full = members.length >= d.seats.max;
    // Who's coming.
    talkPeople.replaceChildren(
      ...(members.length
        ? members.map((id, i) => {
            const m = id ? TEAM_BY_ID.get(id) : undefined;
            const b = h(
              'button.a-mtg-person',
              { type: 'button', 'aria-label': `Take ${m ? m.name : 'the helper'} off the list`, title: 'Take off the list', style: `--i:${Math.min(i, 5)}` },
              h('span.a-mtg-person__face', {}, m ? face(m, 48) : h('span.a-mtg-tile__helper', {}, glyph('dice', 22)), h('span.a-mtg-person__x', { 'aria-hidden': 'true' }, icon('close', 10))),
              h('span.a-mtg-person__name', {}, m ? m.name : 'A helper'),
            );
            b.addEventListener('click', () => {
              members.splice(i, 1);
              roles.splice(i, 1);
              buzz();
              persist();
              paint();
            });
            return b;
          })
        : [h('p.a-mtg-people__none', {}, h('span.a-mtg-people__ring', { 'aria-hidden': 'true' }, glyph('users', 20)), 'Nobody yet. Tap people below, or fill the table with a crew.')]),
    );
    // The tiles: this floor's people first, then their departments', then (on request) everyone.
    const tile = (m: TeamMember | null) => {
      const on = m ? members.includes(m.id) : false;
      const w = m ? here.get(m.id) : undefined;
      const note = m ? (w ? (isResting(w) ? 'Resting' : 'Awake') : '') : 'Add one';
      const b = h(
        'button.a-mtg-tile',
        { type: 'button', 'aria-pressed': m ? String(on) : undefined, 'aria-disabled': !on && full ? 'true' : undefined, title: m ? `${m.name}: ${m.title}` : 'A general helper, not one of your teammates' },
        h('span.a-mtg-tile__face', {}, m ? face(m, 48) : h('span.a-mtg-tile__helper', {}, glyph('dice', 22)), on ? h('span.a-mtg-tile__on', { 'aria-hidden': 'true' }, icon('check', 12)) : null),
        h('span.a-mtg-tile__name', {}, m ? m.name : 'A helper'),
        note ? h('span.a-mtg-tile__note', {}, note) : null,
      );
      b.addEventListener('click', () => {
        if (m && on) {
          const i = members.indexOf(m.id);
          members.splice(i, 1);
          roles.splice(i, 1);
        } else if (full) {
          return ctx.toast(`A conversation seats ${d.seats.max} at most.`, 'warn');
        } else {
          members.push(m?.id ?? '');
          roles.push(m ? '' : 'Helper');
        }
        buzz();
        persist();
        paint();
      });
      return b;
    };
    const onFloor = [...here.keys()].map((id) => TEAM_BY_ID.get(id)!).sort((a, b) => Number(isResting(here.get(a.id)!)) - Number(isResting(here.get(b.id)!)));
    const onFloorIds = new Set(onFloor.map((m) => m.id));
    const dept = TEAM.filter((m) => ds.has(m.group) && !onFloorIds.has(m.id));
    const shown = new Set([...onFloorIds, ...dept.map((m) => m.id)]);
    // The people on this floor and a helper; everyone else (picked ones too) behind "More people", so
    // the opening message isn't a long scroll away.
    const more = everyone || !onFloor.length;
    const extra = TEAM.filter((m) => !onFloorIds.has(m.id) && members.includes(m.id) && !more);
    const groups: HTMLElement[] = [h('div.a-mtg-picker__grid', {}, ...onFloor.map(tile), ...extra.map(tile), tile(null))];
    if (more && dept.length) groups.push(h('p.a-mtg-picker__group', {}, onFloor.length ? 'Also on the team' : 'The team'), h('div.a-mtg-picker__grid', {}, ...dept.map(tile)));
    if (more) {
      for (const g of DEPARTMENTS) {
        const people = TEAM.filter((m) => m.group === g && !shown.has(m.id));
        if (people.length) groups.push(h('p.a-mtg-picker__group', {}, `${DEPARTMENT_ICON[g]} ${g}`), h('div.a-mtg-picker__grid', {}, ...people.map(tile)));
      }
    }
    const others = TEAM.filter((m) => !onFloorIds.has(m.id)).length;
    const toggle = others && onFloor.length
      ? btn({
          label: everyone ? 'Just the people here' : `More people (${others})`,
          variant: 'ghost',
          size: 'sm',
          cls: 'a-mtg-picker__all',
          onClick: () => {
            everyone = !everyone;
            paint();
          },
        })
      : null;
    talkPicker.replaceChildren(...groups, ...(toggle ? [toggle] : []));
    (form.querySelector('.a-mtg-talkpick__count') as HTMLElement).textContent = `${members.length} of ${d.seats.max}`;
    talkNote.textContent = 'Each teammate brings their own model and brief. A helper is a general assistant, not one of your teammates.';
    const mc = ctx.store.machine;
    if (mc.limit !== undefined && members.length > Math.max(0, mc.limit - mc.workers)) {
      talkNote.textContent += ` Heads up: this computer runs up to ${mc.limit} teammates at once and ${mc.workers} ${mc.workers === 1 ? 'is' : 'are'} running, so send some home first or bring fewer.`;
    }
  };

  // ---- PRs, parts, rounds, budget, output, provider ------------------------------------------------
  let prKey = '';
  const renderPrs = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const key = JSON.stringify(open.map((p) => [p.number, p.title]));
    if (key === prKey && prList.childElementCount) return;
    prKey = key;
    if (prPick && !open.some((p) => p.number === prPick)) prPick = 0;
    prList.replaceChildren(
      ...(open.length
        ? open.map((p) =>
            h(
              'button.a-mtg-pr',
              { type: 'button', role: 'radio', 'aria-checked': String(prPick === p.number), 'data-pr': p.number },
              h('span.a-mtg-pr__num', {}, `#${p.number}`),
              h('span.a-mtg-pr__title', {}, p.title),
              h('span.a-mtg-pr__meta', {}, `${p.author} · +${p.additions} −${p.deletions}`),
            ),
          )
        : [h('p.a-mtg-form__hint', {}, store.pulls.loading ? 'Looking for open pull requests…' : 'No open pull requests on this space right now.')]),
    );
  };
  prList.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.a-mtg-pr');
    if (!b) return;
    prPick = Number(b.dataset.pr);
    for (const x of prList.querySelectorAll('.a-mtg-pr')) x.setAttribute('aria-checked', String(x === b));
    paint();
  });

  const parts = () => partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
  const slug = () => slugify(titleIn.value.trim() || topic.value.trim().split('\n')[0] || 'meeting', 32);

  const renderProvider = () => {
    const opts = providers();
    if (!opts.includes(provider)) provider = opts[0];
    const pills = <T extends string>(label: string, items: { v: T; label: string }[], cur: T, onPick: (v: T) => void) => {
      const id = `a-mtg-f-${label.toLowerCase().replace(/\W+/g, '-')}`;
      return h(
        'div.a-mtg-form__field',
        {},
        h('span.a-mtg-form__label', { id }, label),
        h(
          'div.a-mtg-pills',
          { role: 'radiogroup', 'aria-labelledby': id },
          ...items.map((it) => h('button.a-mtg-pill', { type: 'button', role: 'radio', 'aria-checked': String(it.v === cur), onclick: () => onPick(it.v) }, it.label)),
        ),
      );
    };
    const kids: Node[] = [];
    if (opts.length > 1)
      kids.push(
        pills('Who runs it', opts.map((p) => ({ v: p, label: PROVIDER_LABEL[p] })), provider, (v) => {
          provider = v;
          writeLocal(PROVIDER_KEY, v);
          renderProvider();
          paint();
        }),
      );
    if (provider === 'claude') {
      kids.push(
        pills('Model', [{ v: '' as ClaudeModel | '', label: 'Their own' }, ...(['opus', 'sonnet', 'fable', 'haiku'] as ClaudeModel[]).map((m) => ({ v: m as ClaudeModel | '', label: CLAUDE_MODEL_LABEL[m] }))], claudeModel, (v) => {
          claudeModel = v;
          writeLocal(choiceKey('model'), v);
          renderProvider();
          paint();
        }),
        pills('Effort', [{ v: '' as AgentEffort | '', label: 'Their own' }, ...AGENT_EFFORTS.map((e) => ({ v: e as AgentEffort | '', label: EFFORT_LABEL[e] }))], effort, (v) => {
          effort = v;
          writeLocal(choiceKey('effort'), v);
          renderProvider();
          paint();
        }),
        h('p.a-mtg-form__hint', {}, '“Their own” keeps each teammate on the model and effort they were made for. Picking one puts everyone at the table on it.'),
      );
    } else if (provider === 'opencode') {
      kids.push(h('div.a-mtg-form__field', {}, h('label.a-mtg-form__label', { for: 'a-mtg-f-ocmodel' }, 'OpenCode model'), openCodeIn, h('p.a-mtg-form__hint', {}, 'Optional, as provider/model. Empty uses OpenCode’s own settings.')));
    } else {
      kids.push(h('p.a-mtg-form__hint', {}, `${PROVIDER_LABEL[provider]} uses the office’s own model settings.`));
    }
    providerEl.replaceChildren(...kids);
  };
  openCodeIn.addEventListener('input', () => paint());

  /** The model to send, as ui/provider.ts's picker gives it. */
  const model = (): string | undefined => (provider === 'claude' ? claudeModel || undefined : provider === 'opencode' && validModel(openCodeIn.value) ? openCodeIn.value : undefined);

  roundsMinus.addEventListener('click', () => {
    rounds = Math.max(def().rounds.min, rounds - 1);
    persist();
    paint();
  });
  roundsPlus.addEventListener('click', () => {
    rounds = Math.min(def().rounds.max, rounds + 1);
    persist();
    paint();
  });
  budgetIn.addEventListener('input', () => {
    budgetTouched = true;
    paint();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    paint();
  });
  for (const el of [topic, titleIn, partsIn]) {
    el.addEventListener('input', () => {
      persist();
      paint();
    });
  }

  // ---- Painting ------------------------------------------------------------------------------------
  let lastPattern: MeetingPattern | null = null;
  const paint = (structural = false) => {
    const d = def();
    if (lastPattern !== pattern || structural || !patternBtns.length) {
      if (!patternBtns.length || visiblePatterns().length !== patternBtns.length) renderPatterns();
      lastPattern = pattern;
    }
    for (const b of patternBtns) {
      const on = b.dataset.pattern === pattern;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    patternLine.textContent = PATTERN_WORDS[pattern].line;
    layout();

    // The busy room.
    const cur = store.meeting.current;
    const running = cur?.status === 'running';
    busy.replaceChildren(
      ...(running
        ? [
            h(
              'div.a-mtg-busy',
              {},
              h('span.a-mtg-live-dot', { 'aria-hidden': 'true' }),
              h('div.a-mtg-busy__text', {}, h('strong', {}, 'A meeting is on'), h('span', {}, `“${cur!.title}” has the room until it ends or you stop it.`)),
              btn({ label: 'See it', variant: 'secondary', size: 'sm', onClick: () => ctx.go({ view: 'meetings', floor }) }),
            ),
          ]
        : cur && !cur.cleared
          ? [h('p.a-mtg-form__note', {}, `Everyone still at the table from “${cur.title}” goes home when this one starts.`)]
          : []),
    );

    renderFill();
    if (isTalk()) renderTalk();
    else renderChairs();

    prSec.hidden = d.needs !== 'pr';
    if (d.needs === 'pr') renderPrs();
    partsSec.hidden = d.needs !== 'parts';
    const ps = parts().length;
    partsNote.textContent = `Handed out to the helpers in turn: files, folders, modules, issues or tickers. ${plural(ps, 'piece')} so far; this table needs at least ${roles.length - 1}.`;

    rounds = Math.max(d.rounds.min, Math.min(d.rounds.max, rounds));
    roundsVal.textContent = String(rounds);
    const fixed = d.rounds.min === d.rounds.max;
    roundsMinus.disabled = fixed || rounds <= d.rounds.min;
    roundsPlus.disabled = fixed || rounds >= d.rounds.max;
    roundsNote.textContent = fixed ? `Always ${d.rounds.min}: ${d.roundsNote.toLowerCase()}` : d.roundsNote;

    if (!budgetTouched) budgetIn.value = String(nearestStep(Math.min(MAX_MEETING_BUDGET, Math.max(1, roles.length) * TOKENS_PER_SEAT)));
    budgetVal.textContent = `${fmtTokens(budget())} tokens`;
    budgetIn.style.setProperty('--f', String(Number(budgetIn.value) / (BUDGET_STEPS.length - 1)));
    budgetIn.setAttribute('aria-valuetext', `${fmtTokens(budget())} tokens`);
    budgetNote.textContent = isTalk()
      ? 'For everyone at the table together. Over it, the meeting ends; saying something later gives it a fresh allowance.'
      : budgetTouched
        ? 'For everyone at the table together. Over it, the meeting stops.'
        : `A million per chair, for everyone together. Over it, the meeting stops.`;

    if (!outputTouched) outputIn.value = d.output(slug(), prPick || undefined);
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem ?? (isTalk() ? 'When it ends, the shared memory and every word said are saved here, on the meeting’s own branch.' : pattern === 'review' ? 'It ends when this file is written; the office then posts it on the pull request as one review.' : 'It ends when this file is written, and the office keeps it on the meeting’s own branch.');
    outputNote.classList.toggle('is-bad', !!problem);
    outputIn.setAttribute('aria-invalid', String(!!problem));
    outputIn.setAttribute('aria-describedby', 'a-mtg-f-output-note');
    if (problem) more.open = true;
    moreSum.textContent = [isTalk() ? `${fmtTokens(budget())} tokens` : '', provider === 'claude' ? (claudeModel ? CLAUDE_MODEL_LABEL[claudeModel] : 'Their own models') : PROVIDER_LABEL[provider], effort && provider === 'claude' ? EFFORT_LABEL[effort] : '', outputIn.value.split('/').pop()].filter(Boolean).join(' · ');

    paintFoot();
  };

  /** Why it can't start yet, and the field to go to. */
  const blocker = (): { why: string; field?: HTMLElement } | null => {
    const d = def();
    const cur = store.meeting.current;
    if (cur?.status === 'running') return { why: 'The room is busy until the meeting that’s on ends' };
    if (isTalk() && !members.length) return { why: 'Pick who’s coming', field: (talkPicker.querySelector('.a-mtg-tile') as HTMLElement | null) ?? talkPicker };
    if (!topic.value.trim()) return { why: isTalk() ? 'Write your opening message' : 'Say what it’s about', field: topic };
    if (d.needs === 'pr' && !prPick) return { why: 'Pick the pull request to review', field: (prList.querySelector('.a-mtg-pr') as HTMLElement | null) ?? prList };
    if (d.needs === 'parts' && parts().length < roles.length - 1) return { why: `List at least ${roles.length - 1} pieces, one per line, or take away a chair`, field: partsIn };
    const problem = outputProblem(outputIn.value.trim());
    if (problem) return { why: problem, field: outputIn };
    if (provider === 'opencode' && openCodeIn.value && !validModel(openCodeIn.value)) return { why: 'The OpenCode model goes as provider/model', field: openCodeIn };
    return null;
  };

  const paintFoot = () => {
    const picked = members.filter(Boolean);
    const helpers = members.length - picked.length;
    const names = picked.map(nameOf);
    const faces = members.map((id, i) => {
      const m = id ? TEAM_BY_ID.get(id) : undefined;
      return m ? avatar({ emoji: m.emoji, color: m.color, name: m.name, status: 'ready' }, 24) : h('span.a-mtg-foot__helper', { title: roles[i] }, glyph('dice', 13));
    });
    const helperWords = helpers ? `${helpers === 1 ? 'a helper' : `${helpers} helpers`}` : '';
    whoLine.replaceChildren(
      h('span.a-mtg-foot__faces', { 'aria-hidden': 'true' }, ...faces),
      h('span.a-mtg-foot__names', {}, picked.length ? namesList([...names, ...(helperWords ? [helperWords] : [])]) : !helpers ? 'Nobody picked yet' : helpers === 1 ? 'A general helper' : `${helpers} general helpers`),
    );
    // The button names who's coming, short enough for one line: the lead, then one more or a count.
    const everyoneNames = [...names, ...Array.from({ length: helpers }, () => 'a helper')];
    const label = isTalk()
      ? 'Start the conversation'
      : !picked.length
      ? `Start with ${plural(helpers, 'helper')}`
      : everyoneNames.length === 1
        ? `Start with ${everyoneNames[0]}`
        : everyoneNames.length === 2
          ? `Start with ${everyoneNames[0]} & ${everyoneNames[1]}`
          : `Start with ${everyoneNames[0]} & ${everyoneNames.length - 1} more`;
    start.querySelector('.a-btn__label')!.textContent = label;
    start.setAttribute('aria-label', members.length ? `${isTalk() ? 'Start the conversation' : 'Start the meeting'} with ${namesList([...names, ...(helperWords ? [helperWords] : [])])}` : label);
    const b = blocker();
    start.setAttribute('aria-disabled', String(!!b));
    reason.textContent = b ? b.why : isTalk() ? `Conversation · no rounds · ${fmtTokens(budget())} tokens` : `${PATTERN_WORDS[pattern].name} · ${plural(rounds, 'round')} at most · ${fmtTokens(budget())} tokens`;
    reason.classList.toggle('is-blocked', !!b);
    if (b) start.setAttribute('aria-describedby', 'a-mtg-f-reason');
    else start.removeAttribute('aria-describedby');
  };

  // ---- Starting ------------------------------------------------------------------------------------
  let helpersOk = false;
  let sending = false;
  const send = async () => {
    if (sending) return;
    const b = blocker();
    if (b) {
      b.field?.focus();
      if (b.field) b.field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const d = def();
    const empty = roles.map((r, i) => (members[i] ? null : r.trim() || `chair ${i + 1}`)).filter((r): r is string => !!r);
    // A conversation's helpers were added on purpose, one tap each: no need to ask.
    if (empty.length && !helpersOk && !isTalk()) {
      const all = empty.length === roles.length;
      const ok = await confirmDialog({
        title: 'Start with general helpers?',
        body: `Nobody from your team is picked for ${all ? 'any chair' : empty.map((r) => `“${r}”`).join(', ')}, so ${empty.length === 1 ? 'a general helper (not one of your teammates) sits there' : 'general helpers (not your teammates) sit there'}. Pick people for ${empty.length === 1 ? 'that chair' : 'those chairs'}, or start anyway.`,
        action: 'Start anyway',
        cancel: 'Pick people',
      });
      if (!ok) {
        active = members.findIndex((x) => !x);
        paint();
        chairsEl.querySelector(`[data-chair="${active}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      helpersOk = true;
    }
    helpersOk = false;
    sending = true;
    // The files go up first: the message hands the table their paths.
    let attachments: string[] | undefined;
    if (files.count()) {
      try {
        ctx.toast(`Uploading ${files.count() === 1 ? 'your file' : `${files.count()} files`}…`);
        attachments = await files.upload(floor);
      } catch (err) {
        sending = false;
        ctx.toast(`Couldn't upload: ${(err as Error).message}`, 'error');
        return;
      }
    }
    // A conversation: an empty job lets the server name the chair after the teammate in it, and its
    // helpers are "Helper 1", "Helper 2"…; rounds, parts and the PR don't apply.
    const talk = isTalk();
    // Exactly the 3D office's message (ui/meeting.ts send()); the server fills in what's left out.
    const msg: { t: 'meeting.start' } & MeetingRequest = {
      t: 'meeting.start',
      pattern,
      prompt: topic.value.trim(),
      title: titleIn.value.trim() || undefined,
      output: outputIn.value.trim(),
      roles: talk ? members.map((id) => (id ? '' : 'Helper')) : roles.map((r) => r.trim()),
      members: roles.map((_, i) => members[i] ?? ''),
      parts: d.needs === 'parts' ? parts() : undefined,
      pr: d.needs === 'pr' ? prPick || undefined : undefined,
      issue: undefined,
      rounds: talk ? undefined : rounds || undefined,
      budget: budget() || undefined,
      provider,
      model: model(),
      effort: provider === 'claude' && effort ? effort : undefined,
      attachments,
    };
    ctx.net.send(msg);
    files.clear();
    buzz();
    saveDraft(floor, null);
    const picked = members.filter(Boolean).map(nameOf);
    ctx.toast(talk ? `Starting the conversation${picked.length ? ` with ${namesList(picked)}` : ''}` : picked.length ? `Calling ${namesList(picked)} to the table` : 'Calling the meeting');
    // Back to the room: step back if the Meetings segment is underneath, else go there.
    const under = document.querySelector<HTMLElement>('[data-segment]')?.dataset.segment;
    if (under === 'meetings') close();
    else ctx.go({ view: 'meetings', floor });
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  // Enter in a one-line field would submit the form: only the button starts a meeting.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
    // Esc closes an open picker first, then the sheet.
    if (e.key === 'Escape' && active !== null) {
      e.preventDefault();
      e.stopPropagation();
      const i = active;
      active = null;
      paint();
      chairsEl.querySelector<HTMLElement>(`[data-chair="${i}"] .a-mtg-chair__who`)?.focus();
    }
  });

  // ---- Live ----------------------------------------------------------------------------------------
  let peopleKey = '';
  const onPeople = () => {
    const here = hereMates();
    const key = [...here.values()].map((w) => `${w.role}:${uiStatus(w)}`).join(',') + `|${awakeIds().length}`;
    if (key === peopleKey) return;
    peopleKey = key;
    // Don't redraw under her thumb while she's typing a job.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('a-mtg-chair__job')) return;
    renderFill();
    if (isTalk()) renderTalk();
    else renderChairs();
    paintFoot();
  };
  offs.push(
    ctx.on('meeting', () => paint()),
    ctx.on('pulls', () => def().needs === 'pr' && (renderPrs(), paintFoot())),
    ctx.on('project', () => {
      renderProvider();
      paint(true);
    }),
    ctx.on('workers', onPeople),
    onTeam(onPeople),
  );
  renderProvider();
  paint(true);
  // Focus what she'll fill first, on a desktop; a phone keeps its keyboard down until she taps.
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => topic.focus({ preventScroll: true }), 50);
  return () => offs.forEach((off) => off());
};
