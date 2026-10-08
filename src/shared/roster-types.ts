// The shapes a roster file fills in (roster.default.ts, or your own roster.local.ts). They're generic
// over the roster's own departments, so each roster file is checked against its own list rather than
// whichever one the build picked; team.ts pins them to the departments of the roster in use.

import type { AgentEffort, ClaudeModel } from './protocol.js';

export interface Teammate<D extends string = string> {
  /** Sent in worker.spawn; never shown. */
  id: string;
  /** The worker's name tag: what they do, so it reads at a glance above their head. */
  name: string;
  emoji: string;
  /** What they do, in a few words, for the hire dialog. */
  title: string;
  /** What to hire them for, in a line, under the picker. */
  pitch: string;
  group: D;
  color: string;
  /** The model they run on unless the hire dialog picks another (see CLAUDE_MODEL_IDS for what each is). */
  model: ClaudeModel;
  effort: AgentEffort;
  /** The role-specific part of the brief. */
  focus: string;
}

/** A group that sits down together from ☰ → Hire a crew. */
export interface Crew {
  id: string;
  name: string;
  emoji: string;
  /** What they're good for together. */
  blurb: string;
  members: readonly string[];
  /** The floor they work on, picked for you in the dialog (you can still choose another). */
  floor?: string;
}

/** The parts of every brief that aren't the teammate's own focus (see teamBrief in team.ts). */
export interface RosterBriefs<D extends string = string> {
  /** Whose team they're on, as in "You're the SOC Analyst 🛡️ on <team>, working at a desk…". */
  team: string;
  /** Who they work for and what the work is: the paragraph after the opening line, for most of the roster. */
  context: string;
  /** Departments whose people get another paragraph instead (personal life, a trading desk). */
  contextFor?: Partial<Record<D, string>>;
  /** House rules only one department's people need, right after their focus. */
  rulesFor?: Partial<Record<D, string>>;
  /** How the floor's shared memory (memory/) works; everyone gets it. */
  sharedMemory: string;
  /** The house rules everyone gets. */
  rules: string;
  /** Departments about personal life: the app shows their spaces in plain words (no model names, commands or file paths). */
  personal: readonly D[];
}
