import os from 'node:os';
import { loadConfig, ensureSelfSigned } from './config.js';
import { startServer } from './server.js';
import { commandLine, edition } from '../shared/edition.js';

const argv = process.argv.slice(2);
if (argv[0] === 'prune') {
  const { prune } = await import('./prune.js');
  process.exit(await prune(argv.slice(1)));
}
if (argv[0] === 'accounts') {
  const { accountsCommand } = await import('./accounts.js');
  process.exit(accountsCommand(argv.slice(1)));
}

const cfg = loadConfig(argv);
await ensureSelfSigned(cfg);

let office: Awaited<ReturnType<typeof startServer>>;
try {
  office = await startServer(cfg);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') console.error(`${edition.command}: port ${cfg.port} is already in use (try --port)`);
  else console.error(`${edition.command}: ${e.message}`);
  process.exit(1);
}

const scheme = cfg.tls ? 'https' : 'http';
const urls = new Set<string>([`${scheme}://localhost:${cfg.port}`]);
if (cfg.host === '0.0.0.0' || cfg.host === '::') {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) urls.add(`${scheme}://${ni.address}:${cfg.port}`);
  }
} else urls.add(`${scheme}://${cfg.host}:${cfg.port}`);

const agent = office.resolvedAgent;
function floorsLine() {
  const floors = office.floors();
  const where = `new ones are cloned into ${office.projectsDir()}`;
  if (!floors.length) return edition.has3d ? `🛗 no floors yet — ride the elevator in the office to add a project (${where})` : `🛗 no spaces yet — add one from the app (${where})`;
  return `🛗 ${floors.length} floor${floors.length === 1 ? '' : 's'}: ${floors.map((f) => f.def.name).join(', ')} (${where})`;
}

function passwordLine() {
  if (!office.accounts.sharedPassword) return `off — everyone signs in with their own account (${commandLine('accounts')})`;
  if (!cfg.passwordGenerated) return '(from --password / AGENT_OFFICE_PASSWORD)';
  if (cfg.claimToken && !cfg.claimed) return 'shown exactly once to whoever opens the claim link (/claim?t=…)';
  // The installers' runner (installer/hearth.mjs) sets HEARTH_EDITION, and their password scripts
  // store only the hash, the same way a claimed password is kept.
  if (process.env.HEARTH_EDITION && !cfg.password) return 'set by the installer (password.bat / password.sh)';
  if (cfg.claimed || !cfg.password) return '(already claimed — never shown again; reset with --reset-password)';
  return cfg.password;
}
console.log(`
  🏢  ${edition.name} is open${cfg.project ? ` for ${cfg.project}` : ''}

  ${floorsLine()}

  ${[...urls].join('\n  ')}

  password: ${passwordLine()}
  default agent: ${[agent ?? `${cfg.agentCmd} (via login shell)`, ...cfg.agentArgs].join(' ')}
  choose Claude Code or OpenCode when hiring or queueing a task
${cfg.tls ? '' : '\n  tip: voice & screen share need https off localhost — use a reverse proxy or --self-signed\n'}`);

let closing = false;
// SIGTERM is a restart (tsx watch reloading, a plain `kill`): workers keep running in their terminal
// host and the next office picks them back up. Ctrl+C closes the office and stops them. (A systemd
// restart stops the whole service, host included.)
const stop = (signal: NodeJS.Signals) => {
  if (closing) process.exit(1);
  closing = true;
  const keep = signal === 'SIGTERM';
  console.log(keep ? '\n  closing the office — workers keep running for the next one…' : '\n  closing the office…');
  office.shutdown(keep);
  setTimeout(() => process.exit(0), 300);
};
// Last line of defense: one bad request must never take down every running worker.
process.on('unhandledRejection', (err) => console.error(`${edition.command}: unhandled rejection`, err));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
