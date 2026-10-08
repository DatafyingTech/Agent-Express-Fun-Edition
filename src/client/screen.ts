// A terminal's colors and the shape of a worker's screen, shared by the terminal window, the store
// and the 3D office's laptops (world/laptop.ts). Kept apart from the laptops so code that only needs
// these never loads three.js.

import type { Run } from '../shared/protocol';

export const TERM_THEME = {
  background: '#1e1f2e',
  foreground: '#e6e6f0',
  cursor: '#ffd166',
  selectionBackground: '#44475a',
  black: '#282a36',
  red: '#ff5c7a',
  green: '#7cf29a',
  yellow: '#ffd166',
  blue: '#6cb6ff',
  magenta: '#d69cff',
  cyan: '#72ddf7',
  white: '#e6e6f0',
  brightBlack: '#6c7086',
  brightRed: '#ff8fa3',
  brightGreen: '#a6f4b8',
  brightYellow: '#ffe29a',
  brightBlue: '#9ccfff',
  brightMagenta: '#e5c1ff',
  brightCyan: '#a5ecfb',
  brightWhite: '#ffffff',
};

/** A worker's terminal as the server sends it (screen.ts on the server), painted by the laptops. */
export interface ScreenState {
  cols: number;
  rows: number;
  lines: Run[][];
  cursor: [number, number];
  version: number;
}
