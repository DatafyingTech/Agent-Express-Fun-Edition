// ☰ → Hire a crew: seat several of the roster's teammates (shared/team.ts) at once, on any floor, each
// with the same task if there is one (they're told who else sat down, so they split it by role).

import type { FloorInfo } from '../../shared/protocol';
import { CREWS, CREW_BY_ID, DEPARTMENTS, DEPARTMENT_ICON, TEAM, TEAM_BY_ID } from '../../shared/team';
import { store } from '../state';
import { h, openModal } from './dom';
import { CLAUDE_MODEL_LABEL } from './provider';

export interface CrewHireOptions {
  floors: FloorInfo[];
  /** The floor you're on, picked to begin with. */
  floor: string | null;
  onHire(floor: string, roles: string[], prompt: string | undefined, worktree: boolean, crew: string | undefined, parked: boolean): void;
}

const MAX = 16;

export function openCrewHire(opts: CrewHireOptions) {
  const picked = new Set<string>();
  let crewId: string | undefined;

  const floorSelect = h('select.provider-select', { id: 'crew-floor', 'aria-label': 'Floor' }) as HTMLSelectElement;
  for (const f of opts.floors) floorSelect.append(h('option', { value: f.id }, f.name));
  if (opts.floor && opts.floors.some((f) => f.id === opts.floor)) floorSelect.value = opts.floor;
  const floorNote = h('small.provider-note', {});

  const boxes = new Map<string, HTMLInputElement>();
  const chips = new Map<string, HTMLButtonElement>();
  const count = h('span.grow', {});
  const submit = h('button.btn.primary', { type: 'submit' }, 'Hire') as HTMLButtonElement;

  const paint = () => {
    for (const [id, box] of boxes) box.checked = picked.has(id);
    for (const [id, chip] of chips) {
      chip.classList.toggle('on', id === crewId);
      chip.setAttribute('aria-pressed', String(id === crewId));
    }
    const n = picked.size;
    count.textContent = n ? `${n} picked${n > MAX ? ` (at most ${MAX})` : ''} · they each take a free desk, then bean bags` : 'Pick a crew, or tick anyone';
    submit.textContent = n ? `Hire ${n} 👥` : 'Hire';
    submit.disabled = !n || n > MAX;
    // Who's already at a desk here (the floor you're on is the one the office tells you about).
    const here = floorSelect.value === store.floor ? [...store.workers.values()].filter((w) => w.role && picked.has(w.role)).map((w) => w.name) : [];
    floorNote.textContent = here.length ? `Already on this floor: ${here.join(', ')}. Hiring them again seats a second one (${here[0]}2…).` : 'They sit down on this floor. You can stay where you are.';
  };

  const crewRow = h(
    'div.crew-chips',
    { role: 'group', 'aria-label': 'Crews' },
    ...CREWS.map((c) => {
      const chip = h(
        'button.btn.crew-chip',
        {
          type: 'button',
          title: `${c.blurb} ${c.members.map((id) => TEAM_BY_ID.get(id)?.name).join(', ')}`,
          onclick: () => {
            picked.clear();
            for (const id of c.members) picked.add(id);
            crewId = c.id;
            // Their floor, if the building has it.
            if (c.floor && opts.floors.some((f) => f.id === c.floor)) floorSelect.value = c.floor;
            paint();
          },
        },
        `${c.emoji} ${c.name}`,
      ) as HTMLButtonElement;
      chips.set(c.id, chip);
      return chip;
    }),
  );

  const roster = h(
    'div.crew-roster',
    {},
    ...DEPARTMENTS.map((dept) =>
      h(
        'fieldset.crew-dept',
        {},
        h('legend', {}, `${DEPARTMENT_ICON[dept]} ${dept}`),
        ...TEAM.filter((m) => m.group === dept).map((m) => {
          const box = h('input', {
            type: 'checkbox',
            onchange: () => {
              if (box.checked) picked.add(m.id);
              else picked.delete(m.id);
              // Still exactly a crew's line-up? Then it's still that crew.
              crewId = CREWS.find((c) => c.members.length === picked.size && c.members.every((id) => picked.has(id)))?.id;
              paint();
            },
          }) as HTMLInputElement;
          boxes.set(m.id, box);
          return h(
            'label.crew-pick',
            { title: m.pitch, style: `--who:${m.color}` },
            box,
            h('span', {}, h('b', {}, `${m.emoji} ${m.name}`), h('small', {}, CLAUDE_MODEL_LABEL[m.model])),
          );
        }),
      ),
    ),
  );

  const ta = h('textarea', { rows: 4, placeholder: 'Optional: one task for the whole crew. Each takes the part that fits their role. Leave empty and they each say hi and wait.', 'aria-label': 'Crew task' }) as HTMLTextAreaElement;
  const wtBox = h('input', { type: 'checkbox', id: 'crew-wt' }) as HTMLInputElement;
  const parkBox = h('input', { type: 'checkbox', id: 'crew-park' }) as HTMLInputElement;
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');

  const form = h(
    'form.modal.crew-hire',
    { role: 'dialog', 'aria-label': 'Hire a crew' },
    h('header', {}, h('h2', {}, '👥 Hire a crew')),
    h(
      'div.body',
      {},
      h('div.provider-choice', { style: 'margin:0 0 12px' }, h('label', { for: 'crew-floor' }, '🛗 Floor'), floorSelect, floorNote),
      h('label', {}, 'Crews'),
      crewRow,
      h('label', { style: 'margin-top:14px' }, 'Or pick anyone'),
      roster,
      h('label', { style: 'margin-top:14px' }, 'Their first task'),
      ta,
      h('label', { for: 'crew-wt', style: 'display:flex;gap:8px;align-items:center;margin:10px 0 0;font-weight:700;cursor:pointer', title: 'Each crew member gets an own branch, so they never trip over each other' }, wtBox, '🌿 With a task, give each their own git worktree & branch'),
      h('label', { for: 'crew-park', style: 'display:flex;gap:8px;align-items:center;margin:6px 0 0;font-weight:700;cursor:pointer', title: 'They take their desks but nothing runs, and nothing is spent, until you wake one' }, parkBox, '💤 Seat them asleep: each wakes when you press R at their desk'),
    ),
    h('footer', {}, count, cancel, submit),
  ) as HTMLFormElement;
  form.noValidate = true;

  floorSelect.addEventListener('change', paint);
  const modal = openModal(form);
  cancel.addEventListener('click', () => modal.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!picked.size || picked.size > MAX) return;
    modal.close();
    // In roster order, so the crew's lead (listed first) takes the nearest desk.
    const crew = crewId ? CREW_BY_ID.get(crewId) : undefined;
    const roles = crew ? [...crew.members] : TEAM.filter((m) => picked.has(m.id)).map((m) => m.id);
    opts.onHire(floorSelect.value, roles, parkBox.checked ? undefined : ta.value.trim() || undefined, wtBox.checked, crewId, parkBox.checked);
  });
  paint();
}
