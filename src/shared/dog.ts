// The office dogs: corgis. Every floor has one, and a floor with a dog-2.json has a second. The server decides what it does (see server/dog.ts) and sends
// one DogState per leg of its day. Every browser works out from that state where the dog is at any
// moment, so everyone on the floor sees it in the same spot without a stream of moves.

/** What the dog does once it gets where it's going. */
export type DogAct = 'stand' | 'sit' | 'lie' | 'nap' | 'sniff' | 'bark' | 'wag';

export interface DogState {
  /** Which of the floor's dogs: 'dog' for the first, 'dog-2' for a second. */
  id: string;
  name: string;
  /** Which of DOG_COATS it wears. */
  coat: number;
  /** This leg: from where it was when the leg began, on through each point in turn. Never empty. */
  path: [number, number][];
  /** Meters per second along the path. */
  speed: number;
  /** How long ago the leg began, in ms, as of when the server sent it. */
  elapsed: number;
  act: DogAct;
  /** Which way it faces once it's there (rotation around y; 0 looks down +z). */
  face?: number;
  /** Barking: the worker that needs input. Napping: the worker whose desk it's under. */
  workerId?: string;
  /** The person it's trotting after. */
  following?: string;
  /** Wagging: who just petted it. */
  petBy?: string;
}

export const DOG_NAME_MAX = 24;

/** A new floor's dog is called one of these until someone names it in ⚙️ Settings (none is a worker's name). */
export const DOG_NAMES = ['Biscuit', 'Pancake', 'Peanut', 'Pepper', 'Cookie', 'Bagel', 'Ziggy', 'Pretzel', 'Maple', 'Scout'];

/** Corgi coats: [body, chest, blaze and paws, ears]. */
export const DOG_COATS: [string, string, string][] = [
  ['#d9822b', '#fff8ee', '#b8641c'], // red and white
  ['#2d2826', '#fff8ee', '#1f1b19'], // tricolor
  ['#b5793f', '#fff6ea', '#7a4a22'], // sable
  ['#e7a864', '#fffaf2', '#c98541'], // fawn
];

/** Once it gets to a desk whose worker needs input, it barks this often... */
export const BARK_EVERY_S = 14;
/** ...for this long, then sits there quietly (still pointing) until someone answers. */
export const BARK_FOR_S = 120;

/** A name for a floor's dog, and a coat, picked from its id (and which dog it is) so it keeps them. */
export function dogDefaults(floorId: string, dogId = 'dog'): { name: string; coat: number } {
  let h = 0;
  for (const ch of dogId === 'dog' ? floorId : `${floorId}/${dogId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name: DOG_NAMES[h % DOG_NAMES.length], coat: (h >>> 8) % DOG_COATS.length };
}

/** Takes control characters out and trims to DOG_NAME_MAX; '' when nothing's left. */
export function cleanDogName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, DOG_NAME_MAX)
    .trim();
}

export function pathLength(path: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return len;
}

/** Seconds from the start of the leg until it arrives. */
export function legSeconds(s: Pick<DogState, 'path' | 'speed'>): number {
  return s.speed > 0 ? pathLength(s.path) / s.speed : 0;
}

export interface DogPose {
  x: number;
  z: number;
  /** Which way it's facing (rotation around y). */
  heading: number;
  /** Still on its way. */
  moving: boolean;
}

/** Where the dog is `t` seconds into its leg, and which way it faces. */
export function dogAt(s: Pick<DogState, 'path' | 'speed' | 'face'>, t: number): DogPose {
  const p = s.path;
  let left = Math.max(0, t) * s.speed;
  let heading = s.face ?? 0;
  for (let i = 1; i < p.length; i++) {
    const dx = p[i][0] - p[i - 1][0];
    const dz = p[i][1] - p[i - 1][1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    heading = Math.atan2(dx, dz);
    if (left < len) {
      const k = left / len;
      return { x: p[i - 1][0] + dx * k, z: p[i - 1][1] + dz * k, heading, moving: true };
    }
    left -= len;
  }
  const [x, z] = p[p.length - 1];
  return { x, z, heading: s.face ?? heading, moving: false };
}
