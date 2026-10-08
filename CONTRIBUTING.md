# Contributing

Thanks for taking a look. Hearth and Hearth HQ share one codebase: a Node server that runs Claude
Code agents in real terminals, a phone-first web app (Hearth), and a 3D office (Hearth HQ) on top of
the same server. PRs that keep it small, local and dependency-light are the easiest to merge.

## What you need

| You want to work on | You need |
|---|---|
| The server, the app, the 3D office, the tests | **Node.js 20+** and **Git**, on Windows, macOS or Linux |
| Anything that starts real agents | The **Claude Code CLI**, signed in |
| The phone part | **Tailscale** on the computer and a phone (or just a narrow browser window) |

Everything else comes from `npm install`. Prebuilt terminal (PTY) binaries ship for Windows, macOS
and Linux on x64 and arm64, so you do not need a compiler.

## Dev setup

```bash
git clone <your fork>
cd <the repo>
npm install            # also builds the client and the server
npm run dev            # Vite for the client + the server in watch mode, password "dev"
```

`npm run dev` serves on port 4600. If you also have Hearth installed and running on that port, stop
it first (`stop.bat` / `./stop.sh`), or run the two halves yourself on another port:

```bash
npx vite &                                                            # the client, with hot reload
npx tsx watch src/server/cli.ts ~/hearth-dev --port 4700 --password dev   # the server, in a scratch workspace
```

Use a **scratch workspace** rather than the workspace you really use: an empty folder that is a git
repository with one commit, because agents work in git worktrees of it
(`mkdir ~/hearth-dev && cd ~/hearth-dev && git init && git commit --allow-empty -m start`). Real agents cost real money: while you are iterating, hire teammates on
Haiku (the hire sheet has a model picker), or pass `--agent-args "--model haiku"` to the server.

A brand-new folder makes Claude Code ask "Do you trust this folder?", and its default answer is
"No, exit", so a teammate hired there quits at once. Either answer it once by running `claude` in
the folder, or mark it trusted the way the installer does:

```bash
node hearth.mjs trust-workspace --workspace ~/hearth-dev
```

Set `HEARTH_CLAUDE_JSON=/path/to/a/copy/.claude.json` first if you want to try that against a copy
instead of your real Claude Code settings.

## Tests and typechecks

```bash
npm run typecheck                          # server and client
node --import tsx --test tests/*.test.ts   # everything (npm test does the same)
node --import tsx --test tests/meetings.test.ts   # one file
```

The tests never start a real agent and never need the network. A PR should leave both green. If a
test is already failing on your OS before your change, say so in the PR rather than skipping it.

## The roster

The team you hire from lives in `src/shared/roster.default.ts`: the teammates, their departments
(which become spaces), the crews, and the briefs every agent starts with. To change your own team
without touching the shipped one, copy it to `src/shared/roster.local.ts` and edit the copy.
`scripts/roster.mjs` points the build at your local roster when it exists, and `.gitignore` keeps it
out of your commits. Set `AGENT_OFFICE_ROSTER=default` to build with the shipped roster anyway.

**Changes to `roster.default.ts` itself** should stay generic: no real people, companies, accounts
or places. It is the team every new user starts with.

## Code layout

| Where | What |
|---|---|
| `src/server/` | The server: agents and their terminals (`workers.ts`, `ptys.ts`, `ptyhost.ts`), meetings (`meetings.ts`), the shared memory (`memory.ts`), chat, tasks and the queue, GitHub, changes and PRs, accounts and sign-in (`auth.ts`, `accounts.ts`), usage and limits |
| `src/shared/` | Types and logic both sides use: the WebSocket protocol (`protocol.ts`), the roster and teams, meeting patterns, floors |
| `src/client/app/` | **Hearth**, the phone-first app: plain TypeScript and DOM, plain CSS with design tokens (`tokens.css`). Its design system is written up in `docs/app/DESIGN.md` |
| `src/client/` (the rest) | **Hearth HQ**, the 3D office: `world/` is the Three.js scene, `ui/` the windows over it |
| `tests/` | Node's built-in test runner, run through `tsx` |
| `install.ps1`, `install.sh`, `hearth.mjs` and the `.bat` / `.sh` helpers | The installers and the runner they share |

No React, no Tailwind and no component library in the app. Comments say *why*, in plain sentences.

## What a good PR looks like

- One focused change, with a title that says what it does.
- New behavior comes with a test in `tests/` where it can have one.
- Typecheck and tests pass, and the PR says how you tried it (which screen, phone or desktop, which
  agent and model).
- UI changes include a screenshot or a short clip, made with **made-up data**. Never a screenshot of
  your real workspace, chats, names, paths or tailnet address.
- No new network calls. The app talks to nothing but your own computer; only Claude Code talks to
  Anthropic, and `gh` to GitHub when you use the GitHub features. A PR that adds telemetry,
  analytics or a call-home will not be merged.
- No new runtime dependency without a reason in the PR. Pin it.
- The installers stay idempotent: running them twice must be safe. Test `-DryRun` / `--dry-run` if
  you touch them.

## Reporting bugs and ideas

Use the issue templates. The bug template asks for the output of `doctor.bat` (Windows) or
`./doctor.sh` (macOS, Linux), which answers most questions before anyone has to ask. Check it for
anything private before you paste it: it prints your workspace folder and your computer's Tailscale
name.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), and
you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
