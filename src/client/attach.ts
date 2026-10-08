// Screenshots and PDFs for the agents: pick or paste one, the office saves it into the floor's own
// folder (attachments/, kept out of git), and the message says where it is so the agent opens it with
// its Read tool, and records what it shows in the floor's shared memory (memory/) for the whole team.
// Big photos are shrunk first: legible, and far fewer tokens for the agent to look at.

import { h, toast } from './ui/dom';
import { store } from './state';

/** The longest side an image is sent at. Screenshots of statements stay readable at this size. */
const MAX_SIDE = 2048;
const MAX_BYTES = 15 * 1024 * 1024;

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f: File) => f.type.startsWith('image/');

async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const png = file.type === 'image/png';
    // Small enough already: send it as it is.
    if (scale === 1 && file.size < 4 * 1024 * 1024) return await asDataUrl(file);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Saves an image or a PDF on the office's machine, in the floor's attachments/; resolves to its full path there. */
export async function uploadImage(file: File, floor = store.floor): Promise<string> {
  const pdf = isPdf(file);
  if (!pdf && !isImage(file)) throw new Error(`${file.name || 'That file'} isn't an image or a PDF`);
  if (file.size > (pdf ? MAX_BYTES : MAX_BYTES * 3)) throw new Error(`${file.name || 'That file'} is too big (15 MB at most)`);
  // A PDF goes as it is (whatever type the phone gave it); a big photo is shrunk first.
  const dataUrl = pdf ? (await asDataUrl(file)).replace(/^data:[^;]*;/, 'data:application/pdf;') : await shrink(file);
  const res = await fetch(`/api/attach?floor=${encodeURIComponent(floor ?? '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, dataUrl }),
  });
  const j = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !j.path) throw new Error(j.error ?? `Upload failed (${res.status})`);
  return j.path;
}

/** Who's sending, for the note: your account's name, else the name you picked, without the phone's 📱. */
function senderName(): string {
  const name = (store.me.account?.name || store.profile.name || '').replace(/\s*📱\s*$/u, '').trim();
  return name && name !== 'Guest' ? name : 'Someone';
}

/** The lines added to a message that has files with it, signed by `who` (you, unless the caller knows better). */
export function attachNote(paths: string[], who = senderName()): string {
  if (!paths.length) return '';
  const lines = paths.map((p) => `- ${p}`).join('\n');
  const one = paths.length === 1;
  return `\n\n📎 ${who} attached ${one ? 'a file' : `${paths.length} files`} (screenshots or PDFs). Open ${one ? 'it' : 'each one'} with your Read tool before you answer. Then, before you finish, write down what ${one ? 'it shows' : 'they show'} in this floor's shared memory (memory/: the day's log, any data files, and CURRENT.md), so every teammate on the floor knows it too:\n${lines}`;
}

/**
 * A 📎 button and the chips of what's attached, for a message box. Pasting an image into `pasteInto`
 * attaches it too. `upload()` sends them all and resolves to their paths.
 */
export function attachments(pasteInto?: HTMLElement) {
  const files: File[] = [];
  const input = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf', multiple: true, class: 'hidden' }) as HTMLInputElement;
  const chips = h('div.attach-chips');
  const button = h('button.btn.attach-btn', { type: 'button', title: 'Attach screenshots, photos or PDFs (you can also paste a screenshot)' }, '📎 Attach');
  const render = () =>
    chips.replaceChildren(
      ...files.map((f, i) => {
        let thumb: HTMLElement;
        if (isPdf(f)) thumb = h('span.attach-pdf', { title: f.name }, '📄', h('small', {}, f.name.slice(0, 14)));
        else {
          const img = h('img', { alt: '' }) as HTMLImageElement;
          img.src = URL.createObjectURL(f);
          img.onload = () => URL.revokeObjectURL(img.src);
          thumb = img;
        }
        return h('span.attach-chip', {}, thumb, h('button', { type: 'button', 'aria-label': 'Remove', title: 'Remove', onclick: () => (files.splice(i, 1), render()) }, '✕'));
      }),
    );
  const add = (list: Iterable<File>) => {
    for (const f of list) if (isImage(f) || isPdf(f)) files.push(f);
    render();
  };
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    add(input.files ?? []);
    input.value = '';
  });
  const paste = (e: ClipboardEvent) => {
    const got = [...(e.clipboardData?.files ?? [])].filter((f) => isImage(f) || isPdf(f));
    if (!got.length) return;
    e.preventDefault();
    add(got);
    toast(`📎 ${got.length === 1 ? 'File' : `${got.length} files`} attached`);
  };
  pasteInto?.addEventListener('paste', paste);
  return {
    element: h('div.attach', {}, button, input, chips),
    count: () => files.length,
    /** Attaches the files in a paste event (for a box that binds its own paste handler). */
    paste,
    async upload(): Promise<string[]> {
      const paths: string[] = [];
      for (const f of files) paths.push(await uploadImage(f));
      return paths;
    },
    clear() {
      files.length = 0;
      render();
    },
  };
}
