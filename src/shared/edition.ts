// Which app this build is. One codebase makes three of them:
//   hearth  Hearth, the calm mobile-first app (/app) on its own, with no 3D office in it at all
//   hq      Hearth HQ, the 3D office game, with the Hearth app alongside it for phones
//   office  the original Agent Office: the same as HQ under its old name, and what a checkout
//           runs when nothing says otherwise
//
// The server reads it from HEARTH_EDITION (the installers' runner, installer/hearth.mjs, sets it)
// or --edition. The client can't read either, so Vite bakes it in at build time as
// __HEARTH_EDITION__ (from HEARTH_EDITION, see vite.config.ts). Both fall back to DEFAULT_EDITION,
// which the release export sets for each public repo, so a fresh clone of either one is that app
// even when started by hand.

export type EditionId = 'hearth' | 'hq' | 'office';

export interface Edition {
  id: EditionId;
  /** The app's name, wherever people or agents read it: "Hearth". */
  name: string;
  /** The short form, for tight spots (a home-screen label). */
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
  hearth: { id: 'hearth', name: 'Hearth', shortName: 'Hearth', command: 'hearth', repo: 'DatafyingTech/Hearth', home: '/app', has3d: false, defaultPort: 4600, workspaceDir: 'Hearth' },
  hq: { id: 'hq', name: 'Hearth HQ', shortName: 'HQ', command: 'hearth-hq', repo: 'DatafyingTech/Hearth-HQ', home: '/', has3d: true, defaultPort: 4610, workspaceDir: 'HearthHQ' },
  office: { id: 'office', name: 'Agent Office', shortName: 'Office', command: 'agent-office', home: '/', has3d: true, defaultPort: 4600, workspaceDir: 'agent-office' },
};

/** What a build is when nothing says otherwise. The release export rewrites this line per repo. */
export const DEFAULT_EDITION: EditionId = 'hq';

/** The edition for a name ("hearth", "hq", "Hearth-HQ"...), or undefined for one we don't know. */
export function parseEdition(v: string | undefined | null): EditionId | undefined {
  const s = (v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'hearth') return 'hearth';
  if (s === 'hq' || s === 'hearthhq') return 'hq';
  if (s === 'office' || s === 'agentoffice') return 'office';
  return undefined;
}

// Defined by Vite in the client bundle only; on the server it doesn't exist, hence the typeof.
declare const __HEARTH_EDITION__: string | undefined;

function initial(): EditionId {
  if (typeof __HEARTH_EDITION__ !== 'undefined') return parseEdition(__HEARTH_EDITION__) ?? DEFAULT_EDITION;
  // The server: read without Node's types, since this file is shared with the browser build.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return parseEdition(env?.HEARTH_EDITION) ?? DEFAULT_EDITION;
}

/**
 * The running edition. A live binding: read it when it's needed (not into a module-level constant),
 * because the server's --edition is only parsed after every module has loaded (setEdition).
 */
export let edition: Edition = EDITIONS[initial()];

/**
 * How to run one of its commands on the office's computer, for instructions people read. Agent Office
 * installs a command of its own; Hearth's installers don't put one on the PATH, so it's the bin file
 * in the install folder.
 */
export function commandLine(sub: string): string {
  return edition.id === 'office' ? `${edition.command} ${sub}` : `node bin/${edition.command}.js ${sub} (in ${edition.name}'s folder)`;
}

/** The server's --edition, and a build that turns out to have no 3D office (see server.ts). */
export function setEdition(id: EditionId, overrides: Partial<Pick<Edition, 'has3d' | 'home'>> = {}) {
  edition = { ...EDITIONS[id], ...overrides };
}
