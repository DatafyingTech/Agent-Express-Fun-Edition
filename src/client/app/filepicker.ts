// Screenshots and PDFs for a message box that isn't a chat (calling a meeting, a follow-up): a 📎
// button, thumbnails of what's attached, paste and drop. upload() saves them in the floor's
// attachments/ (client/attach.ts uploadImage) and resolves to their paths for the message.

import { uploadImage } from '../attach';
import { icon } from './icons';
import { fileSize, h } from './ui';

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f: File) => f.type.startsWith('image/');
/** As many as the server takes with one meeting or follow-up. */
const MAX_FILES = 12;

export interface FilePicker {
  /** The 📎 button. */
  button: HTMLElement;
  /** The thumbnails (empty, and takes no room, until something's attached). */
  chips: HTMLElement;
  count(): number;
  /** Saves them all on the office's machine; their paths there. Throws with a message to show. */
  upload(floor: string): Promise<string[]>;
  clear(): void;
}

/**
 * `compact` makes the button a round icon (a composer's), its label kept for screen readers; it shows
 * how many are attached in a small badge.
 */
export function filePicker(o: { pasteInto?: HTMLElement; dropOn?: HTMLElement; onChange?: () => void; label?: string; compact?: boolean; toast?: (text: string, level?: 'info' | 'warn' | 'error') => void } = {}): FilePicker {
  const files: File[] = [];
  const input = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf', multiple: true, hidden: true }) as HTMLInputElement;
  const button = h(
    'button.a-fp__btn',
    { type: 'button', class: o.compact ? 'a-fp__btn--compact' : undefined, 'aria-label': 'Attach photos, screenshots or PDFs', title: 'Attach photos, screenshots or PDFs' },
    icon('attach', o.compact ? 20 : 18),
    o.compact ? null : h('span', {}, o.label ?? 'Attach'),
    input,
  );
  const chips = h('div.a-fp__chips', { 'aria-label': 'Attached files' });
  const urls = new Map<File, string>();
  const render = () => {
    for (const [f, u] of urls) if (!files.includes(f)) (URL.revokeObjectURL(u), urls.delete(f));
    chips.replaceChildren(
      ...files.map((f, i) => {
        const remove = h('button.a-fp__remove', { type: 'button', 'aria-label': `Remove ${f.name}`, title: 'Remove' }, icon('close', 12));
        remove.addEventListener('click', () => {
          files.splice(i, 1);
          render();
          o.onChange?.();
        });
        if (isImage(f)) {
          let u = urls.get(f);
          if (!u) urls.set(f, (u = URL.createObjectURL(f)));
          return h('span.a-fp__chip.a-fp__chip--image', { title: f.name }, h('img', { src: u, alt: f.name }), remove);
        }
        return h('span.a-fp__chip.a-fp__chip--file', { title: f.name }, icon('file', 16), h('span.a-fp__name', {}, f.name), h('span.a-fp__size', {}, fileSize(f.size)), remove);
      }),
    );
    chips.hidden = !files.length;
    button.dataset.count = files.length ? String(files.length) : '';
  };
  const add = (list: Iterable<File>) => {
    let skipped = 0;
    for (const f of list) {
      if (!(isImage(f) || isPdf(f))) skipped++;
      else if (files.length < MAX_FILES) files.push(f);
    }
    if (skipped) o.toast?.('Only photos, screenshots and PDFs can be attached.', 'warn');
    render();
    o.onChange?.();
  };
  button.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  input.addEventListener('change', () => {
    add(input.files ?? []);
    input.value = '';
  });
  o.pasteInto?.addEventListener('paste', (e) => {
    const got = [...(e.clipboardData?.files ?? [])].filter((f) => isImage(f) || isPdf(f));
    if (!got.length) return;
    e.preventDefault();
    add(got);
  });
  if (o.dropOn) {
    const zone = o.dropOn;
    zone.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('is-dropping');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
    zone.addEventListener('drop', (e) => {
      zone.classList.remove('is-dropping');
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      add(e.dataTransfer.files);
    });
  }
  render();
  return {
    button,
    chips,
    count: () => files.length,
    async upload(floor) {
      const paths: string[] = [];
      for (const f of files) paths.push(await uploadImage(f, floor));
      return paths;
    },
    clear() {
      files.length = 0;
      render();
    },
  };
}
