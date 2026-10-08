import * as THREE from 'three';
import { MEETING_PATTERNS, meetingSummary } from '../../shared/meetings';
import { fmtCost, fmtTokens, type Meeting, type MeetingMessage, type MeetingState, type WorkerTask } from '../../shared/protocol';
import { TEAM_BY_ID } from '../../shared/team';
import { store } from '../state';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const INK = '#2b2d42';

function canvasTexture(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, g: canvas.getContext('2d')!, texture };
}

/** Breaks text into lines no wider than `maxW`, cutting words too long for a line of their own. */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (cur && g.measureText(`${cur} ${word}`).width > maxW) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
    while (g.measureText(cur).width > maxW && cur.length > 1) {
      let cut = cur.length - 1;
      while (cut > 1 && g.measureText(cur.slice(0, cut)).width > maxW) cut--;
      lines.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Who has the floor right now: the roles on the parts being worked on. */
export function speaking(m: Meeting): string[] {
  return m.turns.filter((t) => t.state !== 'done').map((t) => m.seats[t.seat]?.role ?? '?');
}

// ---------------------------------------------------------------------------
// Conversation meetings (pattern 'talk'): who's who at the table, and who owes a reply.

/** Colours for a seat whose worker has gone home, so its lines still read as its own. */
const SEAT_COLORS = ['#ff8a5b', '#5bc0eb', '#9b5de5', '#06d6a0', '#f15bb5', '#fee440', '#00bbf9', '#ef476f'];

/** A seat's name in a conversation: the teammate sitting there, or its job when it's a helper. */
export function seatName(m: Meeting, i: number): string {
  const s = m.seats[i];
  if (!s) return 'Someone';
  return (s.member && TEAM_BY_ID.get(s.member)?.name) || s.role;
}

/** The teammate's emoji, or a chair for a helper. */
export function seatEmoji(m: Meeting, i: number): string {
  const s = m.seats[i];
  return (s?.member && TEAM_BY_ID.get(s.member)?.emoji) || '🪑';
}

/** A seat's colour: its worker's, so the thread matches the people at the table. */
export function seatColor(m: Meeting, i: number): string {
  const s = m.seats[i];
  const w = s?.workerId ? store.workers.get(s.workerId) : undefined;
  return w?.color ?? (s?.member && TEAM_BY_ID.get(s.member)?.color) ?? SEAT_COLORS[i % SEAT_COLORS.length];
}

/** Who said a line, in a word or two: "Sam" (without the phone mark), or the seat's name. */
export function saidBy(m: Meeting, msg: MeetingMessage): string {
  if (msg.from === 'you') return (msg.by ?? 'Someone').replace(/\s*📱\s*$/u, '');
  return seatName(m, msg.from);
}

/** Who a line from the office was for: "everyone", or the seats it named. */
export function saidTo(m: Meeting, msg: MeetingMessage): string {
  return msg.to?.length ? andList(msg.to.map((i) => seatName(m, i))) : 'everyone';
}

/** The seats that owe a reply, each once, in seat order. */
export function thinkingSeats(m: Meeting): number[] {
  return [...new Set((m.replying ?? []).map((r) => r.seat))].sort((a, b) => a - b);
}

/** How many things people and seats have said, leaving out the office's own notes. */
export function messageCount(m: Meeting): number {
  return (m.thread ?? []).filter((x) => !x.system).length;
}

const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** "Sam’s", "James’" */
const possessive = (name: string) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** Where a conversation is, in a line: "6 messages · Ada and Ben thinking", or whose turn it is. */
export function talkStage(m: Meeting): string {
  const said = plural(messageCount(m), 'message');
  if (m.status !== 'running') return `${said} · ${m.status === 'done' ? 'over' : 'ended'}`;
  const who = thinkingSeats(m).map((i) => seatName(m, i));
  return `${said} · ${who.length ? `${andList(who)} thinking` : 'your turn to talk'}`;
}

/**
 * The card over a worker at a conversation table: who they are, and whether they owe a reply
 * ("Thinking about Sam's question") or are listening.
 */
export function talkCard(m: Meeting, i: number): WorkerTask {
  const name = seatName(m, i);
  if (m.status !== 'running') return { name: `${name} · 💬 Conversation`, summary: m.status === 'done' ? '✅ Over: press E at the table to keep talking' : `⛔ Ended: ${m.reason ?? 'stopped'}` };
  const owed = (m.replying ?? []).filter((r) => r.seat === i);
  if (!owed.length) return { name: `👂 ${name} · in conversation`, summary: 'Listening' };
  // The reply under way first: a seat answers one message at a time, the others wait their turn.
  const r = owed.find((x) => x.state !== 'waiting') ?? owed[0];
  const msg = m.thread?.find((x) => x.id === r.re);
  const asker = msg ? possessive(saidBy(m, msg)) : 'the';
  const more = owed.length > 1 ? ` (+${owed.length - 1} more)` : '';
  const summary = r.state === 'working' ? `Thinking about ${asker} question` : r.state === 'sent' ? `Reading ${asker} message` : `${asker} message is next`;
  return { name: `💭 ${name} · in conversation`, summary: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}${more}` };
}

/** Markdown down to plain text for a canvas: no emphasis marks, links as their words. */
const plain = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

/** What's on the table in a line: "Round 2 of 3 · critiquing". */
export function meetingStage(m: Meeting): string {
  if (m.pattern === 'talk') return talkStage(m);
  const doing = [...new Set(m.turns.filter((t) => t.state !== 'done').map((t) => t.doing))].join(', ');
  if (m.followup) return `Follow-up ${m.followup}${doing ? ` · ${doing}` : ''}`;
  return `Round ${m.round} of ${m.rounds}${doing ? ` · ${doing}` : ''}`;
}

/**
 * The board on the meeting room's back wall: the meeting's output file as it's being written, like a
 * shared screen, with what's being worked on across the top.
 */
export class MeetingBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1500, 500);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(state: MeetingState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#fbfdff';
    g.fillRect(0, 0, W, H);
    const m = state.current;
    g.textBaseline = 'alphabetic';
    if (!m) {
      g.fillStyle = INK;
      g.textAlign = 'center';
      g.font = `900 64px ${FONT}`;
      g.fillText('🤝 The meeting room is free', W / 2, H / 2 - 10);
      g.font = `700 36px ${FONT}`;
      g.fillStyle = '#5c5f73';
      g.fillText('Press E at the table to call a meeting: whatever it writes shows up here.', W / 2, H / 2 + 50);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }
    const p = MEETING_PATTERNS[m.pattern];
    // Across the top: the file, and where the meeting is.
    g.fillStyle = m.status === 'stopped' ? '#ffd6e0' : m.status === 'done' ? '#caffbf' : '#e7f5ff';
    g.fillRect(0, 0, W, 70);
    g.fillStyle = INK;
    const talk = m.pattern === 'talk';
    g.font = `800 34px ${FONT}`;
    const recapping = m.recapState === 'writing' ? (talk ? '✍️ Haiku is writing the recap…' : '✍️ Sonnet is writing the recap…') : '';
    const where = m.status === 'running' ? meetingStage(m) : recapping || (talk ? talkStage(m) : m.status === 'done' ? '✅ done' : '⛔ stopped');
    // A conversation's title takes the room up top; who's thinking is along the board's bottom already.
    const right = talk && m.status === 'running' ? `${p.icon} ${p.label} · ${plural(messageCount(m), 'message')}` : `${p.icon} ${p.label} · ${where}`;
    const rightW = g.measureText(right).width;
    if (m.recap) {
      g.font = `900 36px ${FONT}`;
      g.fillText('📋 Meeting recap', 24, 48);
    } else if (talk) {
      // A conversation writes no file as it goes: its title goes up top instead, cut to what fits.
      g.font = `900 36px ${FONT}`;
      g.fillText(wrap(g, m.title, Math.max(200, W - rightW - 90))[0] ?? '', 24, 48);
    } else {
      g.font = `800 36px ${MONO}`;
      g.fillText(`📄 ${m.output}`, 24, 48);
    }
    g.font = `800 34px ${FONT}`;
    g.textAlign = 'right';
    g.fillText(right, W - 24, 48);
    g.textAlign = 'left';
    if (m.recap && m.status !== 'running') {
      this.recap(m.recap, !!m.saved);
      this.texture.needsUpdate = true;
      return;
    }
    if (talk) {
      this.talk(m);
      this.texture.needsUpdate = true;
      return;
    }

    const text = (m.preview ?? '').replace(/\r/g, '');
    if (!text.trim()) {
      g.fillStyle = '#8d99ae';
      g.font = `800 44px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(m.status === 'running' ? `Nothing written yet: ${speaking(m).join(', ') || 'the table'} ${speaking(m).length === 1 ? 'is' : 'are'} on it` : m.reason ? `⛔ ${m.reason}` : 'Nothing was written', W / 2, H / 2 + 30);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }
    // The file, markdown-ish: headings bold and bigger, the rest as it is. Only what fits: its start.
    let y = 118;
    const x = 30;
    const maxW = W - 60;
    for (const raw of text.split('\n')) {
      if (y > H - 14) break;
      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      const line = heading ? heading[2] : raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
      const size = heading ? (heading[1].length === 1 ? 44 : 36) : 28;
      g.font = heading ? `900 ${size}px ${FONT}` : `600 ${size}px ${FONT}`;
      g.fillStyle = heading ? INK : '#3d405b';
      if (!line.trim()) {
        y += size * 0.5;
        continue;
      }
      for (const l of wrap(g, line, maxW)) {
        if (y > H - 14) break;
        g.fillText(l, x, y);
        y += size * 1.25;
      }
    }
    this.texture.needsUpdate = true;
  }

  /**
   * A conversation on the board: the latest exchange on the left (what was said and to whom, then each
   * answer in its seat's colour, and who's still thinking), and what the table knows on the right.
   */
  private talk(m: Meeting) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const split = Math.round(W * 0.6);
    const x = 30;
    const maxW = split - x - 24;
    const bottom = H - 16;
    const thread = m.thread ?? [];
    // The exchange: from the last thing someone in the office said, on.
    let from = -1;
    for (let k = thread.length - 1; k >= 0; k--) {
      if (thread[k].from === 'you' && !thread[k].system) {
        from = k;
        break;
      }
    }
    const exchange = from < 0 ? thread.slice(-3) : thread.slice(from);
    const thinking = m.status === 'running' ? thinkingSeats(m) : [];
    // Keep a line at the bottom for who's thinking.
    const textBottom = thinking.length ? bottom - 44 : bottom;
    let y = 116;
    for (const msg of exchange) {
      if (y > textBottom) break;
      if (msg.system) {
        g.font = `700 24px ${FONT}`;
        g.fillStyle = '#8d99ae';
        for (const l of wrap(g, `ℹ️ ${msg.text}`, maxW).slice(0, 2)) {
          if (y > textBottom) break;
          g.fillText(l, x, y);
          y += 30;
        }
        y += 6;
        continue;
      }
      const human = msg.from === 'you';
      const color = human ? '#ff8a5b' : seatColor(m, msg.from as number);
      // Who, in their colour, then what they said: as many lines as there's room for, the person's first.
      g.fillStyle = color;
      g.beginPath();
      g.arc(x + 10, y - 10, 10, 0, Math.PI * 2);
      g.fill();
      g.font = `900 28px ${FONT}`;
      g.fillStyle = INK;
      const head = human ? `${saidBy(m, msg)} → ${saidTo(m, msg)}` : `${seatEmoji(m, msg.from as number)} ${saidBy(m, msg)}`;
      g.fillText(wrap(g, head, maxW - 30)[0] ?? '', x + 30, y);
      y += 34;
      g.font = `600 26px ${FONT}`;
      g.fillStyle = '#3d405b';
      const lines = plain(msg.text.replace(/\r/g, ''))
        .split('\n')
        .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ').trim())
        .filter(Boolean)
        .flatMap((l) => wrap(g, l, maxW - 30));
      const room = Math.max(1, Math.floor((textBottom - y) / 31) + 1);
      const take = Math.min(lines.length, human ? Math.min(3, room) : Math.min(4, room));
      for (let k = 0; k < take; k++) {
        const more = k === take - 1 && lines.length > take;
        g.fillText(more ? `${lines[k].replace(/\s*\S*$/, '')} …` : lines[k], x + 30, y);
        y += 31;
      }
      y += 12;
    }
    if (thinking.length) {
      g.font = `800 28px ${FONT}`;
      g.fillStyle = '#5c5f73';
      g.fillText(wrap(g, `💭 ${andList(thinking.map((i) => seatName(m, i)))} ${thinking.length === 1 ? 'is' : 'are'} thinking…`, maxW)[0] ?? '', x, bottom - 8);
    } else if (m.status === 'running' && from >= 0) {
      g.font = `800 28px ${FONT}`;
      g.fillStyle = '#06a77d';
      if (y < bottom - 4) g.fillText('👂 Everyone has answered: your turn (E at the table)', x, Math.max(y + 10, bottom - 8));
    }

    // What the table knows: Haiku's shared memory, headings bold, bullets as dots.
    g.fillStyle = '#f3efff';
    g.fillRect(split, 70, W - split, H - 70);
    g.fillStyle = '#cdb4db';
    g.fillRect(split, 70, 4, H - 70);
    const mx = split + 26;
    const mW = W - mx - 24;
    g.fillStyle = INK;
    g.font = `900 30px ${FONT}`;
    g.fillText('🧠 What the table knows', mx, 116);
    if (m.memoryState === 'writing') {
      g.font = `800 22px ${FONT}`;
      g.fillStyle = '#7b2cbf';
      g.textAlign = 'right';
      g.fillText('Haiku is updating…', W - 24, 116);
      g.textAlign = 'left';
    }
    let my = 158;
    const memory = (m.memory ?? '').replace(/\r/g, '').split('\n');
    let shown = 0;
    for (const raw of memory) {
      const line = raw.trim();
      // The memory's own title repeats the meeting's, which is up top already.
      if (!line || /^#\s/.test(line)) continue;
      const heading = /^#{2,6}\s+(.*)$/.exec(line);
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      g.font = heading ? `900 24px ${FONT}` : `700 22px ${FONT}`;
      g.fillStyle = heading ? '#5a189a' : '#3d405b';
      const indent = bullet ? 22 : 0;
      for (const [k, l] of wrap(g, plain(heading ? heading[1] : bullet ? bullet[1] : line), mW - indent).entries()) {
        if (my > bottom) break;
        if (bullet && k === 0) g.fillText('•', mx, my);
        g.fillText(l, mx + indent, my);
        my += 28;
        shown++;
      }
      if (heading) my += 4;
    }
    if (!shown) {
      g.font = `700 22px ${FONT}`;
      g.fillStyle = '#8d99ae';
      for (const l of wrap(g, 'Nothing yet: Haiku writes it up after each exchange, so whoever you talk to next is caught up.', mW)) {
        g.fillText(l, mx, my);
        my += 28;
      }
    }
  }

  /** The recap: its bottom line big, the bullets under it, and how to read the whole meeting along the bottom. */
  private recap(text: string, readable: boolean) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const x = 34;
    const bottom = H - (readable ? 60 : 16);
    const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]*)`/g, '$1');
    let y = 130;
    for (const raw of text.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const size = heading ? 48 : 30;
      const indent = bullet ? 36 : 0;
      g.font = heading ? `900 ${size}px ${FONT}` : `700 ${size}px ${FONT}`;
      const lines = wrap(g, clean(heading ? heading[1] : bullet ? bullet[1] : line), W - 2 * x - indent);
      for (let k = 0; k < lines.length; k++) {
        if (y > bottom) break;
        if (bullet && k === 0) {
          g.fillStyle = '#06a77d';
          g.fillText('●', x, y);
        }
        g.fillStyle = heading ? INK : '#3d405b';
        g.fillText(lines[k], x + indent, y);
        y += size * 1.24;
      }
      if (heading) y += 10;
    }
    if (!readable) return;
    g.fillStyle = '#e7f5ff';
    g.fillRect(0, H - 46, W, 46);
    g.fillStyle = '#1d3557';
    g.font = `800 27px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('👆 Click the board (or press E here) to read the whole meeting', W / 2, H - 14);
    g.textAlign = 'left';
  }
}

