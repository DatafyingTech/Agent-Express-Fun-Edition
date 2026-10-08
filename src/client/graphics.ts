// How hard the office works your GPU and CPU. Each browser picks for itself (⚙️ → Graphics), and a
// change reloads the page, since antialiasing is fixed when the renderer is made.

export type GraphicsLevel = 'eco' | 'smooth' | 'balanced' | 'full';

export interface GraphicsProfile {
  label: string;
  note: string;
  antialias: boolean;
  /** The most device pixels per CSS pixel it renders at. */
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
  /** Redraw the shadows this often, in ms; 0 is every frame. The sun barely moves, people do. */
  shadowEveryMs: number;
  /** The cartoon ink lines: a second pass over the whole scene. */
  outlines: boolean;
  /** Frames a second while you're in the office; 0 is as many as the screen shows. */
  fps: number;
  /** While a window (a terminal, a board) covers the office, or the office isn't the window you're in. */
  idleFps: number;
  /**
   * Draw see-through, two-sided things (the glass walls and windows) in one pass. Otherwise three.js
   * draws each twice, back then front, and sets its shader up again for both, every frame.
   */
  singlePassGlass: boolean;
}

export const GRAPHICS: Record<GraphicsLevel, GraphicsProfile> = {
  eco: {
    label: '🍃 Eco',
    note: 'Lightest on the machine: no shadows or ink outlines, no antialiasing, 30 frames a second, and 4 while a window covers the office or you are in another app.',
    antialias: false,
    pixelRatio: 1,
    shadows: false,
    shadowSize: 512,
    shadowEveryMs: 0,
    outlines: false,
    fps: 30,
    idleFps: 4,
    singlePassGlass: true,
  },
  smooth: {
    label: '🏎️ Smooth',
    note: 'As many frames as your screen shows, with the heavy extras trimmed: no ink outlines (they draw the whole office a second time) and shadows redrawn 10 times a second. Drops to 5 frames a second while a window covers the office or you are in another app, like a game.',
    antialias: true,
    pixelRatio: 1,
    shadows: true,
    shadowSize: 1024,
    shadowEveryMs: 100,
    outlines: false,
    fps: 0,
    idleFps: 5,
    singlePassGlass: true,
  },
  balanced: {
    label: '⚖️ Balanced',
    note: 'The cartoon look with smaller shadows redrawn 8 times a second, at 45 frames a second, and 8 while a window covers the office or you are in another app.',
    antialias: true,
    pixelRatio: 1,
    shadows: true,
    shadowSize: 1024,
    shadowEveryMs: 125,
    outlines: true,
    fps: 45,
    idleFps: 8,
    singlePassGlass: true,
  },
  full: {
    label: '✨ Full',
    note: 'Everything, every frame, at up to twice the resolution on a sharp screen: the way the office was built to look, and the hardest on your GPU.',
    antialias: true,
    pixelRatio: 2,
    shadows: true,
    shadowSize: 2048,
    shadowEveryMs: 0,
    outlines: true,
    fps: 0,
    idleFps: 0,
    singlePassGlass: false,
  },
};

export const GRAPHICS_LEVELS = Object.keys(GRAPHICS) as GraphicsLevel[];

const KEY = 'agent-office.graphics';

export function loadGraphics(): GraphicsLevel {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in GRAPHICS) return saved as GraphicsLevel;
  } catch {
    // storage blocked
  }
  // A phone's GPU and battery: the lightest look unless someone picks another.
  try {
    if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) return 'eco';
  } catch {
    // no matchMedia
  }
  return 'smooth';
}

export function saveGraphics(level: GraphicsLevel) {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    // storage blocked
  }
}

/** Glass and the like, drawn in one pass (see singlePassGlass). Cheap enough to run every second or so, which catches things added later. */
export function singlePassGlass(root: { traverse(fn: (o: any) => void): void }) {
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    // 2 is THREE.DoubleSide.
    for (const m of mats) if (m.transparent && m.side === 2 && !m.forceSinglePass) m.forceSinglePass = true;
  });
}

/**
 * Whether this frame should be drawn: at most `fps` a second (0 draws every one). Allows for the
 * screen's own frames not lining up exactly, so 30 on a 60 Hz screen is every other frame.
 */
export class FrameGate {
  private last = -Infinity;

  due(now: number, fps: number): boolean {
    if (fps <= 0) return true;
    const gap = 1000 / fps;
    if (now - this.last < gap - 4) return false;
    // Keep to the rhythm rather than drifting later every frame, but never bank a backlog.
    this.last = now - this.last > gap * 2 ? now : this.last + gap;
    return true;
  }
}
