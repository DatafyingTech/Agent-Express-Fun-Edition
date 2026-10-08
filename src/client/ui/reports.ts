// 📊 Reports: the files the agents made for you on this floor (budget dashboards, PDFs, charts),
// newest first. Each one opens in a new tab, on a phone as well as on the PC (see server/reports.ts).

import { h, openModal, timeAgo, toast } from './dom';
import { store } from '../state';

interface ReportFile {
  path: string;
  size: number;
  modified: number;
}

const ICON: Record<string, string> = { html: '📊', htm: '📊', pdf: '📄', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', gif: '🖼️', svg: '🖼️', csv: '🧾', md: '📝', txt: '📝' };

export async function openReports(floor = store.floor) {
  const list = h('ul.reports-list', {}, h('li.muted', {}, 'Loading…'));
  const floorName = store.floors.find((f) => f.id === floor)?.name ?? 'this floor';
  const el = h(
    'div.modal.reports',
    { role: 'dialog', 'aria-label': 'Reports' },
    h('header', {}, h('h2', {}, `📊 Reports · ${floorName}`)),
    h('div.body', {}, h('p.setting-note', { style: 'margin:0 0 10px' }, 'What the team made for you here: budget reports, PDFs and charts. Tap one to open it. Ask a teammate for a fresh one any time.'), list),
  );
  openModal(el, { doing: 'reading the reports' });
  try {
    const res = await fetch(`/api/reports?floor=${encodeURIComponent(floor ?? '')}`, { cache: 'no-store' });
    const j = (await res.json()) as { files?: ReportFile[]; error?: string };
    if (!res.ok || !j.files) throw new Error(j.error ?? `Couldn't list the reports (${res.status})`);
    if (!j.files.length) {
      list.replaceChildren(h('li.muted', {}, 'Nothing here yet. Ask a teammate for one, like “make me this week’s budget report”.'));
      return;
    }
    list.replaceChildren(
      ...j.files.map((f) => {
        const ext = f.path.split('.').pop()!.toLowerCase();
        const url = `/api/reports/file?floor=${encodeURIComponent(floor ?? '')}&path=${encodeURIComponent(f.path)}`;
        return h(
          'li',
          {},
          h(
            'a.reports-item',
            { href: url, target: '_blank', rel: 'noopener' },
            h('span.reports-icon', {}, ICON[ext] ?? '📄'),
            h('span', {}, h('b', {}, f.path.split('/').pop()!), h('small', {}, `${f.path.split('/')[0]} · ${timeAgo(f.modified)} · ${(f.size / 1024).toFixed(0)} KB`)),
          ),
        );
      }),
    );
  } catch (err) {
    list.replaceChildren();
    toast((err as Error).message, 'warn');
  }
}