/**
 * The panel on the glass beside the meeting room's door, like a room-booking screen: what's on, the
 * round, who has the floor and the tokens against the budget; once it's over, its one-line summary.
 */
export class MeetingSignTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(500, 800);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(state: MeetingState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const m = state.current;
    const pad = 28;
    const lines = (text: string, font: string, color: string, y: number, max: number, lh: number) => {
      g.font = font;
      g.fillStyle = color;
      for (const l of wrap(g, text, W - 2 * pad).slice(0, max)) {
        g.fillText(l, pad, y);
        y += lh;
      }
      return y;
    };
    g.fillStyle = !m ? '#2b2d42' : m.status === 'running' ? '#1d3557' : m.status === 'done' ? '#1b4332' : '#6a040f';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    // A strip across the top says whether the room is taken.
    const talk = m?.pattern === 'talk';
    const [strip, label] = !m ? ['#06d6a0', '● FREE'] : m.status === 'running' ? ['#ffd166', talk ? '● IN CONVERSATION' : '● IN A MEETING'] : m.status === 'done' ? ['#9ef01a', '✅ DONE'] : ['#ffb3c1', '⛔ STOPPED'];
    g.fillStyle = strip;
    g.fillRect(0, 0, W, 78);
    g.fillStyle = INK;
    g.font = `900 38px ${FONT}`;
    g.fillText(label, pad, 53);
    if (!m) {
      let y = lines('🤝 Meeting room', `900 50px ${FONT}`, '#fffaf3', 160, 2, 58);
      lines('Press E at the table to call a meeting: a conversation, a debate, lead & team, map-reduce, red / blue or a review panel.', `700 32px ${FONT}`, '#e9ecef', y + 30, 8, 42);
      this.texture.needsUpdate = true;
      return;
    }
    const p = MEETING_PATTERNS[m.pattern];
    let y = lines(`${p.icon} ${p.label}`, `800 34px ${FONT}`, '#ffd166', 130, 1, 40);
    y = lines(m.title, `900 44px ${FONT}`, '#fffaf3', y + 16, 3, 50);
    y += 18;
    if (m.status === 'running' && talk) {
      // A conversation: how much has been said, and who's thinking or whose turn it is.
      y = lines(`💬 ${plural(messageCount(m), 'message')}`, `900 36px ${FONT}`, '#e9ecef', y, 1, 44);
      const thinking = thinkingSeats(m).map((i) => seatName(m, i));
      y = lines(thinking.length ? `💭 ${andList(thinking)} ${thinking.length === 1 ? 'is' : 'are'} thinking…` : '👂 Waiting for someone to say something', `700 30px ${FONT}`, '#bde0fe', y + 8, 3, 38);
      if (m.memoryState === 'writing') lines('🧠 Haiku is updating the notes', `700 26px ${FONT}`, '#cdb4db', y + 6, 1, 34);
    }
    if (m.status === 'running') {
      if (!talk) {
        y = lines(meetingStage(m), `800 32px ${FONT}`, '#e9ecef', y, 3, 40);
        const who = speaking(m);
        if (who.length) lines(`💬 ${who.join(', ')}`, `700 30px ${FONT}`, '#bde0fe', y + 8, 3, 38);
      }
      // The budget, as a bar that fills up, and what's been spent.
      const f = Math.min(1, m.tokens / Math.max(1, m.budget));
      const barY = H - 118;
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(pad, barY, W - 2 * pad, 20);
      g.fillStyle = f > 0.9 ? '#ef476f' : f > 0.7 ? '#ffd166' : '#06d6a0';
      g.fillRect(pad, barY, (W - 2 * pad) * f, 20);
      g.fillStyle = '#fffaf3';
      g.font = `800 30px ${FONT}`;
      g.fillText(`${fmtTokens(m.tokens)} of ${fmtTokens(m.budget)} tokens`, pad, H - 58);
      g.font = `700 28px ${FONT}`;
      g.fillStyle = '#e9ecef';
      if (m.cost > 0) g.fillText(`${fmtCost(m.cost)}${m.costKnown ? '' : '+'} so far`, pad, H - 22);
    } else {
      // The summary line after the pattern, which is up top already.
      lines(meetingSummary(m).split(' · ').slice(1).join(' · '), `700 30px ${FONT}`, '#e9ecef', y, Math.floor((H - y) / 38), 38);
    }
    this.texture.needsUpdate = true;
  }
}
