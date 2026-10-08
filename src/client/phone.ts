// The office on a phone: no 3D and no keyboard to walk with, just your team. Pick a floor, see
// who's working, waiting on you or asleep, message anyone (a message wakes a sleeping one), open
// their terminal, or hire a crew. Same login, same live socket and same terminals as the 3D office.

import { Net } from './net';
import { loadProfile, store, type Profile } from './state';
import { openTerminal, routeTerminalMessage } from './ui/terminal';
import { openCrewHire } from './ui/crew';
import { openReports } from './ui/reports';
import { CLAUDE_MODEL_LABEL } from './ui/provider';
import { h, STATUS_LABEL, toast } from './ui/dom';
import { randomLook } from '../shared/avatar';
import { TEAM_BY_ID } from '../shared/team';
import { DESK_BY_ID } from '../shared/layout';
import type { WorkerInfo } from '../shared/protocol';
import { attachNote, attachments } from './attach';

const listEl = document.getElementById('ph-list')!;
const floorSel = document.getElementById('ph-floor') as HTMLSelectElement;
const statusEl = document.getElementById('ph-status')!;
const filterBtn = document.getElementById('ph-filter') as HTMLButtonElement;

// Open the 3D office from here and it stays the 3D office on this device (see the redirect in index.html).
document.getElementById('ph-3d')?.addEventListener('click', () => {
  try {
    localStorage.setItem('agent-office.3d', '1');
  } catch {
    // storage blocked
  }
});

const saved = loadProfile();
const profile: Profile = { name: `${saved?.name ?? 'Guest'} 📱`, color: saved?.color ?? '#4f86f7', look: saved?.look ?? randomLook() };
store.profile = profile;

async function signedIn(): Promise<boolean> {
  try {
    const res = await fetch('/api/whoami', { cache: 'no-store' });
    if (res.status === 401) {
      location.href = '/login';
      return false;
    }
    const { me } = (await res.json()) as { me?: { account?: { name: string } } };
    if (me?.account) profile.name = `${me.account.name} 📱`;
  } catch {
    // offline: the socket retries
  }
  return true;
}

const net = new Net(() => profile);
let onlyWaiting = false;
/** Workers whose message box is open, so a re-render keeps it (and what's typed in it). */
const drafts = new Map<string, string>();
/** Screenshots picked for a worker's message and not sent yet. */
const pickedFiles = new Map<string, ReturnType<typeof attachments>>();
let openBox: string | null = null;

net.onStatus((up) => {
  statusEl.textContent = up ? '' : 'Reconnecting…';
  statusEl.classList.toggle('bad', !up);
});

net.onMessage((msg) => {
  store.apply(msg);
  routeTerminalMessage(msg);
  if (msg.t === 'toast') toast(msg.text, msg.level);
  if (msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'floors') renderFloors();
  if (msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'worker.update' || msg.t === 'worker.remove' || msg.t === 'floors') render();
});

function renderFloors() {
  const current = store.floor;
  floorSel.replaceChildren(
    ...store.floors
      .filter((f) => !f.cloning)
      .map((f) => {
        const need = f.id === current ? '' : f.waiting ? ` · 🙋 ${f.waiting}` : f.busy ? ` · ⚙️ ${f.busy}` : '';
        return h('option', { value: f.id }, `${f.name}${need}`);
      }),
  );
  if (current) floorSel.value = current;
}

floorSel.addEventListener('change', () => {
  const floor = floorSel.value;
  if (floor && floor !== store.floor) {
    statusEl.textContent = 'Riding the elevator…';
    openBox = null;
    net.send({ t: 'floor.go', floor });
  }
});

document.getElementById('ph-reports')!.addEventListener('click', () => void openReports());

filterBtn.addEventListener('click', () => {
  onlyWaiting = !onlyWaiting;
  filterBtn.setAttribute('aria-pressed', String(onlyWaiting));
  filterBtn.classList.toggle('on', onlyWaiting);
  render();
});

document.getElementById('ph-crew')!.addEventListener('click', () =>
  openCrewHire({
    floors: store.floors.filter((f) => !f.cloning),
    floor: store.floor,
    onHire: (floor, roles, prompt, worktree, crew, parked) => net.send({ t: 'crew.hire', floor, roles, prompt, worktree, crew, parked }),
  }),
);

const asleep = (w: WorkerInfo) => w.status === 'offline' || w.status === 'exited';
const waiting = (w: WorkerInfo) => w.status === 'needs_input' || (w.status === 'done' && !w.acked);

/** Needs you first, then busy, then ready, then asleep; by name within each. */
function rank(w: WorkerInfo): number {
  if (waiting(w)) return 0;
  if (w.status === 'working' || w.status === 'starting') return 1;
  if (!asleep(w)) return 2;
  return 3;
}

