# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-08

The first public release of **Hearth** and **Hearth HQ**, built on
[agent-office](https://github.com/AgentSystemLabs/agent-office) by AgentSystemLabs (MIT). What's
listed below is what this release adds on top of it.

### Added

- **Hearth, a phone-first app for your team.** A calm messaging app over the office at `/app`:
  Home with a greeting and a **Needs you** list, **Chats**, **Settings**, and one space per project
  folder with **Team**, **Meetings**, **Tasks**, **Notes**, **Reports** and **GitHub**. Designed at
  390 px first, with a tablet rail and a desktop sidebar, light and dark themes, and a Home Screen
  icon (it opens full screen when you add it to an iPhone or Android Home Screen). Hearth opens it
  at `/`; Hearth HQ opens the 3D office there and sends phones to the app.
- **A roster of 35 teammates in nine departments** (Leadership, Operations, Engineering, Marketing,
  Sales, Finance, Research, Home & Life, Personal Finance), each with a job, a brief and a default
  model and effort: Opus where judgment matters, Sonnet for everyday work, Haiku for lists and
  reminders. Personal spaces use plain words, without commands or file paths.
- **Twelve crews**, from Weekly Planning and Product Team to Home Team and Monthly Money Meeting:
  several teammates hired together, each told who the others are and which part is theirs.
- **Your own roster.** Copy `src/shared/roster.default.ts` to `roster.local.ts` and the build uses
  yours. It stays out of git and survives updates.
- **Conversation meetings.** Talk with everyone at the table, or tap just the people you mean. No
  rounds: it runs until you end it. After every turn Claude Haiku rewrites **What the table knows**,
  a short shared memory every seat reads before answering. Ending one saves the conversation with a
  Haiku recap. Available in the app and in the 3D meeting room.
- **Structured meetings from the app**: Debate, Lead & team, Divide & combine (map-reduce),
  Red / blue and Review panel, with screenshots and PDFs as input, a token budget, a recap, and
  **Follow-ups** for the lead once it's done.
- **Chat with attachments.** Photos and PDFs up to 15 MB from the paperclip, paste or drag and drop;
  large photos are scaled down before your teammate reads them.
- **Quick answers.** When a teammate stops on one of Claude Code's own questions, the chat shows the
  question and its choices as buttons.
- **The live terminal on a phone**, with a key bar (Esc, Tab, arrows, Enter, ^C, 1, 2, 3, y, n) and
  text size buttons.
- **A shared memory per space.** `memory/CURRENT.md`, dated notes in `memory/log/` and facts in
  `memory/data/`. Every teammate is shown the summary with every message and keeps it up to date.
  **Notes** shows it in plain words; **Tell the team something** adds to it.
- **Reports** that open in the app: HTML pages, charts, PDFs, images, CSV and Markdown your
  teammates save, and every meeting record.
- **Accounts and invites in the app**: **Invite someone** makes a single-use link valid for 7 days,
  as a Member or an Admin; remove people; switch off the shared password.
- **Usage & limits** in Settings: what the team has spent, your Claude plan's 5-hour and weekly
  windows, and caps for teammates and tasks at once.
- **One-line installers** for Windows (`irm … | iex` or `install.bat`), macOS and Linux
  (`curl … | bash`). They check for Node.js, Git, the Claude Code CLI and its sign-in, and
  Tailscale, offer to install what's missing, build the app, create a workspace with a starter
  `CLAUDE.md` and `memory/`, mark it trusted for Claude Code (after a backup), set a sign-in
  password stored only as a hash, optionally start at sign-in, and share the app on your tailnet
  with `tailscale serve`. Re-running is always safe, and `-DryRun` / `--dry-run` shows what they
  would do.
- **Helper scripts**: `start`, `stop`, `doctor` (checks everything and prints a fix for each
  problem; `-Force` applies them), `update`, `password` and `uninstall`.
- **The share address.** Invite links and "open this on your phone" use this computer's Tailscale
  name, so a link made on the computer opens on a phone.

### Changed

- The server is started bound to `127.0.0.1` by the installers. Phones and invited people reach it
  through Tailscale Serve only.
- The shipped roster and every default are generic. Nothing in the repository refers to a real
  person, company or machine.
