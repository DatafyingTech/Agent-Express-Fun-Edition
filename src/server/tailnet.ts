import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// Where people reach this office from their own phones and computers: this machine's name on its
// Tailscale network (tailscale status --json → Self.DNSName), with the office's port. An invite
// link or "open this on your phone" made at localhost would only ever open on this machine, so the
// browsers use this instead (see client/share.ts). It's looked up in the background and again every
// few minutes, since Tailscale may start after the office or not be installed at all; until it's
// known (or without Tailscale) there's simply no share address, and the browsers use their own.

const LOOKUP_TIMEOUT_MS = 5000;
const REFRESH_MS = 5 * 60_000;

/** Where the tailscale CLI lives when it isn't on the PATH (the Windows and macOS app installs). */
const CLI_FALLBACKS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
};

/** This machine's MagicDNS name from `tailscale status --json`, without the trailing dot, or null when it isn't connected. */
export function tailnetName(statusJson: string): string | null {
  let s: { BackendState?: unknown; Self?: { DNSName?: unknown; Online?: unknown } };
  try {
    s = JSON.parse(statusJson);
  } catch {
    return null;
  }
  if (s.BackendState !== undefined && s.BackendState !== 'Running') return null;
  const name = typeof s.Self?.DNSName === 'string' ? s.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  // A DNS name, nothing that could break out of a URL.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null;
}

/** The origin a browser elsewhere on the tailnet opens: http(s)://<name>[:port], the port left out when it's the scheme's own. */
export function shareOrigin(name: string, port: number, tls: boolean): string {
  return new URL(`${tls ? 'https' : 'http'}://${name}:${port}`).origin;
}

function run(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, ['status', '--json'], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export class Tailnet {
  /** The share origin, once Tailscale has said who this machine is. */
  origin: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly port: number,
    private readonly tls: boolean,
  ) {}

  /** Looks it up now and every few minutes after, without ever holding the office up. */
  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh(): Promise<string | undefined> {
    for (const cmd of ['tailscale', ...(CLI_FALLBACKS[process.platform] ?? []).filter((p) => existsSync(p))]) {
      try {
        const name = tailnetName(await run(cmd));
        // Tailscale answered: a machine that's no longer connected stops sharing. (A lookup that
        // fails outright, below, keeps the last answer through the blip.)
        this.origin = name ? shareOrigin(name, this.port, this.tls) : undefined;
        return this.origin;
      } catch {
        // Not installed here, not running, or too slow: try the next place, then go without.
      }
    }
    return this.origin;
  }
}
