// "The office" (a sheet over a space, #/space/<floor>/office): the soul of the 3D office, without the
// game. Who's in the building and what they're up to (store.peers), the office chat everyone sees
// (the `chat` messages the 3D HUD shows), the lounge jukebox (jukebox.*), the floor's corgis (every
// floor has one, and a floor can have a second; each can be given its own name) with a pat for each, and
// the building's holiday decorations (theme.set).
//
// A pat is the 3D office's own: the server gives it to the nearest dog within reach of you (see
// server/dog.ts pet()). A phone isn't standing anywhere, so it first steps up to that dog (a `move`
// to its side, which everyone on the floor sees), then pats it. No server change needed.

import type { AppContext, View } from '../context';
import type { ChatLine, PeerInfo, ThemePick } from '../../../shared/protocol';
import { DOG_COATS, DOG_NAMES, dogAt, type DogState } from '../../../shared/dog';
import { JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById } from '../../../shared/jukebox';
import { THEME_PICKS } from '../../../shared/theme';
import { ROOF, ROOF_NAME } from '../../../shared/rooftop';
import { whereabouts } from '../../ui/whereabouts';
import { icon } from '../icons';
import { avatar, button, clockTime, dayLabel, h, hrefOf, iconButton, plural, spaceName } from '../ui';
import { glyph, haptic } from './tasks';
import { edition } from '../../../shared/edition';

// =================================================================================================
// Words
// =================================================================================================

/** A person's name without the 📱 the office puts after a phone. */
const bare = (name: string) => name.replace(/\s*📱\s*$/u, '').trim();
const onPhone = (name: string) => /📱\s*$/u.test(name);

const COAT_NAMES = ['Red and white', 'Tricolor', 'Sable', 'Fawn'];
/** A dog someone named (not one of the names a new floor's dog starts with) is family: it gets a line of its own. */
const isFamily = (name: string) => !DOG_NAMES.includes(name);

const THEME_WORDS: Record<ThemePick, { emoji: string; label: string; note: string }> = {
  auto: { emoji: '📅', label: 'By the calendar', note: 'Halloween all October, Christmas all December.' },
  halloween: { emoji: '🎃', label: 'Halloween', note: 'Zombie teammates, a creepy sky, jack-o’-lanterns everywhere.' },
  christmas: { emoji: '🎄', label: 'Christmas', note: 'Elves at the desks, mittens, snow outside.' },
  off: { emoji: '🌙', label: 'No decorations', note: 'Just the office, as it is.' },
};

const PAT_WORDS = ['Such a good pup', 'Happy wiggles', 'Best corgi', 'Tail’s going', 'Big stretch', 'Pure joy'];

// =================================================================================================
// A corgi's portrait, drawn in its own coat
// =================================================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

