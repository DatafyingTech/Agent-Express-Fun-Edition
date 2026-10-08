// The companion app's HTTP API (/app): a calm chat view of each teammate, the floor's shared memory,
// and the files people attached. Types only, shared by the server (chat.ts, memory.ts) and the app.
// Every route needs a signed-in browser and names its floor with ?floor=<id>.

import type { WorkerStatus } from './protocol.js';

/** A file attached to a message (see server/attachments.ts); open it with GET /api/attach/file?floor=&path=<path>. */
export interface ChatAttachment {
  /** As the message gave it: normally the full path on the office's machine, inside the floor's attachments/. */
  path: string;
  /** Just the file's name, for a caption. */
  name: string;
  kind: 'image' | 'pdf';
}

/** A tool the teammate used during a reply, in a few words: Read → "budget.csv", Bash → the command. */
export interface ChatTool {
  name: string;
  summary: string;
}

export interface ChatMessage {
  /** Stable while the message grows: a reply still being written keeps its id. */
  id: string;
  role: 'user' | 'assistant';
  /** Markdown, as written. At most 40,000 characters (cut short with "…"). */
  text: string;
  /** ms since the epoch: when the prompt was sent, or when the reply was last added to. */
  at: number;
  attachments?: ChatAttachment[];
  /** Every tool call of the reply's turn, in order. */
  tools?: ChatTool[];
}

/** A worker as the app lists it: who it is and how it is doing. Everything but lastMessageAt comes from WorkerInfo. */
export interface TeamEntry {
  id: string;
  name: string;
  /** The roster teammate it was hired as (shared/team.ts), by id. */
  role?: string;
  /** That teammate's emoji. */
  emoji?: string;
  color: string;
  status: WorkerStatus;
  /** Someone looked at it since it last finished or asked something: not "needs you" any more. */
  acked: boolean;
  /** When it went to done or needs_input (ms): whoever has waited longest goes first. */
  waitingSince?: number;
  /** Its latest prompt or tool, in a line. */
  activity?: string;
  title?: string;
  /** Seated but asleep: it costs nothing until woken. */
  parked?: boolean;
  /** The meeting it was called to, if it sits at the meeting table. */
  meeting?: string;
  kind: 'agent' | 'shell';
  /** When its transcript last changed (ms): the newest conversation first. Absent before its first message. */
  lastMessageAt?: number;
}

/** GET /api/team: every floor's workers, polled every few seconds. */
export interface TeamResponse {
  floors: { id: string; name: string; workers: TeamEntry[] }[];
}

/** GET /api/chat?floor=<id>&worker=<id> */
export interface ChatResponse {
  worker: TeamEntry;
  /** Oldest first, the newest 300 at most. Empty until the worker's session has a transcript. */
  messages: ChatMessage[];
}

/** A file in the floor's memory/ folder. */
export interface MemoryFile {
  /** Its name inside log/ or data/ (data/ can have subfolders: "2026/budget.csv"). */
  name: string;
  /** Relative to memory/, for GET /api/memory/file?path=: "log/2026-09-29.md", "data/transactions.csv". */
  path: string;
  size: number;
  /** ms since the epoch. */
  modified: number;
}

/** GET /api/memory?floor=<id> */
export interface MemoryResponse {
  /** memory/CURRENT.md, or '' when there isn't one yet. */
  current: string;
  /** memory/log/*.md, newest first. */
  logs: MemoryFile[];
  /** Every file under memory/data/, newest first. */
  data: MemoryFile[];
}

/** POST /api/memory/note?floor=<id> */
export interface MemoryNoteRequest {
  /** At most 4,000 characters. */
  text: string;
  /** Who it's from; the signed-in name when left out. */
  by?: string;
}

export interface MemoryNoteResponse {
  ok: true;
  /** Relative to memory/, like MemoryFile.path: "log/2026-09-29.md". */
  file: string;
}

/** What every route answers with when it can't do what was asked (with a 4xx/5xx status). */
export interface ApiError {
  error: string;
}
