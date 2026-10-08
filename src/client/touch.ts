// Touch controls for the 3D office on a phone or tablet, the way mobile games do it: a thumbstick on
// the left to walk (push it all the way to run), drag anywhere on the scene to look, tap the scene to
// use what's under the crosshair, and floating buttons on the right for everything the keyboard does.
// The buttons send the same key presses the keyboard would, so every feature works as it does there.
// The ✏️ button picks which buttons float on screen; the choice is kept on the device. A button whose
// key the hint bar is offering right now (at a desk: E, P, B…) lights up.

import { h } from './ui/dom';

export interface TouchHooks {
  /** Hold or let go of a key the player walks with (KeyW, ShiftLeft, Space…). */
  hold(code: string, down: boolean): void;
  /** Switch between first- and third-person. */
  toggleView(): void;
}

interface Action {
  id: string;
  label: string;
  /** What it does, for the ✏️ picker. */
  what: string;
  code?: string;
  key?: string;
  /** Held like a key rather than tapped (jump, the emote wheel). */
  hold?: boolean;
  run?: () => void;
}

const KEY = 'agent-office.touch';

export function mountTouchControls(root: HTMLElement, hooks: TouchHooks) {
  const send = (type: 'keydown' | 'keyup', code: string, key: string) => window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true }));
  const tap = (code: string, key: string) => {
    send('keydown', code, key);
    setTimeout(() => send('keyup', code, key), 60);
  };

  const ACTIONS: Action[] = [
    { id: 'jump', label: '⤒', what: 'Jump (Space)', code: 'Space', key: ' ', hold: true },
    { id: 'p', label: 'P', what: 'Prompt / hire with a task', code: 'KeyP', key: 'p' },
    { id: 'r', label: 'R', what: 'Wake / resume a worker', code: 'KeyR', key: 'r' },
    { id: 'n', label: 'N', what: 'Go to whoever needs you', code: 'KeyN', key: 'n' },
    { id: 'c', label: 'C', what: 'Changes at a desk', code: 'KeyC', key: 'c' },
    { id: 'b', label: 'B', what: 'Open a shell at a desk', code: 'KeyB', key: 'b' },
    { id: 'o', label: 'O', what: 'Open a pull request', code: 'KeyO', key: 'o' },
    { id: 'x', label: 'X', what: 'Send a worker home', code: 'KeyX', key: 'x' },
    { id: 'q', label: 'Q', what: 'Put back the card you carry', code: 'KeyQ', key: 'q' },
    { id: 'f', label: '🖼️', what: 'Hang a picture (F)', code: 'KeyF', key: 'f' },
    { id: 't', label: '💬', what: 'Chat (T)', code: 'KeyT', key: 't' },
    { id: 'g', label: '😀', what: 'Emotes (hold, then point)', code: 'KeyG', key: 'g', hold: true },
    { id: 'search', label: '🔎', what: 'Search (/)', code: 'Slash', key: '/' },
    { id: 'menu', label: '☰', what: 'The menu (Tab)', code: 'Tab', key: 'Tab' },
    { id: 'view', label: '👁️', what: 'First / third person', run: () => hooks.toggleView() },
    {
      id: 'team',
      label: '📱',
      what: 'Switch to Hearth, the app view',
      run: () => {
        try {
          localStorage.removeItem('agent-office.3d');
        } catch {
          // storage blocked
        }
        location.href = '/app';
      },
    },
  ];
  const DEFAULT = ['jump', 'p', 'r', 'n', 't', 'menu', 'view', 'team'];
  let shown = new Set(DEFAULT);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved)) shown = new Set(saved.filter((s: unknown) => typeof s === 'string'));
  } catch {
    // storage blocked
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...shown]));
    } catch {
      // storage blocked
    }
  };

  // ---- The thumbstick ----
  const knob = h('div.tc-knob');
  const stick = h('div.tc-stick', { 'aria-label': 'Walk' }, knob);
  const walkCodes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'];
  const held = new Set<string>();
  const setHeld = (want: Set<string>) => {
    for (const c of walkCodes) {
      const on = want.has(c);
      if (on !== held.has(c)) {
        hooks.hold(c, on);
        if (on) held.add(c);
        else held.delete(c);
      }
    }
  };
  let stickId: number | null = null;
  const R = 56;
  const moveStick = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const want = new Set<string>();
    const k = Math.min(1, len / R);
    if (k > 0.25) {
      // Eight ways: a key for each direction the stick leans past ~22°.
      const ang = Math.atan2(dy, dx);
      if (Math.sin(ang) < -0.38) want.add('KeyW');
      if (Math.sin(ang) > 0.38) want.add('KeyS');
      if (Math.cos(ang) < -0.38) want.add('KeyA');
      if (Math.cos(ang) > 0.38) want.add('KeyD');
      if (k > 0.92) want.add('ShiftLeft');
    }
    setHeld(want);
  };
  const releaseStick = () => {
    stickId = null;
    knob.style.transform = '';
    setHeld(new Set());
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) moveStick(e);
  });
  stick.addEventListener('pointerup', releaseStick);
  stick.addEventListener('pointercancel', releaseStick);

  // ---- The buttons ----
  const use = h('button.tc-btn.tc-use', { type: 'button', 'aria-label': 'Use (E)' }, h('b', {}, 'E'), h('small', {}, 'Use'));
  use.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tap('KeyE', 'e');
  });
  const grid = h('div.tc-grid');
  const buttons = new Map<string, HTMLElement>();
  const renderButtons = () => {
    buttons.clear();
    grid.replaceChildren(
      ...ACTIONS.filter((a) => shown.has(a.id)).map((a) => {
        const b = h('button.tc-btn', { type: 'button', title: a.what, 'aria-label': a.what }, a.label);
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          b.classList.add('down');
          if (a.run) return a.run();
          if (a.hold && a.code === 'Space') return hooks.hold('Space', true);
          if (a.hold) return send('keydown', a.code!, a.key!);
          tap(a.code!, a.key!);
        });
        const up = () => {
          b.classList.remove('down');
          if (a.hold && a.code === 'Space') hooks.hold('Space', false);
          else if (a.hold) send('keyup', a.code!, a.key!);
        };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        if (a.code) buttons.set(a.label.length === 1 ? a.label : a.id, b);
        return b;
      }),
      editBtn,
    );
  };

  // ✏️ Pick which buttons float on screen.
  const editBtn = h('button.tc-btn.tc-edit', { type: 'button', 'aria-label': 'Choose buttons', title: 'Choose which buttons show' }, '✏️');
  const picker = h('div.tc-picker.hidden', { role: 'dialog', 'aria-label': 'Choose buttons' });
  const renderPicker = () =>
    picker.replaceChildren(
      h('b', {}, 'Buttons on screen'),
      ...ACTIONS.map((a) => {
        const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
        box.checked = shown.has(a.id);
        box.addEventListener('change', () => {
          if (box.checked) shown.add(a.id);
          else shown.delete(a.id);
          save();
          renderButtons();
        });
        return h('label', {}, box, h('span', {}, `${a.label}  ${a.what}`));
      }),
      h('button.btn', { type: 'button', onclick: () => picker.classList.add('hidden') }, 'Done'),
    );
  editBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    renderPicker();
    picker.classList.toggle('hidden');
  });

  const el = h('div.tc', { id: 'touch' }, stick, h('div.tc-right', {}, grid, use), picker);
  root.append(el);
  renderButtons();

  // Light up what the hint bar offers right now, and say on the big button what E does here.
  setInterval(() => {
    const hint = document.getElementById('hint');
    const live = hint && !hint.classList.contains('hidden');
    const keys = new Map<string, string>();
    if (live) for (const k of hint.querySelectorAll('.key')) keys.set(k.textContent ?? '', (k.parentElement?.textContent ?? '').replace(k.textContent ?? '', '').trim());
    use.classList.toggle('hot', keys.has('E'));
    use.querySelector('small')!.textContent = (keys.get('E') || 'Use').slice(0, 18);
    for (const [label, b] of buttons) b.classList.toggle('hot', keys.has(label));
  }, 250);
}

/** A phone or tablet: a touch screen and no fine pointer. */
export function isTouchDevice(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}