function corgi(coat: number, happy: boolean): SVGSVGElement {
  const [body, chest, deep] = DOG_COATS[coat % DOG_COATS.length];
  const tri = coat % DOG_COATS.length === 1;
  const tan = '#C98541';
  const ink = '#2A2220';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'a-of-dog__art');
  svg.innerHTML = `
    <g class="a-of-dog__ears">
      <path class="a-of-dog__ear is-l" d="M22 62 L28 10 Q31 4 36 8 L58 42 Z" fill="${body}"/>
      <path class="a-of-dog__ear is-r" d="M98 62 L92 10 Q89 4 84 8 L62 42 Z" fill="${body}"/>
      <path d="M31 50 L32 19 L49 42 Z" fill="${tri ? deep : chest}" opacity="${tri ? 0.9 : 0.55}"/>
      <path d="M89 50 L88 19 L71 42 Z" fill="${tri ? deep : chest}" opacity="${tri ? 0.9 : 0.55}"/>
    </g>
    <ellipse cx="60" cy="72" rx="41" ry="36" fill="${body}"/>
    ${tri ? `<ellipse cx="34" cy="84" rx="11" ry="9" fill="${tan}"/><ellipse cx="86" cy="84" rx="11" ry="9" fill="${tan}"/>` : ''}
    <path d="M53 36 Q60 31 67 36 L72 74 Q60 80 48 74 Z" fill="${chest}"/>
    <ellipse cx="60" cy="89" rx="25" ry="17" fill="${chest}"/>
    ${tri ? `<circle cx="45" cy="56" r="3.6" fill="${tan}"/><circle cx="75" cy="56" r="3.6" fill="${tan}"/>` : ''}
    <g class="a-of-dog__eyes">
      <ellipse cx="44" cy="66" rx="5.4" ry="${happy ? 2.2 : 5.8}" fill="${ink}"/>
      <ellipse cx="76" cy="66" rx="5.4" ry="${happy ? 2.2 : 5.8}" fill="${ink}"/>
      ${happy ? '' : `<circle cx="46" cy="63.5" r="1.8" fill="#fff"/><circle cx="78" cy="63.5" r="1.8" fill="#fff"/>`}
    </g>
    <ellipse cx="34" cy="79" rx="6" ry="3.6" fill="#F08A8A" opacity="${happy ? 0.55 : 0.28}"/>
    <ellipse cx="86" cy="79" rx="6" ry="3.6" fill="#F08A8A" opacity="${happy ? 0.55 : 0.28}"/>
    <path d="M53.5 79 Q60 74.5 66.5 79 Q63 85 60 85 Q57 85 53.5 79 Z" fill="${ink}"/>
    <ellipse cx="58" cy="78" rx="2" ry="1.1" fill="#fff" opacity="0.5"/>
    ${happy ? `<path d="M55 92 Q60 105 65 92 Z" fill="#E8707E"/>` : ''}
    <path d="M60 85 Q60 92 52.5 92 M60 85 Q60 92 67.5 92" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>
  `;
  return svg;
}

const heartGlyph = (size = 22) => {
  const g = glyph('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>', size);
  g.setAttribute('fill', 'currentColor');
  return g;
};
const musicGlyph = (size = 18) => glyph('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', size);
const playGlyph = (size = 20) => {
  const g = glyph('<polygon points="6 3 20 12 6 21 6 3"/>', size);
  g.setAttribute('fill', 'currentColor');
  return g;
};
const skipGlyph = (size = 20) => glyph('<polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" x2="19" y1="5" y2="19"/>', size);
const stopGlyph = (size = 18) => {
  const g = glyph('<rect x="5" y="5" width="14" height="14" rx="2"/>', size);
  g.setAttribute('fill', 'currentColor');
  return g;
};
const phoneGlyph = (size = 12) => glyph('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>', size);

// =================================================================================================
// Pats: how many today, on this device (a little something to smile at)
// =================================================================================================

const today = () => new Date().toISOString().slice(0, 10);
function patsToday(floor: string, dogId: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(`hearth.pats.${floor}.${dogId}`) ?? 'null') as { day: string; n: number } | null;
    return v && v.day === today() ? v.n : 0;
  } catch {
    return 0;
  }
}
function addPat(floor: string, dogId: string): number {
  const n = patsToday(floor, dogId) + 1;
  try {
    localStorage.setItem(`hearth.pats.${floor}.${dogId}`, JSON.stringify({ day: today(), n }));
  } catch {
    // storage blocked: the count lasts as long as the page
  }
  return n;
}

// =================================================================================================
// The sheet
// =================================================================================================

