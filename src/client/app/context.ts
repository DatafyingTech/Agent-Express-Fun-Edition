// The contract between the pieces of the companion app (/app): the shell (app/main.ts) owns routing,
// the connection and the layout; each screen is a View that renders into the root it's given.
// Screens never talk to each other directly: they go through ctx.go() and the shared store.
//
// The app is the same office as the 3D one: same login, same WebSocket protocol (shared/protocol.ts),
// same workers, same floor memory. A "space" in the app is a floor in the office.

import type { Net } from '../net';
import type { Topic, store as Store } from '../state';

export type Route =
  | { view: 'home' }
  | { view: 'chats' }
  | { view: 'space'; floor: string }
  | { view: 'chat'; floor: string; worker: string }
  | { view: 'memory'; floor: string }
  | { view: 'reports'; floor: string }
  | { view: 'hire'; floor: string }
  | { view: 'meeting'; floor: string }
  /** Space segments beyond Team / Notes / Reports: the meeting room, the task queue, GitHub. */
  | { view: 'meetings'; floor: string }
  | { view: 'tasks'; floor: string }
  | { view: 'github'; floor: string }
  /** A sheet over the space: the office itself (people, office chat, jukebox, the dogs, the theme). */
  | { view: 'office'; floor: string }
  /** A teammate's live terminal, with keys for answering its prompts (a screen above the chat). */
  | { view: 'terminal'; floor: string; worker: string }
  /** A teammate's changes: the diff, commit, discard, open a PR (a screen above the chat). */
  | { view: 'changes'; floor: string; worker: string }
  | { view: 'settings' };

export interface AppContext {
  net: Net;
  store: typeof Store;
  /** The space (office floor) on screen. The shell keeps the server's floor in step with it (floor.go). */
  floor(): string | null;
  /** Show another screen. Updates the URL hash, so the back button and a reload work. */
  go(route: Route): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Subscribe to a store topic for as long as the view is on screen; returns an unsubscribe. */
  on(topic: Topic, fn: () => void): () => void;
}

/**
 * A screen. Render into `root` (the shell has already emptied it) and return a cleanup that drops
 * timers and subscriptions, or nothing.
 */
export type View = (root: HTMLElement, ctx: AppContext, route: Route) => (() => void) | void;
