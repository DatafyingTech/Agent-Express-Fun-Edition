// 📋 A finished meeting, to read: Sonnet's recap on top, then the final write-up and what each agent
// said, round by round. It's the file the office saved in the floor's reports/meetings/ (see
// server/meetings.ts wrapUp), so it's also in 📊 Reports, and on the phone.

import { h, openModal, toast } from './dom';
import { markdown } from './markdown';
import { store } from '../state';

export async function openMinutes(saved: string, floor = store.floor) {
  const url = `/api/reports/file?floor=${encodeURIComponent(floor ?? '')}&path=${encodeURIComponent(saved)}`;
  const body = h('div.body.minutes-body', {}, h('p.muted', {}, 'Loading…'));
  const close = h('button.btn', { type: 'button' }, 'Close');
  const el = h(
    'div.modal.minutes',
    { role: 'dialog', 'aria-label': 'Meeting recap' },
    h('header', {}, h('h2', {}, '📋 Meeting recap')),
    body,
    h('footer', {}, h('span.grow.muted', {}, `Saved as ${saved}, and in 📊 Reports.`), h('a.btn', { href: url, target: '_blank', rel: 'noopener' }, '↗ Open the file'), close),
  );
  const modal = openModal(el, { doing: '📋 reading a meeting recap' });
  close.addEventListener('click', () => modal.close());
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'That meeting’s notes aren’t there any more' : `Couldn't open the meeting's notes (${res.status})`);
    body.replaceChildren(markdown(await res.text()));
  } catch (err) {
    body.replaceChildren(h('p.bad', {}, (err as Error).message));
    toast((err as Error).message, 'warn');
  }
}
