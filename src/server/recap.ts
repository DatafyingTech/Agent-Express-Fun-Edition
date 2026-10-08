// 📋 The recap on the meeting room's board, and a conversation meeting's shared memory. Once a meeting
// is over, Claude Sonnet (through the `claude` CLI the office already needs) reads everything said at
// the table and writes the short recap that goes up on the board. During a conversation meeting,
// Claude Haiku (small and cheap) folds each exchange into the memory every teammate reads.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { CLAUDE_MODEL_IDS } from '../shared/protocol.js';
import { spawnableClaude } from './claudecli.js';

const TIMEOUT_MS = 4 * 60_000;
/** The recap is for a board: longer than this and it's no longer a recap. */
const RECAP_MAX = 2400;
/** The shared memory of a conversation meeting: every teammate reads it before speaking, so it stays short. */
const MEMORY_MAX = 4000;

const SYSTEM = `You write the recap that goes up on the whiteboard in an office meeting room after a meeting of AI agents. It is for the person who called the meeting. You get the question they asked, who sat at the table, the final write-up and every note each agent wrote, round by round.

Write it in Markdown, exactly this shape:
# <the bottom line, at most 9 words: the decision or the answer>
- 4 to 7 bullets, each under 22 words: what was decided with its key numbers, where the agents agreed, where they disagreed (name the roles), the main risk, and what to do next.
**Open:** <what's still unresolved, in one line; leave this line out if nothing is>

Plain words. No preamble, no sign-off, nothing before the heading or after the last line. Use only what was said in the meeting: add no facts, numbers or advice of your own.`;

const MEMORY_SYSTEM = `You keep the shared memory of a live conversation meeting between a person and their AI teammates. You get the memory so far and the newest exchange (the person's message and each teammate's reply). Write the updated memory, which every teammate reads before they speak.

Write it in Markdown, exactly this shape:
# <what the meeting is about, at most 10 words>
## Where things stand
- the current answer, decision or plan, with its key numbers
## Who said what
- one line per teammate who has spoken: their role, their position, any number they gave
## Open
- what's still unresolved, or was asked and not yet answered
## Asked of the table
- the person's requests so far, newest last, one line each

Keep it under 400 words: merge, don't append, and drop what's been superseded. Plain words. No preamble, nothing outside that shape. Use only what was said: add nothing of your own.`;

/** Asks Sonnet for the recap of a meeting. Resolves to it, or to null when there's no model or it fails. */
export function writeRecap(claude: string | null, env: Record<string, string>, input: string, model: string = CLAUDE_MODEL_IDS.sonnet): Promise<string | null> {
  return runText(claude, env, input, model, SYSTEM, RECAP_MAX);
}

/**
 * Asks Haiku (small, quick and cheap) to fold the newest exchange of a conversation meeting into its
 * shared memory. Resolves to the new memory, or null when there's no model or it fails.
 */
export function writeMemory(claude: string | null, env: Record<string, string>, input: string): Promise<string | null> {
  return runText(claude, env, input, CLAUDE_MODEL_IDS.haiku, MEMORY_SYSTEM, MEMORY_MAX);
}

/** One answer from the `claude` CLI, with no tools, settings or session: its text, or null. */
function runText(claude: string | null, env: Record<string, string>, input: string, model: string, system: string, max: number): Promise<string | null> {
  if (!claude) return Promise.resolve(null);
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',
    // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    let out = '';
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // A neutral directory, so it doesn't pick up the project's CLAUDE.md.
    let child: ReturnType<typeof spawn>;
    try {
      const run = spawnableClaude(claude);
      child = spawn(run.command, [...run.prefix, ...args], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      // It couldn't be started at all: no recap rather than a stuck one.
      return finish(null);
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, TIMEOUT_MS);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => (out += d));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? parse(out, max) : null));
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

function parse(out: string, max: number): string | null {
  try {
    const res = JSON.parse(out);
    if (res?.is_error || typeof res?.result !== 'string') return null;
    const text = res.result.replace(/^```(markdown|md)?\s*|\s*```$/g, '').trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  } catch {
    return null;
  }
}
