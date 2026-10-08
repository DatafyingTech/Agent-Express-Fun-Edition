// Which app this build is. One codebase makes three of them:
//   express  Agent Express, the calm mobile-first app (/app) on its own, with no 3D office in it at all
//   fun      Agent Express (Fun Edition), the 3D office game, with the Agent Express app alongside it
//            for phones
//   office   the original Agent Office: the same as the Fun Edition under its old name, and what a
//            checkout runs when nothing says otherwise
//
// The server reads it from AGENT_EXPRESS_EDITION (the installers' runner, installer/agent-express.mjs,
// sets it) or --edition. The client can't read either, so Vite bakes it in at build time as
// __AGENT_EXPRESS_EDITION__ (see vite.config.ts). Both fall back to DEFAULT_EDITION, which the release
// export sets for each public repo, so a fresh clone of either one is that app even when started by
// hand.
//
// The two public apps were first called Hearth (id "hearth") and Hearth HQ (id "hq"). Those ids, and
// HEARTH_EDITION, are still read, so an install or a script from then keeps working.

export type EditionId = 'express' | 'fun' | 'office';

export interface Edition {
  id: EditionId;
  /** The app's name, wherever people or agents read it: "Agent Express". */
  name: string;
  /** The short form, for tight spots (a home-screen label, a window title). */
  shortName: string;
  /** The command it runs as (package.json's "bin"), for help text and log lines. */
  command: string;
  /** The page `/` opens: the 3D office, or the app. */
  home: '/' | '/app';
  /** Whether this build has the 3D office (index.html, client/world/, three.js) at all. */
  has3d: boolean;
  /** Its public GitHub repository, owner/name (the original Agent Office has none of its own here). */
  repo?: string;
  /** The port and workspace folder the installers default to. */
  defaultPort: number;
  workspaceDir: string;
}

export const EDITIONS: Record<EditionId, Edition> = {
  express: { id: 'express', name: 'Agent Express', shortName: 'Agent Express', command: 'agent-express', repo: 'DatafyingTech/Agent-Express', home: '/app', has3d: false, defaultPort: 4600, workspaceDir: 'AgentExpress' },
  fun: { id: 'fun', name: 'Agent Express (Fun Edition)', shortName: 'Agent Express · Fun', command: 'agent-express-fun', repo: 'DatafyingTech/Agent-Express-Fun-Edition', home: '/', has3d: true, defaultPort: 4610, workspaceDir: 'AgentExpressFun' },
  office: { id: 'office', name: 'Agent Office', shortName: 'Office', command: 'agent-office', home: '/', has3d: true, defaultPort: 4600, workspaceDir: 'agent-office' },
};

/**
 * The name of the app view (/app, src/client/app/), the same in every edition: the Fun Edition and
 * Agent Office carry it alongside the 3D office, for phones.
 */
export const APP_NAME = 'Agent Express';

/** What a build is when nothing says otherwise. The release export rewrites this line per repo. */
export const DEFAULT_EDITION: EditionId = 'fun';

/**
 * The edition for a name ("express", "fun", "Agent Express (Fun Edition)", the old "hearth" and
 * "hq"...), or undefined for one we don't know.
 */
export function parseEdition(v: string | undefined | null): EditionId | undefined {
  const s = (v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (s === 'express' || s === 'agentexpress' || s === 'hearth') return 'express';
  if (s === 'fun' || s === 'funedition' || s === 'agentexpressfun' || s === 'agentexpressfunedition' || s === 'hq' || s === 'hearthhq') return 'fun';
  if (s === 'office' || s === 'agentoffice') return 'office';
  return undefined;
}

// Defined by Vite in the client bundle only; on the server it doesn't exist, hence the typeof.
declare const __AGENT_EXPRESS_EDITION__: string | undefined;

function initial(): EditionId {
  if (typeof __AGENT_EXPRESS_EDITION__ !== 'undefined') return parseEdition(__AGENT_EXPRESS_EDITION__) ?? DEFAULT_EDITION;
  // The server: read without Node's types, since this file is shared with the browser build.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return parseEdition(env?.AGENT_EXPRESS_EDITION || env?.HEARTH_EDITION) ?? DEFAULT_EDITION;
}

/**
 * The running edition. A live binding: read it when it's needed (not into a module-level constant),
 * because the server's --edition is only parsed after every module has loaded (setEdition).
 */
export let edition: Edition = EDITIONS[initial()];

/**
 * How to run one of its commands on the office's computer, for instructions people read. Agent Office
 * installs a command of its own; Agent Express's installers don't put one on the PATH, so it's the bin
 * file in the install folder.
 */
export function commandLine(sub: string): string {
  return edition.id === 'office' ? `${edition.command} ${sub}` : `node bin/${edition.command}.js ${sub} (in ${edition.name}'s folder)`;
}

/** The server's --edition, and a build that turns out to have no 3D office (see server.ts). */
export function setEdition(id: EditionId, overrides: Partial<Pick<Edition, 'has3d' | 'home'>> = {}) {
  edition = { ...EDITIONS[id], ...overrides };
}
