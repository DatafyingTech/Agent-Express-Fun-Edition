// The team: the named teammates offered when a worker is hired at a desk, and the crews that sit
// down together (☰ → Hire a crew). Each one sits down with its own name and color, its own model and
// effort (Opus for judgment and critique, Sonnet for writing, lookups and drawing, Haiku for lists and
// reminders), and a brief ahead of its first prompt: who it works for, what it's for, and the house
// rules for that kind of work, the way the board agents get theirs (server/stations.ts).
//
// Who's on it lives in roster.ts, which scripts/roster.mjs writes before every build, dev run and test
// (npm run roster does it by hand). It points at roster.local.ts when there is one, your own team,
// kept out of git, and otherwise at roster.default.ts, the generic team that ships. To change the
// roster, copy roster.default.ts to roster.local.ts, edit it, and rebuild (npm run build).

import { BRIEFS, CREWS as ROSTER_CREWS, DEPARTMENTS as ROSTER_DEPARTMENTS, DEPARTMENT_ICON as ROSTER_ICONS, TEAM as ROSTER_TEAM } from './roster.js';
import type { Crew, Teammate } from './roster-types.js';
import { edition } from './edition.js';

export type { Crew } from './roster-types.js';

export const DEPARTMENTS = ROSTER_DEPARTMENTS;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_ICON: Record<Department, string> = ROSTER_ICONS;

/** Departments about personal life, kept apart from the business: the app shows their spaces in plain words. */
export const PERSONAL_DEPARTMENTS: ReadonlySet<Department> = new Set<Department>(BRIEFS.personal);

/** A teammate on the roster (see Teammate for what each field is). */
export interface TeamMember extends Teammate<Department> {}

export const TEAM: readonly TeamMember[] = ROSTER_TEAM;

export const TEAM_BY_ID = new Map(TEAM.map((m) => [m.id, m]));

export const CREWS: readonly Crew[] = ROSTER_CREWS;

export const CREW_BY_ID = new Map(CREWS.map((c) => [c.id, c]));

/** What a teammate is told ahead of its first prompt. */
export function teamBrief(m: TeamMember, hasTask: boolean): string {
  // Looked up by plain string: BRIEFS is typed against its own roster file's departments.
  const contextFor: Partial<Record<string, string>> = BRIEFS.contextFor ?? {};
  const rulesFor: Partial<Record<string, string>> = BRIEFS.rulesFor ?? {};
  const extra = rulesFor[m.group];
  return [
    `You're the ${m.name} ${m.emoji}${m.title === m.name ? '' : ` (${m.title})`} on ${BRIEFS.team}, working at a desk in ${edition.name}.`,
    contextFor[m.group] ?? BRIEFS.context,
    m.focus,
    ...(extra ? [extra] : []),
    BRIEFS.sharedMemory,
    BRIEFS.rules,
    hasTask ? `Your first task:` : `Say hello in one line, saying who you are and what you can take on, then wait for your first task.`,
  ].join('\n\n');
}

/**
 * The task each member of a crew is given: the shared task, and who else sat down with them, so each
 * takes the part that fits their role instead of all doing the same thing.
 */
export function crewTask(task: string, m: TeamMember, crewmates: readonly TeamMember[], crew?: Crew): string {
  const others = crewmates.filter((c) => c.id !== m.id);
  if (!others.length) return task;
  const names = others.map((c) => `${c.name} (${c.title})`).join(', ');
  return [
    task,
    `You sat down as part of ${crew ? `the ${crew.name} crew` : 'a crew'} with ${names}, who were given this same task at the desks around you. Do the part that fits your role as ${m.title}, don't duplicate theirs, and end by saying what you'd hand to which of them.`,
  ].join('\n\n');
}
