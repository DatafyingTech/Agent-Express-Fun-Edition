# Security policy

This project is maintained by [Datafying Tech](https://datafying.tech). It runs AI agents with real
terminals on your own computer and lets you reach them from your phone, so we take security reports
seriously and will answer every one, even the ones that turn out to be nothing.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:

1. Open this repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Tell us what you found, how to reproduce it, and what an attacker could do with it.

Please include:

- The version or commit you are on, and your OS
- Whether the problem needs someone on your tailnet, someone signed in, or neither
- Steps to reproduce, and a proof of concept if you have one
- The output of `doctor.bat` / `./doctor.sh` if it is relevant. It prints your workspace folder and
  your computer's Tailscale name, so check it before you send it.

**What to expect.** We aim to acknowledge a report within 3 business days and to have a fix or a
clear plan within 30 days. We will credit you in the release notes unless you would rather we did
not. This is a free project with no bug bounty, but we will not be difficult about disclosure: tell
us first, give us a reasonable window, and publish whatever you like afterwards.

## How it is put together, security-wise

Knowing this makes it easier to tell a real problem from the design working as intended.

- **The server listens on this computer only.** The installers start it bound to `127.0.0.1`.
  Nothing on your Wi-Fi or the internet can reach it directly. Your phone reaches it through
  [Tailscale Serve](https://tailscale.com/kb/1312/serve), which forwards a port on your private
  tailnet to that loopback address. Only devices on your tailnet (and devices you share this
  computer with) can connect, and the traffic is encrypted end to end by WireGuard.
- **Everything behind the port needs a sign-in.** The password the installer sets is stored only as
  a salted scrypt hash. Sessions are signed cookies, and login attempts are rate limited. People
  you invite get their own accounts from single-use invite links that expire, and an admin can
  revoke an account, which signs that person out at once.
- **Agents are Claude Code, running as you.** Each teammate is the `claude` CLI in a terminal in
  your workspace, with your Claude Code permission settings. The app does not turn off Claude
  Code's permission prompts; it passes them to you in the chat and the live terminal. Anything an
  agent is allowed to do, it can do with your user account's rights.
- **Anyone signed in can type into the agents' terminals.** That is the point of the app, and it
  means a signed-in person can do whatever those terminals can. Only invite people you would hand
  your keyboard to.
- **No telemetry.** The app sends nothing about you anywhere. The outbound connections are listed
  in the README's Privacy section.

## Scope

**In scope:**

- Reaching the app, its WebSocket or any agent's terminal **without signing in**, or with a revoked
  account, an expired or used invite, or a stolen-but-expired session
- Anything that makes the server listen beyond `127.0.0.1` when it was installed not to
- Cross-site attacks against a signed-in browser (CSRF, cross-site WebSocket hijacking, XSS in chat,
  meeting transcripts, notes, reports or file names) that lead to running something in a terminal
- Path traversal through attachments, reports, notes or file viewers that reads or writes outside
  the workspace
- A member account doing admin-only things (inviting, revoking, changing roles or settings)
- Anything that sends your chats, files, memory or usage off the computer, other than Claude Code's
  own traffic to Anthropic
- Anything in `install.ps1`, `install.sh`, `hearth.mjs` or the helper scripts that could be hijacked
  to run untrusted code, or that changes more than it says it does (for example in
  `~/.claude.json`, beyond marking the workspace trusted after a backup)

**Out of scope:**

- What an agent does with the permissions you gave it. Claude Code's permission system is
  Anthropic's; report problems in it to them.
- A signed-in person, or someone with your password, using the terminals. That is the product
  working.
- An attacker who already runs code on your computer as your user, or controls your Tailscale
  account.
- Prompt injection that makes an agent misbehave within the permissions you granted. Worth telling
  us about if the app makes it worse, but it is a property of today's language models, not a bug in
  this code.
- Vulnerabilities in Node.js, Claude Code, Tailscale, Git or the GitHub CLI. Report those upstream.
- Reports produced only by an automated scanner, with no working path through this project's code.