export const officeView: View = (root, ctx) => {
  const floor = ctx.floor()!;
  const s = ctx.store;
  const send = ctx.net.send.bind(ctx.net);
  const close = () => ctx.go({ view: 'space', floor });
  const timers: ReturnType<typeof setInterval>[] = [];

  // ---- Head ---------------------------------------------------------------------------------------
  const sub = h('p.a-of-office__sub');
  root.append(
    h(
      'header.a-sheet__head.a-of-office__head',
      {},
      h('div.a-of-office__titles', {}, h('h2.a-sheet__title.a-of-office__title', { id: 'a-of-office-title' }, 'The ', h('em', {}, 'office')), sub),
      iconButton('close', 'Close', close),
    ),
  );

  const people = h('section.a-of-office__sec', { 'aria-labelledby': 'a-of-people-h' });
  const dogs = h('section.a-of-office__sec', { 'aria-labelledby': 'a-of-dogs-h' });
  const chat = h('section.a-of-office__sec', { 'aria-labelledby': 'a-of-chat-h' });
  const jukebox = h('section.a-of-office__sec', { 'aria-labelledby': 'a-of-jb-h' });
  const theme = h('section.a-of-office__sec', { 'aria-labelledby': 'a-of-theme-h' });
  const body = h('div.a-sheet__body.a-of-office', {}, people, dogs, chat, jukebox, theme);
  root.append(body);

  const secHead = (id: string, title: string, note?: string | HTMLElement | null) =>
    h('header.a-of-office__sechead', {}, h('h3.a-of-office__h', { id }, title), note ? (typeof note === 'string' ? h('p.a-of-office__note', {}, note) : note) : null);

  // ---- Who's here ---------------------------------------------------------------------------------
  const whereWords = (p: PeerInfo): string => {
    if (!s.onMyFloor(p)) return p.floor === ROOF ? `Up at the ${ROOF_NAME.toLowerCase()}` : `On ${p.floor ? spaceName(p.floor) : 'another floor'}`;
    const w = whereabouts(p);
    if (w) return w.replace(/^\p{Extended_Pictographic}️?\s*/u, '').replace(/^./, (c) => c.toUpperCase());
    return onPhone(p.name) ? 'On their phone' : p.moving ? 'Walking around' : 'In the office';
  };
  let peopleSig = '';
  const paintPeople = () => {
    const all = [...s.peers.values()];
    const here = all.filter((p) => s.onMyFloor(p));
    const away = all.filter((p) => !s.onMyFloor(p));
    const sort = (a: PeerInfo, b: PeerInfo) => (a.id === s.you ? -1 : b.id === s.you ? 1 : bare(a.name).localeCompare(bare(b.name)));
    here.sort(sort);
    away.sort(sort);
    const sig = JSON.stringify(all.map((p) => [p.id, p.name, p.color, whereWords(p), p.floor]));
    sub.textContent = `${spaceName(floor)} · ${all.length ? plural(all.length, 'person', 'people') + ' in the building' : 'nobody else around'}`;
    if (sig === peopleSig) return;
    peopleSig = sig;
    const row = (p: PeerInfo) => {
      const me = p.id === s.you;
      return h(
        'li.a-of-person',
        { 'data-me': String(me) },
        avatar({ name: bare(p.name), color: p.color, size: 40 }, 40),
        h(
          'div.a-of-person__text',
          {},
          h('span.a-of-person__name', {}, bare(p.name), me ? h('span.a-of-person__you', {}, 'You') : null, onPhone(p.name) ? h('span.a-of-person__phone', { title: 'On a phone' }, phoneGlyph(12)) : null, p.account ? h('span.a-of-person__acct', { title: 'Signed in with their own account' }, icon('check', 12)) : null),
          h('span.a-of-person__where', {}, me ? 'Right here, on this phone' : whereWords(p)),
        ),
      );
    };
    people.replaceChildren(
      secHead('a-of-people-h', 'Who’s here'),
      here.length ? h('ul.a-of-people', { 'aria-label': `On ${spaceName(floor)}` }, ...here.map(row)) : h('p.a-of-office__empty', {}, `Nobody’s on ${spaceName(floor)} right now.`),
      away.length ? h('p.a-of-office__over', {}, 'Elsewhere in the building') : '',
      away.length ? h('ul.a-of-people.is-away', { 'aria-label': 'Elsewhere in the building' }, ...away.map(row)) : '',
    );
  };

  // ---- The corgis -----------------------------------------------------------------------------------
  const dogCards = new Map<string, { el: HTMLElement; art: HTMLElement; line: HTMLElement; count: HTMLElement; btn: HTMLButtonElement; label: HTMLElement; sig: string; hearts: HTMLElement; say: HTMLElement; lastPat: number }>();
  const dogWords = (d: DogState, start: number): { text: string; href?: string; tone?: 'needs' | 'happy' } => {
    const w = d.workerId ? s.workers.get(d.workerId) : undefined;
    const pose = dogAt(d, (performance.now() - start) / 1000);
    if (d.act === 'wag' && d.petBy) return { text: `Wagging for ${bare(d.petBy)}`, tone: 'happy' };
    if (d.act === 'bark' && w) return { text: `Barking at ${w.name}’s desk: they need you`, href: hrefOf({ view: 'chat', floor, worker: w.id }), tone: 'needs' };
    if (d.following) {
      const p = s.peers.get(d.following);
      if (p) return { text: `Trotting after ${p.id === s.you ? 'you' : bare(p.name)}` };
    }
    if (pose.moving) return { text: 'Trotting across the office' };
    switch (d.act) {
      case 'nap':
        return { text: w ? `Napping under ${w.name}’s desk` : 'Napping' };
      case 'sit':
        return { text: 'Sitting pretty' };
      case 'lie':
        return { text: 'Lying down for a bit' };
      case 'sniff':
        return { text: 'Sniffing around' };
      case 'bark':
        return { text: 'Barking at something' };
      default:
        return { text: 'Standing around, hoping for a treat' };
    }
  };

  const pat = (id: string) => {
    const entry = s.dogs.get(id);
    const card = dogCards.get(id);
    if (!entry || !card) return;
    // Step up beside it (the office pats the nearest dog within reach), facing it, then pat.
    const at = dogAt(entry.state, (performance.now() - entry.start) / 1000);
    const x = at.x + 0.9;
    const z = at.z;
    send({ t: 'move', x, y: 0, z, rotY: Math.atan2(at.x - x, at.z - z), moving: false });
    send({ t: 'dog.pet' });
    haptic();
    const n = addPat(floor, id);
    card.count.textContent = n === 1 ? 'First pat today' : `${n} pats today`;
    card.say.textContent = PAT_WORDS[(n - 1) % PAT_WORDS.length];
    card.say.classList.remove('is-on');
    void card.say.offsetWidth;
    card.say.classList.add('is-on');
    card.el.classList.remove('is-patted');
    void card.el.offsetWidth;
    card.el.classList.add('is-patted');
    const colors = ['var(--a-of-accent)', 'var(--a-of-heart)', 'var(--a-honey)'];
    for (let i = 0; i < 9; i++) {
      const heart = h('span.a-of-heart', { style: `--x:${12 + ((i * 29 + n * 11) % 76)}%;--d:${i * 70}ms;--c:${colors[i % 3]};--s:${0.7 + ((i * 7) % 5) / 10};--w:${(i % 2 ? 1 : -1) * (8 + i * 3)}px` }, heartGlyph(22));
      card.hearts.append(heart);
      setTimeout(() => heart.remove(), 1500 + i * 70);
    }
    card.lastPat = Date.now();
  };

  const paintDogs = () => {
    const list = [...s.dogs.entries()];
    if (!list.length) {
      dogCards.clear();
      dogs.replaceChildren();
      dogs.hidden = true;
      return;
    }
    dogs.hidden = false;
    if (!dogs.firstChild || dogs.dataset.n !== String(list.length)) {
      dogs.dataset.n = String(list.length);
      dogCards.clear();
      const family = list.some(([, d]) => isFamily(d.state.name));
      dogs.replaceChildren(secHead('a-of-dogs-h', list.length > 1 ? 'The corgis' : 'The corgi', family ? 'They’re family. A pat goes a long way.' : 'Every floor has one. They love a pat.'), h('div.a-of-dogs', { 'data-n': String(list.length) }));
    }
    const grid = dogs.querySelector<HTMLElement>('.a-of-dogs')!;
    for (const [id, { state: d, start }] of list) {
      const words = dogWords(d, start);
      const happy = d.act === 'wag';
      const sig = JSON.stringify([d.name, d.coat, happy, words]);
      let c = dogCards.get(id);
      if (!c) {
        const art = h('div.a-of-dog__portrait');
        const line = h('p.a-of-dog__doing');
        const count = h('p.a-of-dog__count');
        const label = h('span', {}, `Pat ${d.name}`);
        const btn = h('button.a-of-dog__pat', { type: 'button', 'aria-label': `Give ${d.name} a pat` }, heartGlyph(20), label) as HTMLButtonElement;
        btn.addEventListener('click', () => pat(id));
        const hearts = h('div.a-of-dog__hearts', { 'aria-hidden': 'true' });
        const say = h('span.a-of-dog__say', { role: 'status' });
        const el = h(
          'article.a-of-dog',
          { 'data-coat': String(d.coat % DOG_COATS.length), 'aria-labelledby': `a-of-dog-${id}` },
          hearts,
          say,
          art,
          h('div.a-of-dog__text', {}, h('h4.a-of-dog__name', { id: `a-of-dog-${id}` }, d.name), h('p.a-of-dog__coat', {}, `${COAT_NAMES[d.coat % COAT_NAMES.length]} corgi`), line),
          btn,
          count,
        );
        c = { el, art, line, count, btn, label, sig: '', hearts, say, lastPat: 0 };
        dogCards.set(id, c);
        grid.append(el);
        const n = patsToday(floor, id);
        count.textContent = n ? `${n} pat${n === 1 ? '' : 's'} today` : 'No pats yet today';
      }
      if (c.sig === sig) continue;
      c.sig = sig;
      c.art.replaceChildren(corgi(d.coat, happy));
      c.el.classList.toggle('is-happy', happy);
      c.el.dataset.tone = words.tone ?? '';
      c.line.replaceChildren(words.href ? h('a', { href: words.href }, words.text, icon('forward', 14)) : words.text);
      c.el.querySelector('.a-of-dog__name')!.textContent = d.name;
      c.label.textContent = `Pat ${d.name}`;
      c.btn.setAttribute('aria-label', `Give ${d.name} a pat`);
    }
  };
  // Where a dog is changes as it walks, without a new message: look again now and then.
  timers.push(setInterval(paintDogs, 2500));

  // ---- The office chat ----------------------------------------------------------------------------
  const log = h('ol.a-of-chat__log', { 'aria-label': 'Office chat', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const input = h('input.a-of-chat__input', { type: 'text', placeholder: 'Say something to everyone…', 'aria-label': 'Message the office', maxlength: '500', enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement;
  const sendBtn = h('button.a-of-chat__send', { type: 'button', 'aria-label': 'Send' }, icon('send', 20)) as HTMLButtonElement;
  const composer = h('form.a-of-chat__composer', {}, input, sendBtn) as HTMLFormElement;
  const syncSend = () => (sendBtn.disabled = !input.value.trim());
  input.addEventListener('input', syncSend);
  const say = () => {
    const text = input.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    input.value = '';
    syncSend();
    haptic();
  };
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    say();
  });
  sendBtn.addEventListener('click', say);
  syncSend();
  chat.append(secHead('a-of-chat-h', 'The office chat', edition.has3d ? 'Everyone in the building sees it, in the 3D office too.' : 'Everyone in every space sees it.'), h('div.a-of-chat', {}, log, composer));

  let shown = 0;
  let shownFirst: ChatLine | undefined;
  const lineEl = (c: ChatLine, prev: ChatLine | undefined) => {
    const me = c.from === s.you;
    const grouped = !!prev && prev.from === c.from && c.at - prev.at < 5 * 60_000;
    const day = !prev || dayLabel(prev.at) !== dayLabel(c.at);
    const out: HTMLElement[] = [];
    if (day) out.push(h('li.a-of-chat__day', {}, h('span', {}, dayLabel(c.at))));
    out.push(
      h(
        'li.a-of-chat__msg',
        { 'data-me': String(me), 'data-grouped': String(grouped && !day), style: `--a-who:${c.color}` },
        !me && (!grouped || day) ? h('span.a-of-chat__who', {}, h('span.a-of-chat__dot', { 'aria-hidden': 'true' }), bare(c.name), onPhone(c.name) ? phoneGlyph(11) : null) : null,
        h('span.a-of-chat__bubble', { title: new Date(c.at).toLocaleString() }, c.text),
        !grouped || day ? h('span.a-of-chat__time', {}, clockTime(c.at)) : null,
      ),
    );
    return out;
  };
  const paintChat = () => {
    const lines = s.chat.slice(-80);
    const nearBottom = shown === 0 || log.scrollHeight - log.scrollTop - log.clientHeight < 60 || lines[lines.length - 1]?.from === s.you;
    // The store drops the oldest line past 200, so a moving start means draw it all again.
    if (lines[0] !== shownFirst || lines.length < shown) {
      log.replaceChildren();
      shown = 0;
      shownFirst = lines[0];
    }
    if (!lines.length) {
      log.replaceChildren(h('li.a-of-chat__empty', {}, h('span.a-of-chat__wave', { 'aria-hidden': 'true' }, '👋'), h('span', {}, 'It’s quiet. Say hello to the office.')));
      shown = 0;
      return;
    }
    if (shown === 0) log.replaceChildren();
    for (let i = shown; i < lines.length; i++) log.append(...lineEl(lines[i], lines[i - 1]));
    shown = lines.length;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };

  // ---- The jukebox --------------------------------------------------------------------------------
  const streamInput = h('input.a-field__control.a-of-mono', { type: 'url', placeholder: 'https://… a radio stream or an .mp3', 'aria-label': 'Stream or audio file link', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' }) as HTMLInputElement;
  const streamErr = h('p.a-field__error', { hidden: true });
  const playStream = () => {
    const u = checkStreamUrl(streamInput.value);
    if ('error' in u) {
      streamErr.textContent = u.error;
      streamErr.hidden = false;
      return streamInput.focus();
    }
    streamErr.hidden = true;
    send({ t: 'jukebox.play', url: u.url });
    streamInput.value = '';
    haptic();
  };
  streamInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), playStream()));
  const streamBox = h(
    'details.a-of-jb__stream',
    {},
    h('summary', {}, 'Play a stream instead', icon('down', 16)),
    h('div.a-of-jb__streamrow', {}, streamInput, button({ label: 'Play', size: 'sm', variant: 'primary', onClick: playStream })),
    streamErr,
  );
  const jbNow = h('div.a-of-jb__now');
  const jbTunes = h('div.a-of-jb__tunes', { role: 'list', 'aria-label': 'Tunes' });
  jukebox.append(secHead('a-of-jb-h', 'The jukebox', 'It plays in the lounge, for everyone on this floor.'), h('div.a-of-jb', {}, jbNow, jbTunes, streamBox));
  let jbSig = '';
  const paintJukebox = () => {
    const j = s.jukebox;
    const sig = JSON.stringify([j.on, j.track, j.url, j.by]);
    if (sig === jbSig) return;
    jbSig = sig;
    const stream = j.track === STREAM;
    const tune = tuneById(j.track);
    const ctrl = (label: string, g: SVGElement, fn: () => void, primary = false) => {
      const b = h(primary ? 'button.a-of-jb__btn.is-primary' : 'button.a-of-jb__btn', { type: 'button', 'aria-label': label, title: label }, g) as HTMLButtonElement;
      b.addEventListener('click', () => (fn(), haptic()));
      return b;
    };
    jbNow.dataset.on = String(j.on);
    jbNow.replaceChildren(
      h('div.a-of-jb__disc', { 'aria-hidden': 'true' }, h('span.a-of-jb__label', {}, stream ? '📻' : '')),
      h(
        'div.a-of-jb__info',
        {},
        h('p.a-of-jb__state', {}, j.on ? h('span.a-of-jb__eq', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null, j.on ? 'Now playing' : 'The jukebox is off'),
        h('p.a-of-jb__title', {}, j.on ? trackTitle(j) : tune ? tune.title : trackTitle(j)),
        h('p.a-of-jb__meta', {}, j.on ? [stream ? 'A stream' : tune?.mood, j.by && `put on by ${bare(j.by)}`].filter(Boolean).join(' · ') : j.by ? `${bare(j.by)} turned it off` : 'Tap a tune to put it on'),
      ),
      h('div.a-of-jb__ctrls', {}, j.on ? ctrl('Skip to the next tune', skipGlyph(20), () => send({ t: 'jukebox.skip' })) : null, j.on ? ctrl('Stop the music', stopGlyph(18), () => send({ t: 'jukebox.stop' })) : ctrl(`Play ${trackTitle(j)}`, playGlyph(22), () => send({ t: 'jukebox.play' }), true)),
    );
    jbTunes.replaceChildren(
      ...JUKEBOX_TUNES.map((t, i) => {
        const playing = j.on && j.track === t.id;
        const b = h(
          'button.a-of-tune',
          { type: 'button', role: 'listitem', 'aria-pressed': String(playing), 'data-i': String(i), 'aria-label': playing ? `${t.title}, playing now` : `Put on ${t.title}` },
          h('span.a-of-tune__art', { 'aria-hidden': 'true' }, playing ? h('span.a-of-jb__eq', {}, h('i'), h('i'), h('i')) : musicGlyph(18)),
          h('span.a-of-tune__text', {}, h('span.a-of-tune__title', {}, t.title), h('span.a-of-tune__mood', {}, t.mood)),
        );
        b.addEventListener('click', () => {
          if (playing) return;
          send({ t: 'jukebox.play', track: t.id });
          haptic();
        });
        return b;
      }),
    );
  };

  // ---- Decorations ----------------------------------------------------------------------------------
  const paintTheme = () => {
    const { pick, active, by } = s.theme;
    const nowWords = active === 'halloween' ? 'Halloween is up right now.' : active === 'christmas' ? 'Christmas is up right now.' : 'No decorations are up right now.';
    theme.replaceChildren(
      secHead('a-of-theme-h', 'Decorations', `${nowWords} It’s the same on every floor${by ? `, picked by ${bare(by)}` : ''}.`),
      h(
        'div.a-of-themes',
        { role: 'radiogroup', 'aria-label': 'Holiday decorations' },
        ...THEME_PICKS.map((p) => {
          const wds = THEME_WORDS[p];
          const on = pick === p;
          const b = h(
            'button.a-of-theme',
            { type: 'button', role: 'radio', 'aria-checked': String(on), 'data-pick': p },
            h('span.a-of-theme__emoji', { 'aria-hidden': 'true' }, wds.emoji),
            h('span.a-of-theme__label', {}, wds.label),
            h('span.a-of-theme__note', {}, wds.note),
            on ? h('span.a-of-theme__check', { 'aria-hidden': 'true' }, icon('check', 14)) : null,
          );
          b.addEventListener('click', () => {
            if (s.theme.pick === p) return;
            send({ t: 'theme.set', pick: p });
            haptic();
            // Show the choice straight away; the office's answer confirms it.
            theme.querySelectorAll('.a-of-theme').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
          });
          return b;
        }),
      ),
    );
  };

  // ---- Live ---------------------------------------------------------------------------------------
  ctx.on('peers', () => (paintPeople(), paintDogs()));
  ctx.on('floor', paintPeople);
  ctx.on('dog', paintDogs);
  ctx.on('workers', paintDogs);
  ctx.on('chat', paintChat);
  ctx.on('jukebox', paintJukebox);
  ctx.on('theme', paintTheme);
  paintPeople();
  paintDogs();
  paintChat();
  paintJukebox();
  paintTheme();
  timers.push(setInterval(paintPeople, 5000));
  return () => timers.forEach(clearInterval);
};