function render() {
  const all = [...store.workers.values()].filter((w) => w.kind === 'agent' || w.kind === 'shell');
  const shown = all.filter((w) => !onlyWaiting || waiting(w)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const counts = { waiting: all.filter(waiting).length, working: all.filter((w) => w.status === 'working').length, asleep: all.filter(asleep).length };
  filterBtn.textContent = counts.waiting ? `🙋 Needs me (${counts.waiting})` : '🙋 Needs me';
  if (!statusEl.classList.contains('bad')) statusEl.textContent = all.length ? `${all.length} on this floor · ${counts.working} working · ${counts.asleep} asleep` : '';
  if (!shown.length) {
    listEl.replaceChildren(h('p.ph-empty', {}, onlyWaiting ? 'Nobody is waiting on you here. 🎉' : 'Nobody sits on this floor yet. Tap 👥 Hire a crew.'));
    return;
  }
  // Keep a message being typed through re-renders.
  const typing = openBox ? (document.getElementById(`ph-msg-${openBox}`) as HTMLTextAreaElement | null) : null;
  if (typing) drafts.set(openBox!, typing.value);
  listEl.replaceChildren(...shown.map(card));
  if (openBox) {
    const ta = document.getElementById(`ph-msg-${openBox}`) as HTMLTextAreaElement | null;
    if (ta && document.activeElement !== ta && typing === document.activeElement) ta.focus();
  }
}

function card(w: WorkerInfo): HTMLElement {
  const member = w.role ? TEAM_BY_ID.get(w.role) : undefined;
  const station = DESK_BY_ID.get(w.deskId)?.station;
  const status = asleep(w) ? (w.parked ? 'asleep' : STATUS_LABEL[w.status] ?? w.status) : STATUS_LABEL[w.status] ?? w.status;
  const model = w.model && w.model in CLAUDE_MODEL_LABEL ? CLAUDE_MODEL_LABEL[w.model as keyof typeof CLAUDE_MODEL_LABEL] : undefined;
  const sub = [member && member.title !== w.name ? member.title : undefined, model].filter(Boolean).join(' · ');
  const doing = w.task?.summary || w.activity || w.title || (member && asleep(w) ? member.pitch : '');
  const open = openBox === w.id;

  const msgBtn = h('button.btn', { type: 'button', onclick: () => toggleBox(w.id) }, open ? 'Close' : asleep(w) ? '💬 Wake & message' : '💬 Message');
  const termBtn = h('button.btn', { type: 'button', onclick: () => openTerminal(net, w.id) }, '🖥️ Terminal');
  const wakeBtn = asleep(w) ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'worker.resume', workerId: w.id }) }, '⏻ Wake') : null;

  const box = open ? messageBox(w) : null;
  return h(
    'article.ph-card',
    { class: `st-${asleep(w) ? 'asleep' : w.status}${waiting(w) ? ' waiting' : ''}`, style: `--who:${w.color}` },
    h(
      'div.ph-head',
      {},
      h('span.ph-emoji', {}, member?.emoji ?? (station ? '🧾' : w.kind === 'shell' ? '🐚' : '🤖')),
      h('div.ph-name', {}, h('b', {}, w.name), sub ? h('small', {}, sub) : null),
      h('span.pill', { class: asleep(w) ? 'offline' : w.status }, waiting(w) && w.status === 'done' ? 'done ✓' : status),
    ),
    doing ? h('p.ph-doing', {}, doing) : null,
    h('div.ph-buttons', {}, msgBtn, wakeBtn, termBtn),
    box,
  );
}

function toggleBox(id: string) {
  openBox = openBox === id ? null : id;
  render();
  if (openBox) setTimeout(() => (document.getElementById(`ph-msg-${id}`) as HTMLTextAreaElement | null)?.focus(), 30);
}

function messageBox(w: WorkerInfo): HTMLElement {
  const ta = h('textarea', { id: `ph-msg-${w.id}`, rows: 4, placeholder: asleep(w) ? `Wake ${w.name} with a message…` : `Message ${w.name}…` }) as HTMLTextAreaElement;
  ta.value = drafts.get(w.id) ?? '';
  ta.addEventListener('input', () => drafts.set(w.id, ta.value));
  // Kept per worker, so a redraw (anyone's status changing) doesn't drop a screenshot picked but not sent yet.
  let files = pickedFiles.get(w.id);
  if (!files) pickedFiles.set(w.id, (files = attachments()));
  const box = files;
  ta.addEventListener('paste', (e) => box.paste(e));
  const send = h('button.btn.primary', { type: 'button' }, 'Send ✨');
  send.addEventListener('click', async () => {
    let prompt = ta.value.trim();
    if (!prompt && !box.count()) return ta.focus();
    if (box.count()) {
      send.textContent = 'Uploading…';
      try {
        prompt = (prompt || 'Have a look at this.') + attachNote(await box.upload());
      } catch (err) {
        send.textContent = 'Send ✨';
        return void toast(`📎 ${(err as Error).message}`, 'warn');
      }
    }
    net.send({ t: 'worker.prompt', workerId: w.id, prompt });
    drafts.delete(w.id);
    pickedFiles.delete(w.id);
    openBox = null;
    toast(asleep(w) ? `Waking ${w.name} with your message` : `Sent to ${w.name}`);
    render();
  });
  return h('div.ph-box', {}, ta, box.element, h('div.ph-box-row', {}, h('small', {}, 'Open the terminal to watch the answer.'), send));
}

void signedIn().then((ok) => {
  if (ok) net.connect();
});
