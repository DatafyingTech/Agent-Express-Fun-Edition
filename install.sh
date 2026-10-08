#!/usr/bin/env bash
# The Agent Express installer and helper for macOS and Linux, for both editions: Agent Express and
# Agent Express (Fun Edition).
#
# One line (it downloads the app, then installs it):
#
#   curl -fsSL https://raw.githubusercontent.com/DatafyingTech/Agent-Express-Fun-Edition/main/install.sh | bash
#
# With options:   curl -fsSL .../install.sh | bash -s -- --port 4700 --no-autostart
# From a copy:    ./install.sh [action] [options]
#
# What `install` does (every step is skipped when it's already done, so running it again is safe):
#   1. checks for Node.js 20+, Git, the Claude Code CLI and Tailscale, and offers to install what's
#      missing (Homebrew on macOS; apt, dnf, pacman or zypper on Linux; nvm for Node.js otherwise)
#   2. checks that Claude Code is signed in, and offers to sign in
#   3. installs the app's packages (npm ci) and builds it (npm run build)
#   4. creates your workspace (default ~/AgentExpress, or ~/AgentExpressFun for the Fun Edition)
#      with a starter CLAUDE.md and memory/, as the first floor, and tells Claude Code to trust that
#      folder
#   5. sets the password your phone signs in with (yours, or a generated one it shows you)
#   6. optionally starts the app when you log in (launchd on macOS, systemd --user on Linux)
#   7. starts the app, brings Tailscale up and shares the app on your tailnet with `tailscale serve`
#   8. prints the address to open on your phone
#
# Actions: install (default), start, stop, restart, status, doctor, update, password, uninstall
#
# Options:
#   --edition express|fun which app this is (normally detected; fun = Agent Express (Fun Edition),
#                         the 3D office)
#   --port <n>            port on this computer (default 4600 for Agent Express, 4610 for the Fun
#                         Edition)
#   --workspace <dir>     your workspace folder (default ~/AgentExpress or ~/AgentExpressFun)
#   --install-dir <dir>   where the one-line install puts the app (default
#                         ~/.local/share/agent-express or ~/.local/share/agent-express-fun)
#   --no-tailscale        don't install, start or configure Tailscale (this computer only)
#   --no-autostart        don't start at login (and don't ask); --autostart: do, without asking
#   --no-start            set everything up but don't start it
#   --reset-password      ask for (or generate) a new password even if one is set
#   --open                (start) open it in the browser
#   -y, --yes             unattended: take the default for every question, install what's missing
#   --dry-run             report what it would do, change nothing
#   --force               reinstall packages and rebuild even when they look up to date
#
# Environment: AGENT_EXPRESS_EDITION, AGENT_EXPRESS_PORT, AGENT_EXPRESS_WORKSPACE,
# AGENT_EXPRESS_INSTALL_DIR, AGENT_EXPRESS_YES=1, AGENT_EXPRESS_DRY_RUN=1,
# AGENT_EXPRESS_NO_TAILSCALE=1, AGENT_EXPRESS_NO_AUTOSTART=1, and AGENT_EXPRESS_PASSWORD (the
# sign-in password, instead of being asked).
#
# The apps were first called Hearth and Hearth HQ. Their edition ids (hearth, hq), the HEARTH_*
# variables and an install's old .hearth/ folder all still work.
#
# Everything is in functions and the last line runs main and exits on the same line: bash reads a
# script bit by bit as it runs it, and `update` rewrites this file while it runs.

set -euo pipefail

# The export fills these in for each repo. Left as they are (a development checkout), the edition is
# worked out from package.json and the git remote.
BAKED_EDITION='fun'
BAKED_REPO='DatafyingTech/Agent-Express-Fun-Edition'

# AGENT_EXPRESS_<name> from the environment, or HEARTH_<name>, its name before the rename.
env_var() { local a="AGENT_EXPRESS_$1" b="HEARTH_$1"; printf '%s' "${!a:-${!b:-}}"; }

ORIG_ARGS=("$@")
ACTION=install
EDITION="$(env_var EDITION)"
PORT="$(env_var PORT)"
WORKSPACE="$(env_var WORKSPACE)"
INSTALL_DIR="$(env_var INSTALL_DIR)"
NO_TS=0
AUTOSTART_FLAG=""
NO_START=0
RESET_PW=0
OPEN=0
YES=0
DRY=0
FORCE=0
REPO_ARG=""

truthy() { [ -n "${1:-}" ] && [ "$1" != 0 ] && [ "$1" != false ]; }
truthy "$(env_var YES)" && YES=1
truthy "$(env_var DRY_RUN)" && DRY=1
truthy "$(env_var NO_TAILSCALE)" && NO_TS=1
truthy "$(env_var NO_AUTOSTART)" && AUTOSTART_FLAG=0

# Each install keeps its settings, logs and state in this folder of the app (an install from before
# the rename has it as .hearth, which move_old_state renames).
STATE_NAME=.agent-express
OLD_STATE_NAME=.hearth

# ------------------------------------------------------------------ output and questions
if [ -t 1 ]; then C_CYAN=$'\033[1;36m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m' C_MAG=$'\033[35m' C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_OFF=$'\033[0m'
else C_CYAN="" C_GREEN="" C_YELLOW="" C_RED="" C_MAG="" C_DIM="" C_BOLD="" C_OFF=""; fi
step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$*" "$C_OFF"; }
ok() { printf '    %s[ok]%s   %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '    %s[warn]%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
bad() { printf '    %s[fail]%s %s\n' "$C_RED" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
fix() { printf '           %sfix:%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
die() {
  printf '\n  %sSTOPPED%s\n  %s%s%s\n' "$C_RED" "$C_OFF" "$C_RED" "$1" "$C_OFF" >&2
  [ -n "${2:-}" ] && printf '  %s-> %s%s\n' "$C_YELLOW" "$2" "$C_OFF" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Piped from curl, stdin is the script itself, so questions are read from the terminal. With no
# terminal (CI, a remote-management tool) nothing is asked, and the defaults stand, except that
# software is never installed without a yes or --yes.
can_prompt() { [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; }
ask() { # question default(1/0) big(1/0)
  local q="$1" def="${2:-1}" big="${3:-0}" a hint
  if [ "$YES" = 1 ]; then [ "$def" = 1 ] || [ "$big" = 1 ]; return; fi
  if ! can_prompt; then [ "$def" = 1 ] && [ "$big" = 0 ]; return; fi
  if [ "$def" = 1 ]; then hint="Y/n"; else hint="y/N"; fi
  printf '    %s [%s] ' "$q" "$hint" >/dev/tty
  read -r a </dev/tty || a=""
  case "$a" in "") [ "$def" = 1 ] ;; [yY]*) true ;; *) false ;; esac
}

# Every change goes through here, so --dry-run can report it instead.
change() { # description command...
  local what="$1"
  shift
  if [ "$DRY" = 1 ]; then printf '    %s[dry-run] would %s%s\n' "$C_MAG" "$what" "$C_OFF"; return 0; fi
  "$@"
}

# ------------------------------------------------------------------ arguments
usage() { sed -n '2,/^# Everything is in functions/p' "${BASH_SOURCE[0]:-install.sh}" 2>/dev/null | sed '$d' | sed 's/^# \{0,1\}//'; }
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      install | start | stop | restart | status | doctor | update | password | uninstall) ACTION="$1" ;;
      --edition) EDITION="${2:?--edition needs express or fun}"; shift ;;
      --port) PORT="${2:?--port needs a number}"; shift ;;
      --workspace) WORKSPACE="${2:?--workspace needs a folder}"; shift ;;
      --install-dir) INSTALL_DIR="${2:?--install-dir needs a folder}"; shift ;;
      --repo) REPO_ARG="${2:?}"; shift ;;
      --no-tailscale) NO_TS=1 ;;
      --no-autostart) AUTOSTART_FLAG=0 ;;
      --autostart) AUTOSTART_FLAG=1 ;;
      --no-start) NO_START=1 ;;
      --reset-password) RESET_PW=1 ;;
      --open) OPEN=1 ;;
      -y | --yes) YES=1 ;;
      --dry-run) DRY=1 ;;
      --force) FORCE=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1" "./install.sh --help lists them" ;;
    esac
    shift
  done
}

# ------------------------------------------------------------------ the platform
OS=""
PKG=""
IS_WSL=0
detect_os() {
  case "$(uname -s)" in
    Darwin) OS=mac ;;
    Linux) OS=linux ;;
    *) die "This installer is for macOS and Linux. On Windows, double-click install.bat instead." ;;
  esac
  if [ "$OS" = linux ] && grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi
  if [ "$OS" = mac ]; then
    have brew || { [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"; } || { [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"; } || true
    have brew && PKG=brew
  else
    for p in apt-get dnf pacman zypper; do have "$p" && { PKG="$p"; break; }; done
  fi
  # Where the native installers put things, for this run (a new terminal picks them up by itself).
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
  if [ -s "$HOME/.nvm/nvm.sh" ] && ! have node; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
  export PATH
}

sudo_cmd() { if [ "$(id -u)" = 0 ]; then "$@"; elif have sudo; then sudo "$@"; else die "this step needs root and sudo isn't installed: $*"; fi; }

# Installs a system package with the platform's package manager. Returns non-zero when it can't.
pkg_install() { # label brew-name apt-name dnf-name pacman-name zypper-name
  local label="$1" name=""
  case "$PKG" in
    brew) name="$2" ;; apt-get) name="$3" ;; dnf) name="$4" ;; pacman) name="$5" ;; zypper) name="$6" ;;
  esac
  if [ -z "$PKG" ] || [ -z "$name" ]; then warn "No package manager here can install $label for you."; return 1; fi
  change "install $label: $PKG install $name" _pkg_install "$name"
}
# $1 is unquoted on purpose: it can name several packages ("nodejs npm").
# shellcheck disable=SC2086
_pkg_install() {
  info "Installing $1 with $PKG (it may ask for your password)..."
  case "$PKG" in
    brew) brew install $1 ;;
    apt-get) sudo_cmd apt-get update -qq && sudo_cmd apt-get install -y $1 ;;
    dnf) sudo_cmd dnf install -y $1 ;;
    pacman) sudo_cmd pacman -S --needed --noconfirm $1 ;;
    zypper) sudo_cmd zypper --non-interactive install $1 ;;
  esac
}

# ------------------------------------------------------------------ editions and settings
E_NAME="" E_PORT="" E_WS="" E_REPO="" E_APPDIR="" E_LABEL="" E_UNIT="" E_OLD_LABEL="" E_OLD_UNIT=""
# The edition ids from before the rename, still accepted.
resolve_edition() { case "$1" in hearth) echo express ;; hq) echo fun ;; *) echo "$1" ;; esac; }
set_edition() {
  case "$1" in
    express) E_NAME="Agent Express" E_PORT=4600 E_WS="AgentExpress" E_REPO="DatafyingTech/Agent-Express" E_APPDIR="agent-express" E_LABEL="tech.datafying.agent-express" E_UNIT="agent-express.service" E_OLD_LABEL="tech.datafying.hearth" E_OLD_UNIT="hearth.service" ;;
    fun) E_NAME="Agent Express (Fun Edition)" E_PORT=4610 E_WS="AgentExpressFun" E_REPO="DatafyingTech/Agent-Express-Fun-Edition" E_APPDIR="agent-express-fun" E_LABEL="tech.datafying.agent-express-fun" E_UNIT="agent-express-fun.service" E_OLD_LABEL="tech.datafying.hearth-hq" E_OLD_UNIT="hearth-hq.service" ;;
    *) die "--edition is express or fun, not $1" ;;
  esac
  # The repository this copy was exported for (a fork keeps its own), unless it's told to install
  # the other edition.
  case "$BAKED_REPO" in "{{"*) ;; *) if [ "$1" = "$(resolve_edition "$BAKED_EDITION")" ]; then E_REPO="$BAKED_REPO"; fi ;; esac
}

is_checkout() { [ -n "${1:-}" ] && [ -f "$1/package.json" ] && [ -f "$1/src/server/cli.ts" ]; }

detect_edition() {
  case "$BAKED_EDITION" in "{{"*) ;; *) resolve_edition "$BAKED_EDITION"; return ;; esac
  local name remote
  name="$(sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1)"
  case "$name" in *agent-express-fun*) echo fun; return ;; *agent-express*) echo express; return ;; esac
  remote="$(git -C "$1" remote get-url origin 2>/dev/null || true)"
  case "$(printf '%s' "$remote" | tr '[:upper:]' '[:lower:]')" in *agent-express-fun*) echo fun; return ;; esac
  echo express
}

S_EDITION="" S_PORT="" S_WORKSPACE="" S_AGENT="" S_AGENT_ARGS="" S_MAX_WORKERS="" S_TAILSCALE="" S_AUTOSTART="" S_SHORTCUTS="" S_NODE=""
HAS_SETTINGS=0
# Renames an install's .hearth folder (from before the rename) to .agent-express.
move_old_state() {
  [ -e "$ROOT/$STATE_NAME" ] || [ ! -d "$ROOT/$OLD_STATE_NAME" ] && return 0
  change "rename the settings folder $ROOT/$OLD_STATE_NAME to $STATE_NAME (the app's new name)" mv "$ROOT/$OLD_STATE_NAME" "$ROOT/$STATE_NAME"
  [ "$DRY" = 1 ] || ok "settings moved to $ROOT/$STATE_NAME"
}
# A dry run leaves an old .hearth folder where it is, and reads it there.
state_dir() {
  if [ ! -e "$ROOT/$STATE_NAME" ] && [ -d "$ROOT/$OLD_STATE_NAME" ]; then echo "$ROOT/$OLD_STATE_NAME"; else echo "$ROOT/$STATE_NAME"; fi
}
read_settings() {
  local f line key val
  f="$(state_dir)/settings.env"
  [ -f "$f" ] || return 0
  HAS_SETTINGS=1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in \#* | "") continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      EDITION | PORT | WORKSPACE | AGENT | AGENT_ARGS | MAX_WORKERS | TAILSCALE | AUTOSTART | SHORTCUTS | NODE) printf -v "S_$key" '%s' "$val" ;;
    esac
  done <"$f"
}
write_settings() {
  change "save settings to $ROOT/$STATE_NAME/settings.env" _write_settings
}
_write_settings() {
  mkdir -p "$ROOT/$STATE_NAME"
  # The folder ignores itself, so it never shows up in git status or gets committed.
  printf '*\n' >"$ROOT/$STATE_NAME/.gitignore"
  {
    echo "# $E_NAME settings, written by the installer. Edit, then run ./stop.sh and ./start.sh."
    echo "EDITION=$S_EDITION"
    echo "PORT=$S_PORT"
    echo "WORKSPACE=$S_WORKSPACE"
    echo "AGENT=$S_AGENT"
    echo "AGENT_ARGS=$S_AGENT_ARGS"
    echo "MAX_WORKERS=$S_MAX_WORKERS"
    echo "TAILSCALE=$S_TAILSCALE"
    echo "AUTOSTART=$S_AUTOSTART"
    echo "SHORTCUTS=$S_SHORTCUTS"
    echo "NODE=$S_NODE"
  } >"$ROOT/$STATE_NAME/settings.env"
}

# ------------------------------------------------------------------ bootstrap (no checkout yet)
# Piped from curl, or saved on its own: fetch the app (git clone, or the tarball without git),
# then run that copy's installer with the same options.
bootstrap() {
  local ed="${EDITION}" dir
  if [ -z "$ed" ]; then case "$BAKED_EDITION" in "{{"*) ed=express ;; *) ed="$BAKED_EDITION" ;; esac; fi
  ed="$(resolve_edition "$ed")"
  set_edition "$ed"
  dir="${INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$E_APPDIR}"
  printf '\n  %s%s installer%s\n' "$C_BOLD" "$E_NAME" "$C_OFF"
  step "Getting $E_NAME (github.com/$E_REPO) into $dir"
  if ! have git && ask "Git is not installed. Install it now?" 1 1; then
    if [ "$OS" = mac ] && [ -z "$PKG" ]; then change "install Apple's command line tools (git)" xcode-select --install || true
    else pkg_install Git git git git git git || true; fi
  fi
  if is_checkout "$dir"; then
    ok "already downloaded"
    if have git && [ -d "$dir/.git" ]; then change "update it with: git -C $dir pull --ff-only" git -C "$dir" pull --ff-only || warn "git pull did not succeed; carrying on with the copy that is there."; fi
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    die "$dir already exists and isn't a copy of $E_NAME." "Move it out of the way, or pass --install-dir (or AGENT_EXPRESS_INSTALL_DIR) to install somewhere else."
  elif have git; then
    change "clone https://github.com/$E_REPO.git into $dir" _clone "$dir"
  else
    change "download https://github.com/$E_REPO/archive/refs/heads/main.tar.gz into $dir" _download "$dir"
  fi
  if [ "$DRY" = 1 ] && ! is_checkout "$dir"; then
    info "Dry run: nothing was downloaded, so the rest of the install can't be shown. Run it again inside a copy (./install.sh --dry-run)."
    return 0
  fi
  is_checkout "$dir" || die "The download finished but $dir doesn't look like $E_NAME."
  local args=()
  [ -n "$EDITION" ] || args+=(--edition "$ed")
  # The checkout's own installer, which may be newer than this one, with the same options.
  if can_prompt; then exec bash "$dir/install.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} ${args[@]+"${args[@]}"} </dev/tty; fi
  exec bash "$dir/install.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} ${args[@]+"${args[@]}"}
}
_clone() {
  mkdir -p "$(dirname "$1")"
  git clone --depth 1 "https://github.com/$E_REPO.git" "$1" || die "git clone failed (see above)." "Check your internet connection and try again."
}
_download() {
  mkdir -p "$1"
  curl -fsSL "https://github.com/$E_REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$1" --strip-components 1 ||
    die "Could not download $E_NAME." "Download https://github.com/$E_REPO yourself and run ./install.sh inside it."
}

# ------------------------------------------------------------------ requirements
node_major() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  if [ "$(node_major)" -ge 20 ]; then ok "Node.js $(node -v) ($(command -v node))"; return; fi
  if have node; then warn "Node.js $(node -v) is too old; $E_NAME needs 20 or newer."; else warn "Node.js is not installed."; fi
  local how="nvm (in your home folder, no admin needed)"
  [ "$PKG" = brew ] && how="Homebrew"
  [ "$PKG" = pacman ] && how="pacman"
  if ask "Install Node.js LTS now with $how?" 1 1; then
    case "$PKG" in
      brew) pkg_install Node.js node "" "" "" "" || true ;;
      pacman) pkg_install Node.js "" "" "" "nodejs npm" "" || true ;;
      *) change "install nvm, then: nvm install --lts" _install_nvm_node ;;
    esac
  fi
  [ "$DRY" = 1 ] && return
  [ "$(node_major)" -ge 20 ] || die "Node.js 20 or newer is needed." "Install the LTS version from https://nodejs.org (or with nvm: https://github.com/nvm-sh/nvm), open a new terminal, and run ./install.sh again."
  ok "Node.js $(node -v)"
}
_install_nvm_node() {
  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash || die "Could not install nvm."
  fi
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm install --lts && nvm alias default 'lts/*' >/dev/null
}

ensure_git() {
  if have git && git --version >/dev/null 2>&1; then ok "$(git --version)"; return; fi
  warn "Git is not installed. Agents use it for every project."
  if ask "Install Git now?" 1 1; then
    if [ "$OS" = mac ] && [ -z "$PKG" ]; then
      change "install Apple's command line tools (they include git)" xcode-select --install || true
      info "Finish the Command Line Tools window that opened, then run ./install.sh again."
    else pkg_install Git git git git git git || true; fi
  fi
  [ "$DRY" = 1 ] && return
  have git || die "Git is needed." "Install it (https://git-scm.com/downloads), then run ./install.sh again."
  ok "$(git --version)"
}

claude_bin() {
  if [ -x "$HOME/.local/bin/claude" ]; then echo "$HOME/.local/bin/claude"; elif have claude; then command -v claude; fi
}

ensure_claude() {
  local c
  c="$(claude_bin)"
  if [ -z "$c" ]; then
    warn "The Claude Code CLI is not installed. It is what every agent runs."
    if ask "Install Claude Code now with its official installer (curl -fsSL https://claude.ai/install.sh | bash)?" 1 1; then
      change "install Claude Code: curl -fsSL https://claude.ai/install.sh | bash" _install_claude
    fi
    [ "$DRY" = 1 ] && return
    c="$(claude_bin)"
    [ -n "$c" ] || die "Claude Code is needed." "Run: curl -fsSL https://claude.ai/install.sh | bash   then ./install.sh again. (https://docs.claude.com/claude-code)"
  fi
  local v
  v="$("$c" --version 2>/dev/null)" || die "Claude Code is installed ($c) but 'claude --version' failed." "Reinstall it: curl -fsSL https://claude.ai/install.sh | bash"
  ok "Claude Code $v ($c)"
}
_install_claude() { curl -fsSL https://claude.ai/install.sh | bash || warn "The Claude Code installer reported a problem (see above)."; }

# Prints yes, no or unknown.
claude_login() {
  local c out
  c="$(claude_bin)"
  [ -n "$c" ] || { echo no; return; }
  out="$("$c" auth status --json 2>/dev/null || true)"
  case "$out" in
    *'"loggedIn": true'* | *'"loggedIn":true'*) echo yes; return ;;
    *'"loggedIn": false'* | *'"loggedIn":false'*) echo no; return ;;
  esac
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -f "$HOME/.claude/.credentials.json" ]; then echo yes; else echo unknown; fi
}

ensure_claude_login() {
  [ "$DRY" = 1 ] && [ -z "$(claude_bin)" ] && return
  if [ "$(claude_login)" = yes ]; then ok "Claude Code is signed in"; return; fi
  warn "Claude Code is not signed in yet, so agents cannot start."
  if [ "$YES" != 1 ] && can_prompt && ask "Sign in now? (opens your browser)" 1; then
    change "run: claude auth login" "$(claude_bin)" auth login </dev/tty || true
    if [ "$(claude_login)" = yes ]; then ok "Claude Code is signed in"; return; fi
  fi
  info "To sign in: open a new terminal, run  claude  once, and follow the login (a Claude Pro/Max plan or an API key)."
  info "$E_NAME installs fine without it; agents start working as soon as you have signed in."
}

ts_bin() {
  if have tailscale; then command -v tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then echo /Applications/Tailscale.app/Contents/MacOS/Tailscale; fi
}

ensure_tailscale() {
  if [ "$NO_TS" = 1 ]; then info "Skipping Tailscale (--no-tailscale): $E_NAME will only be reachable from this computer."; return; fi
  if [ -n "$(ts_bin)" ]; then ok "Tailscale $("$(ts_bin)" version 2>/dev/null | head -n 1)"; return; fi
  if [ "$IS_WSL" = 1 ]; then
    warn "Inside WSL, Tailscale belongs on Windows: install $E_NAME with install.bat there for phone access."
    warn "Carrying on without Tailscale (this computer only)."
    NO_TS=1
    return
  fi
  warn "Tailscale is not installed. It is the private network that lets your phone reach this computer from anywhere."
  if ask "Install Tailscale now?" 1 1; then
    if [ "$OS" = mac ]; then
      if [ "$PKG" = brew ]; then change "install Tailscale: brew install --cask tailscale" _install_ts_mac
      else info "Install Tailscale from the App Store or https://tailscale.com/download/mac, then run ./install.sh again."; fi
    else
      change "install Tailscale: curl -fsSL https://tailscale.com/install.sh | sh" _install_ts_linux
    fi
  fi
  [ "$DRY" = 1 ] && return
  if [ -z "$(ts_bin)" ]; then
    warn "Tailscale is still missing, so the phone step is skipped. Install it (https://tailscale.com/download) and run ./install.sh again."
    NO_TS=1
  fi
}
_install_ts_mac() { brew install --cask tailscale && open -a Tailscale || true; }
_install_ts_linux() {
  curl -fsSL https://tailscale.com/install.sh | sh || { warn "The Tailscale installer reported a problem (see above)."; return 0; }
  have systemctl && sudo_cmd systemctl enable --now tailscaled >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------ the app
health() { node "$ROOT/agent-express.mjs" health "${1:-$S_PORT}" >/dev/null 2>&1; }

# This copy's runner, or this copy's office (and its terminal host) for this workspace. Never
# anything else: another office on this computer is none of our business.
app_pids() {
  { ps -eo pid=,args= 2>/dev/null || true; } | while read -r pid args; do
    [ "$pid" = "$$" ] && continue
    case "$args" in *node*) ;; *) continue ;; esac
    case "$args" in
      *"$ROOT/agent-express.mjs"*) echo "$pid" ;;
      *"$ROOT/"*"$S_WORKSPACE"*) echo "$pid" ;;
    esac
  done
}

port_owner() { # what listens on 127.0.0.1:<port> (or every address), if anything
  if have lsof; then lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && ($9 ~ /^(127\.0\.0\.1|\*|\[::1\]|\[::\]|localhost):/) {print $1" (pid "$2")"; exit}'
  elif have ss; then ss -ltnpH "( sport = :$1 )" 2>/dev/null | awk '$4 ~ /^(127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]|\[::1\]):/ {print $6; exit}'
  fi
}

PLIST="$HOME/Library/LaunchAgents/LABEL.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_kind() { # launchd, systemd or none: how this install is started
  if [ "$S_AUTOSTART" != 1 ]; then echo none
  elif [ "$OS" = mac ]; then echo launchd
  elif systemd_user_ok; then echo systemd
  else echo none; fi
}
systemd_user_ok() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }
plist_path() { echo "${PLIST/LABEL/$E_LABEL}"; }

start_app() {
  if health; then ok "$E_NAME is already running on port $S_PORT"; return 0; fi
  local owner
  owner="$(port_owner "$S_PORT" || true)"
  if [ -n "$owner" ]; then bad "Port $S_PORT is in use by $owner."; fix "close it, or run ./install.sh --port <another port>"; return 1; fi
  case "$(service_kind)" in
    launchd) change "start $E_NAME (launchd: $E_LABEL)" _start_launchd ;;
    systemd) change "start $E_NAME (systemctl --user start $E_UNIT)" systemctl --user start "$E_UNIT" ;;
    *) change "start $E_NAME in the background on port $S_PORT" _start_bg ;;
  esac
  [ "$DRY" = 1 ] && return 0
  local i
  for i in $(seq 1 90); do
    if health; then ok "$E_NAME is running: http://localhost:$S_PORT"; return 0; fi
    sleep 1
  done
  bad "$E_NAME did not answer on port $S_PORT within 90 seconds."
  fix "look at the end of $ROOT/$STATE_NAME/logs/agent-express.log, or run ./doctor.sh"
  return 1
}
_start_launchd() {
  if launchctl print "gui/$(id -u)/$E_LABEL" >/dev/null 2>&1; then launchctl kickstart "gui/$(id -u)/$E_LABEL"
  else launchctl bootstrap "gui/$(id -u)" "$(plist_path)"; fi
}
_start_bg() {
  mkdir -p "$ROOT/$STATE_NAME/logs"
  # nohup and its own session: it keeps running after this terminal closes.
  if have setsid; then nohup setsid "$(command -v node)" "$ROOT/agent-express.mjs" >/dev/null 2>&1 </dev/null &
  else nohup "$(command -v node)" "$ROOT/agent-express.mjs" >/dev/null 2>&1 </dev/null & fi
}

stop_app() {
  local pids
  pids="$(app_pids | tr '\n' ' ')"
  if [ -z "${pids// /}" ] && ! health; then ok "$E_NAME is not running"; return 0; fi
  change "stop $E_NAME" _stop
}
_stop() {
  # The service manager first, so it doesn't count the stop as a crash and start it again.
  if [ "$OS" = mac ] && launchctl print "gui/$(id -u)/$E_LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/$E_LABEL" 2>/dev/null || true; fi
  if [ "$OS" = linux ] && systemd_user_ok; then systemctl --user stop "$E_UNIT" 2>/dev/null || true; fi
  local pids i
  pids="$(app_pids)"
  # SIGINT is the office's Ctrl+C: it closes and stops its agents too.
  [ -n "$pids" ] && kill -INT $pids 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(app_pids)" ] && break; sleep 0.5; done
  pids="$(app_pids)"
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
  ok "$E_NAME stopped"
}

file_hash() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; fi
}

REBUILT=0
WAS_RUNNING=0
build_app() {
  local state="$ROOT/$STATE_NAME" lockhash head have_deps=0 have_build=0
  lockhash="$( [ -f "$ROOT/package-lock.json" ] && file_hash "$ROOT/package-lock.json" || echo none)"
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head" ] || head="$lockhash$(file_hash "$ROOT/package.json")"
  [ -d "$ROOT/node_modules" ] && [ "$(cat "$state/deps.stamp" 2>/dev/null)" = "$lockhash" ] && have_deps=1
  [ -d "$ROOT/dist/server" ] && [ "$(cat "$state/build.stamp" 2>/dev/null)" = "$head" ] && have_build=1
  if [ "$have_deps" = 1 ] && [ "$have_build" = 1 ] && [ "$FORCE" != 1 ]; then ok "packages installed and app built (up to date)"; return; fi
  have npm || [ "$DRY" = 1 ] || die "npm was not found next to Node.js." "Reinstall Node.js LTS."
  if [ -n "$(app_pids)" ]; then WAS_RUNNING=1; stop_app >/dev/null; fi
  local marker="$state/.ci-started"
  if [ "$have_deps" != 1 ] || [ "$FORCE" = 1 ]; then
    change "install packages: npm ci" _npm_ci "$lockhash" "$marker"
  fi
  # npm ci already builds when package.json's "prepare" script does; don't build twice.
  if [ "$DRY" != 1 ] && [ -f "$marker" ] && [ -d "$ROOT/dist/server" ] && [ -n "$(find "$ROOT/dist/server" -maxdepth 0 -newer "$marker" 2>/dev/null)" ]; then
    printf '%s' "$head" >"$state/build.stamp"
    rm -f "$marker"
    ok "app built (by npm ci)"
    REBUILT=1
    return
  fi
  change "build the app: npm run build" _npm_build "$head"
  REBUILT=1
}
_npm_ci() {
  info "Installing packages (npm ci). This takes a minute or two the first time..."
  mkdir -p "$ROOT/$STATE_NAME"
  touch "$2"
  (cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed (see above)." "Check your internet connection and run ./install.sh again."
  printf '%s' "$1" >"$ROOT/$STATE_NAME/deps.stamp"
}
_npm_build() {
  info "Building the app..."
  (cd "$ROOT" && npm run build) || die "npm run build failed (see above)." "Run ./doctor.sh, and open an issue with the last 30 lines above if it keeps failing."
  printf '%s' "$1" >"$ROOT/$STATE_NAME/build.stamp"
  ok "app built"
}

write_if_missing() { # file, contents on stdin
  if [ -e "$1" ]; then cat >/dev/null; return; fi
  if [ "$DRY" = 1 ]; then cat >/dev/null; printf '    %s[dry-run] would create %s%s\n' "$C_MAG" "$1" "$C_OFF"; return; fi
  mkdir -p "$(dirname "$1")"
  cat >"$1"
}

setup_workspace() {
  local ws="$S_WORKSPACE" fresh=0 today
  today="$(date +%Y-%m-%d)"
  [ -e "$ws" ] || fresh=1
  [ "$fresh" = 1 ] && change "create your workspace $ws" mkdir -p "$ws"
  write_if_missing "$ws/CLAUDE.md" <<EOF
# My $E_NAME

This folder is home base for your $E_NAME team: the Claude Code agents you talk to from your phone
or your computer. Everything they make for you lands here, in plain files you own.

Every agent reads this file before it starts work, so tell them about you. Edit it any time.

## About me
- Name: (your name)
- What I do: (your job, your business, your side projects)
- Where I am: (city and time zone)

## How I like to work
- Keep answers short and in plain words.
- Ask before spending money, sending a message for me, or deleting anything.
- (add your own rules: tone, tools you use, things never to touch)

## Where things go
- memory/CURRENT.md: a short summary of where things stand. Every teammate reads it.
- memory/log/: dated notes of what was learned and done, one file per day.
- memory/data/: facts the team builds up (CSV or JSON files).
- TODO.md: the running to-do list.
EOF
  write_if_missing "$ws/memory/CURRENT.md" <<EOF
# Where things stand (shared team memory)

Keep this short (under 60 lines) and current. Every teammate on this floor sees it with every message.
Details go in memory/log/ (dated) and memory/data/. Last updated: $today (setup).

## Right now
- $E_NAME was just installed. Say hello to the team and tell them about yourself (or edit CLAUDE.md).

## This week's priorities
- (add them here, or ask the Chief of Staff to keep them)

## Decisions and facts to remember
- (dated one-liners)
EOF
  printf 'Dated notes go here, one file per day: YYYY-MM-DD.md.\n' | write_if_missing "$ws/memory/log/README.md"
  printf 'Structured facts the team collects go here, as CSV or JSON.\n' | write_if_missing "$ws/memory/data/README.md"
  printf '# To do\n\n- [ ] Tell the team about yourself (edit CLAUDE.md)\n- [ ] Add %s to your phone'"'"'s Home Screen\n' "$E_NAME" | write_if_missing "$ws/TODO.md"
  # Agents work in git worktrees of the workspace, so it must be a repository with a first commit.
  if have git && [ ! -d "$ws/.git" ]; then change "make $ws a git repository with a first commit" _git_init "$ws"; fi
  if [ "$DRY" != 1 ]; then if [ "$fresh" = 1 ]; then ok "workspace created: $ws"; else ok "workspace: $ws"; fi; fi
  trust_workspace
}
_git_init() {
  git -C "$1" init -q -b main 2>/dev/null || git -C "$1" init -q
  git -C "$1" add -A
  # Named here, so it works before you've ever set up git (only this first commit uses it).
  git -C "$1" -c "user.name=Agent Express" -c user.email=agent-express@localhost commit -q -m "Start my workspace" || warn "git commit in the workspace failed"
}

# Claude Code asks "Is this a project you trust?" the first time it opens a folder, and its default
# answer is "No, exit". The office's agents run in the workspace with nobody there to answer, so the
# first teammate you hire would quit at once. The workspace is a folder this installer made for you,
# holding only the starter files above, so it's marked trusted, the same as answering yes once.
trust_workspace() {
  have node || return 0
  local hm="$ROOT/agent-express.mjs" out rc=0
  out="$(node "$hm" trust-workspace --check --workspace "$S_WORKSPACE" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then ok "Claude Code trusts the workspace"; return 0; fi
  if [ "$rc" = 3 ]; then warn "$out"; return 0; fi
  info "Telling Claude Code to trust $S_WORKSPACE: agents run there with nobody to answer its"
  info "'Do you trust this folder?' question, whose default is 'No, exit'. It's the folder this installer made."
  if [ "$DRY" = 1 ]; then printf '    %s[dry-run] %s%s\n' "$C_MAG" "$(node "$hm" trust-workspace --dry-run --workspace "$S_WORKSPACE")" "$C_OFF"; return 0; fi
  rc=0
  out="$(node "$hm" trust-workspace --workspace "$S_WORKSPACE" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then ok "Claude Code trusts the workspace (~/.claude.json was backed up first)"; else warn "$out"; fi
}

new_password() {
  node -e '
    const c = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const b = require("crypto").randomBytes(15);
    const s = [...b].map((x) => c[x % c.length]).join("");
    console.log(`${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}`);'
}

PASSWORD_CHANGED=0
SHOW_PASSWORD=""
ensure_password() { # reset(1/0)
  local status="none" pw generated=0 a b
  pw="$(env_var PASSWORD)"
  [ -f "$(state_dir)/settings.env" ] && have node && status="$(node "$ROOT/agent-express.mjs" password-status 2>/dev/null || echo none)"
  if [ "$status" = set ] && [ "${1:-0}" != 1 ]; then ok "a sign-in password is set (./password.sh sets a new one)"; return; fi
  if [ -z "$pw" ] && [ "$YES" != 1 ] && [ "$DRY" != 1 ] && can_prompt; then
    info "Choose the password you will sign in with on your phone (at least 8 characters),"
    info "or just press Enter to get a generated one."
    while true; do
      printf '    Password: ' >/dev/tty
      IFS= read -rs a </dev/tty || a=""
      printf '\n' >/dev/tty
      [ -n "$a" ] || break
      if [ "${#a}" -lt 8 ]; then warn "At least 8 characters, please."; continue; fi
      printf '    Same password again: ' >/dev/tty
      IFS= read -rs b </dev/tty || b=""
      printf '\n' >/dev/tty
      if [ "$a" != "$b" ]; then warn "Those didn't match. Try again."; continue; fi
      pw="$a"
      break
    done
  fi
  if [ -z "$pw" ]; then pw="$(new_password)"; generated=1; fi
  if [ "$DRY" = 1 ]; then printf '    %s[dry-run] would save the sign-in password (only a hash of it is stored)%s\n' "$C_MAG" "$C_OFF"; return; fi
  printf '%s' "$pw" | node "$ROOT/agent-express.mjs" set-password >/dev/null || die "Could not save the password."
  PASSWORD_CHANGED=1
  [ "$generated" = 1 ] && SHOW_PASSWORD="$pw"
  ok "sign-in password saved"
}

# ------------------------------------------------------------------ autostart
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
service_path() { printf '%s' "$(dirname "$S_NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; }

register_autostart() {
  if [ "$OS" = mac ]; then change "add a launchd agent ($(plist_path)) that starts $E_NAME at login and restarts it if it crashes" _write_plist
  elif systemd_user_ok; then change "add a systemd user service ($UNIT_DIR/$E_UNIT) that starts $E_NAME at login and restarts it if it crashes" _write_unit
  else
    warn "This system has no systemd user session (WSL without systemd, or a container), so $E_NAME can't start by itself."
    info "Start it with ./start.sh after you log in."
    S_AUTOSTART=0
  fi
}
_write_plist() {
  local p
  p="$(plist_path)"
  mkdir -p "$(dirname "$p")" "$ROOT/$STATE_NAME/logs"
  cat >"$p" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Starts $(xml_escape "$E_NAME") at login. Written by its installer; ./uninstall.sh removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$E_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$S_NODE")</string>
    <string>$(xml_escape "$ROOT/agent-express.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(xml_escape "$(service_path)")</string></dict>
  <key>StandardOutPath</key><string>$(xml_escape "$ROOT/$STATE_NAME/logs/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$ROOT/$STATE_NAME/logs/launchd.log")</string>
</dict>
</plist>
EOF
  ok "$E_NAME will start by itself when you log in"
}
systemd_quote() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//%/%%}"; printf '"%s"' "$s"; }
_write_unit() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$E_UNIT" <<EOF
# Starts $E_NAME at login. Written by its installer; ./uninstall.sh removes it.
[Unit]
Description=$E_NAME (your Claude Code team)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$ROOT")
ExecStart=$(systemd_quote "$S_NODE") $(systemd_quote "$ROOT/agent-express.mjs")
Environment=$(systemd_quote "PATH=$(service_path)")
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$E_UNIT" >/dev/null 2>&1
  ok "$E_NAME will start by itself when you log in"
  info "To keep it running when you're logged out too: loginctl enable-linger $USER"
}

remove_autostart() {
  if [ "$OS" = mac ] && [ -f "$(plist_path)" ]; then
    change "remove the launchd agent $(plist_path)" _rm_plist
  elif [ "$OS" = linux ] && [ -f "$UNIT_DIR/$E_UNIT" ]; then
    change "remove the systemd user service $E_UNIT" _rm_unit
  fi
}
_rm_plist() { launchctl bootout "gui/$(id -u)/$E_LABEL" 2>/dev/null || true; rm -f "$(plist_path)"; ok "launchd agent removed"; }
_rm_unit() {
  systemctl --user disable --now "$E_UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$E_UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  ok "systemd user service removed"
}

# The launchd agent or systemd unit an install from before the rename made (tech.datafying.hearth,
# hearth.service...) starts a runner that isn't there any more, so it goes, when it's this copy's.
remove_old_autostart() {
  local p="${PLIST/LABEL/$E_OLD_LABEL}"
  if [ "$OS" = mac ] && [ -f "$p" ] && grep -qF "$ROOT/" "$p"; then
    change "remove the launchd agent $p (the app's name before the rename)" _rm_old_plist "$p"
  elif [ "$OS" = linux ] && [ -f "$UNIT_DIR/$E_OLD_UNIT" ] && grep -qF "$ROOT/" "$UNIT_DIR/$E_OLD_UNIT"; then
    change "remove the systemd user service $E_OLD_UNIT (the app's name before the rename)" _rm_old_unit
  fi
}
_rm_old_plist() { launchctl bootout "gui/$(id -u)/$E_OLD_LABEL" 2>/dev/null || true; rm -f "$1"; ok "old launchd agent removed"; }
_rm_old_unit() {
  systemctl --user disable --now "$E_OLD_UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$E_OLD_UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  ok "old systemd user service removed"
}

setup_autostart() {
  local want
  remove_old_autostart
  if [ -n "$AUTOSTART_FLAG" ]; then want="$AUTOSTART_FLAG"
  elif [ "$S_AUTOSTART" = 1 ] || [ "$S_AUTOSTART" = 0 ]; then want="$S_AUTOSTART"
  else
    info "Logging out closes every app you own, so $E_NAME can't answer your phone until it's started again."
    if ask "Start $E_NAME by itself whenever you log in?" 1; then want=1; else want=0; fi
  fi
  S_AUTOSTART="$want"
  if [ "$want" = 1 ]; then register_autostart
  else
    remove_autostart
    info "Not starting at login. Use ./start.sh to start it."
  fi
}

# ------------------------------------------------------------------ Tailscale
TS_STATE="" TS_DNS="" TS_IP=""
ts_info() {
  local line
  TS_STATE="" TS_DNS="" TS_IP=""
  [ -n "$(ts_bin)" ] || return 0
  line="$(AGENT_EXPRESS_TAILSCALE="$(ts_bin)" node "$ROOT/agent-express.mjs" tailscale-info 2>/dev/null || true)"
  IFS=$'\t' read -r TS_STATE TS_DNS TS_IP <<<"$line" || true
}
serve_target() { AGENT_EXPRESS_TAILSCALE="$(ts_bin)" node "$ROOT/agent-express.mjs" serve-target "$1" 2>/dev/null || true; }

# tailscale, and again with sudo when Linux says only root (or the operator) may change it.
ts_run() {
  local ts out rc=0
  ts="$(ts_bin)"
  out="$("$ts" "$@" 2>&1)" || rc=$?
  if [ "$rc" != 0 ] && [ "$OS" = linux ] && printf '%s' "$out" | grep -qiE 'access denied|permission|operator|must be root'; then
    info "Tailscale needs root for that; asking sudo (or run once: sudo tailscale set --operator=\$USER)."
    rc=0
    out="$(sudo_cmd "$ts" "$@" 2>&1)" || rc=$?
  fi
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/    /'
  return "$rc"
}

setup_tailscale() {
  [ "$NO_TS" = 1 ] && return 0
  [ -n "$(ts_bin)" ] || return 0
  ts_info
  if [ "$TS_STATE" != Running ]; then
    info "Tailscale is ${TS_STATE:-not running}. Signing this computer in to your tailnet; follow the link it shows (or the browser that opens)."
    info "Use the same account you will sign in with on your phone."
    change "run: tailscale up" ts_run up --timeout=5m || true
    [ "$DRY" = 1 ] || ts_info
    if [ "$TS_STATE" != Running ] && [ "$DRY" != 1 ]; then
      warn "Tailscale is not connected yet, so your phone cannot reach this computer."
      fix "open Tailscale and sign in (or run: sudo tailscale up), then run ./install.sh again."
      return 0
    fi
  fi
  [ "$TS_STATE" = Running ] && ok "Tailscale is connected as $TS_DNS"
  local want="http://127.0.0.1:$S_PORT" have_t
  have_t="$(serve_target "$S_PORT")"
  if [ "$have_t" = "$want" ]; then ok "tailscale serve already shares port $S_PORT"; return 0; fi
  if [ -n "$have_t" ]; then
    warn "Tailscale already serves port $S_PORT to $have_t; leaving it alone."
    fix "pick another port (./install.sh --port <n>), or remove it with: tailscale serve --http=$S_PORT off"
    return 0
  fi
  change "share it on your tailnet: tailscale serve --bg --http=$S_PORT $want" ts_run serve --bg --yes "--http=$S_PORT" "$want" || true
  [ "$DRY" = 1 ] && return 0
  if [ "$(serve_target "$S_PORT")" = "$want" ]; then ok "shared on your tailnet (port $S_PORT)"
  else
    warn "tailscale serve did not take."
    fix "if it printed a login.tailscale.com link, open it to allow Serve, then run ./install.sh again;"
    fix "or run it yourself: sudo tailscale serve --bg --http=$S_PORT $want"
  fi
}

remove_serve() {
  [ -n "$(ts_bin)" ] || return 0
  if [ "$(serve_target "$S_PORT")" = "http://127.0.0.1:$S_PORT" ]; then
    change "remove the Tailscale share: tailscale serve --http=$S_PORT off" ts_run serve "--http=$S_PORT" off || true
  fi
}

# ------------------------------------------------------------------ summary, doctor, update, uninstall
summary() {
  printf '\n  %s------------------------------------------------------------%s\n' "$C_DIM" "$C_OFF"
  printf '  %s%s is ready.%s\n\n' "$C_GREEN" "$E_NAME" "$C_OFF"
  printf '  On this computer: http://localhost:%s\n' "$S_PORT"
  if [ "$NO_TS" != 1 ]; then
    ts_info
    if [ "$TS_STATE" = Running ] && [ -n "$TS_DNS" ]; then
      printf '  On your phone:    http://%s:%s/app\n' "$TS_DNS" "$S_PORT"
      # The share answers to the machine's Tailscale name only (a 100.x address gets a 404), so no IP fallback.
      info "   (if that name doesn't load on the phone, turn on MagicDNS in Tailscale's admin console)"
      echo
      info "  1. Install Tailscale on your phone (App Store / Google Play) and sign in with the same account."
      info "  2. Open the address above in Safari (iPhone) or Chrome (Android) and sign in with your password."
      info "  3. Add it to your Home Screen: iPhone: Share, then 'Add to Home Screen'."
      info "                                 Android: the three-dot menu, then 'Add to Home screen' (or 'Install app')."
    else
      info "  Your phone address appears once Tailscale is connected: run ./install.sh again after signing in."
    fi
  fi
  echo
  if [ -n "$SHOW_PASSWORD" ]; then
    printf '  %sYour sign-in password: %s%s\n' "$C_YELLOW" "$SHOW_PASSWORD" "$C_OFF"
    info "  Write it down now: it is stored only as a hash and will not be shown again (./password.sh makes a new one)."
  else
    info "  Sign in with the password you chose (./password.sh sets a new one)."
  fi
  echo
  info "  Your workspace: $S_WORKSPACE"
  info "  In this folder: ./start.sh, ./stop.sh, ./doctor.sh (checks everything), ./update.sh, ./uninstall.sh"
  printf '  %s------------------------------------------------------------%s\n' "$C_DIM" "$C_OFF"
}

doctor() {
  local fails=0 c t pw st want have_t owner
  step "$E_NAME doctor: $ROOT"
  if [ "$(node_major)" -ge 20 ]; then ok "Node.js $(node -v) ($(command -v node))"; else bad "Node.js 20+ not found"; fix "install the LTS from https://nodejs.org (or nvm), then ./install.sh"; fails=$((fails + 1)); fi
  if have npm; then ok "npm $(npm -v 2>/dev/null)"; else bad "npm not found"; fix "reinstall Node.js"; fails=$((fails + 1)); fi
  if have git; then ok "$(git --version)"; else bad "Git not found"; fix "install git, then ./install.sh"; fails=$((fails + 1)); fi
  c="$(claude_bin)"
  if [ -n "$c" ] && "$c" --version >/dev/null 2>&1; then
    ok "Claude Code $("$c" --version) ($c)"
    case "$(claude_login)" in
      yes) ok "Claude Code is signed in" ;;
      no) bad "Claude Code is not signed in"; fix "run  claude  in a terminal and log in"; fails=$((fails + 1)) ;;
      *) warn "couldn't tell whether Claude Code is signed in"; fix "run  claude  once in a terminal to check" ;;
    esac
  else bad "Claude Code not found"; fix "curl -fsSL https://claude.ai/install.sh | bash"; fails=$((fails + 1)); fi
  if [ -d "$ROOT/node_modules" ]; then ok "packages installed"; else bad "packages not installed"; fix "./install.sh"; fails=$((fails + 1)); fi
  if [ -d "$ROOT/dist/server" ]; then ok "app built"; else bad "app not built"; fix "./install.sh (or npm run build)"; fails=$((fails + 1)); fi
  if [ "$HAS_SETTINGS" != 1 ]; then bad "not installed yet (no $STATE_NAME/settings.env)"; fix "./install.sh"; return 1; fi
  if [ -d "$S_WORKSPACE" ]; then ok "workspace $S_WORKSPACE"; else bad "workspace $S_WORKSPACE is missing"; fix "./install.sh recreates it"; fails=$((fails + 1)); fi
  if [ -d "$S_WORKSPACE/.git" ]; then ok "workspace is a git repository"; else bad "workspace is not a git repository (agents need one)"; fix "./install.sh, or: git -C \"$S_WORKSPACE\" init"; fails=$((fails + 1)); fi
  if have node; then
    t="$(node "$ROOT/agent-express.mjs" trust-workspace --check --workspace "$S_WORKSPACE" 2>&1)" && ok "Claude Code trusts the workspace" || {
      bad "Claude Code doesn't trust the workspace yet: agents would stop at its 'Do you trust this folder?' question ($t)"
      fix "./doctor.sh --force marks it trusted (stop $E_NAME first), or run  claude  in the workspace once and answer yes"
      fails=$((fails + 1))
      if [ "$FORCE" = 1 ] && ask "Mark $S_WORKSPACE as trusted in ~/.claude.json now?" 1; then trust_workspace; fi
    }
    pw="$(node "$ROOT/agent-express.mjs" password-status 2>/dev/null || echo none)"
    case "$pw" in
      set) ok "sign-in password set" ;;
      generated) warn "the office generated its own password"; fix "./password.sh sets one you know" ;;
      *) bad "no sign-in password"; fix "./password.sh"; fails=$((fails + 1)) ;;
    esac
  fi
  st="$(service_kind)"
  case "$st" in
    launchd) if [ -f "$(plist_path)" ]; then ok "launchd agent $E_LABEL"; else bad "the launchd agent is missing"; fix "./install.sh --autostart"; fails=$((fails + 1)); fi ;;
    systemd) if systemctl --user is-enabled "$E_UNIT" >/dev/null 2>&1; then ok "systemd user service $E_UNIT: $(systemctl --user is-active "$E_UNIT" 2>/dev/null)"; else bad "the systemd user service is missing"; fix "./install.sh --autostart"; fails=$((fails + 1)); fi ;;
    *) info "      not set to start at login (start it with ./start.sh)" ;;
  esac
  if health; then ok "running: http://localhost:$S_PORT answers"
  else
    owner="$(port_owner "$S_PORT" || true)"
    if [ -n "$owner" ]; then bad "port $S_PORT is taken by $owner, not $E_NAME"; fix "close it, or ./install.sh --port <another>"
    else bad "not running"; fix "./start.sh (then look at $STATE_NAME/logs/agent-express.log if it stops again)"; fi
    fails=$((fails + 1))
  fi
  if [ "$S_TAILSCALE" = 0 ]; then info "      Tailscale is off for this install (--no-tailscale)"
  elif [ -z "$(ts_bin)" ]; then bad "Tailscale not installed (your phone cannot reach this computer)"; fix "https://tailscale.com/download, then ./install.sh"; fails=$((fails + 1))
  else
    ts_info
    if [ "$TS_STATE" = Running ]; then ok "Tailscale connected as $TS_DNS"; else bad "Tailscale is ${TS_STATE:-not running}"; fix "open Tailscale and sign in (or: sudo tailscale up)"; fails=$((fails + 1)); fi
    want="http://127.0.0.1:$S_PORT"
    have_t="$(serve_target "$S_PORT")"
    if [ "$have_t" = "$want" ]; then ok "tailscale serve shares port $S_PORT -> phone: http://$TS_DNS:$S_PORT/app"
    elif [ -n "$have_t" ]; then bad "tailscale serve sends port $S_PORT to $have_t, not $E_NAME"; fix "tailscale serve --http=$S_PORT off, then ./install.sh"; fails=$((fails + 1))
    else bad "port $S_PORT is not shared on your tailnet"; fix "tailscale serve --bg --http=$S_PORT $want   (or ./install.sh)"; fails=$((fails + 1)); fi
  fi
  if [ -f "$ROOT/$STATE_NAME/logs/agent-express.log" ]; then
    local errs
    errs="$(tail -n 200 "$ROOT/$STATE_NAME/logs/agent-express.log" | grep -iE 'error|EADDRINUSE|unhandled' | tail -n 5 || true)"
    if [ -n "$errs" ]; then warn "recent errors in $STATE_NAME/logs/agent-express.log:"; printf '%s\n' "$errs" | sed 's/^/        /'; fi
  fi
  echo
  if [ "$fails" -gt 0 ]; then printf '  %s%s problem(s) found; the fixes are listed above.%s\n' "$C_YELLOW" "$fails" "$C_OFF"; return 1; fi
  printf '  %sEverything looks good.%s\n' "$C_GREEN" "$C_OFF"
}

update() {
  step "Updating $E_NAME in $ROOT"
  if have git && [ -d "$ROOT/.git" ]; then
    local before after
    before="$(git -C "$ROOT" rev-parse --short HEAD)"
    change "git pull --ff-only" git -C "$ROOT" pull --ff-only || die "git pull --ff-only did not succeed (local changes?)." "Look at: git -C \"$ROOT\" status"
    after="$(git -C "$ROOT" rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then ok "already the newest ($after)"; else ok "updated $before -> $after"; fi
  else
    change "download the newest $E_NAME over $ROOT (your settings and workspace are not in it)" _download "$ROOT"
  fi
  # The rest is the new version's installer, with the settings you already chose and no questions.
  local args=(install --yes)
  [ "$DRY" = 1 ] && args+=(--dry-run)
  [ "$FORCE" = 1 ] && args+=(--force)
  exec bash "$ROOT/install.sh" "${args[@]}"
}

uninstall() {
  step "Uninstalling $E_NAME from this computer"
  stop_app
  remove_autostart
  remove_old_autostart
  [ "$HAS_SETTINGS" = 1 ] && remove_serve
  echo
  info "Left in place, for you to delete by hand if you want:"
  info "  your workspace and everything the team made: $S_WORKSPACE"
  info "  the app itself: $ROOT"
  info "  Node.js, Git, Claude Code and Tailscale (if you only installed them for $E_NAME)"
}

# ------------------------------------------------------------------ main
ROOT=""
main() {
  parse_args "$@"
  [ "$DRY" = 1 ] && printf '  %sDRY RUN: checking only, nothing will be changed.%s\n' "$C_MAG" "$C_OFF"
  detect_os
  if [ -n "$REPO_ARG" ]; then ROOT="$(cd "$REPO_ARG" && pwd)"
  else
    local src="${BASH_SOURCE[0]:-}"
    if [ -n "$src" ] && [ -f "$src" ]; then ROOT="$(cd "$(dirname "$src")" && pwd)"; fi
  fi
  if ! is_checkout "$ROOT"; then
    [ "$ACTION" = install ] || die "This isn't inside a copy of Agent Express (${ROOT:-piped})." "Run it from the folder you installed the app into."
    bootstrap
    return
  fi
  move_old_state
  read_settings
  local ed="${EDITION:-${S_EDITION:-}}"
  [ -n "$ed" ] || ed="$(detect_edition "$ROOT")"
  ed="$(resolve_edition "$ed")"
  set_edition "$ed"
  S_EDITION="$ed"
  S_PORT="${PORT:-${S_PORT:-$E_PORT}}"
  case "$S_PORT" in '' | *[!0-9]*) die "--port must be a number, not $S_PORT" ;; esac
  [ "$S_PORT" -ge 1 ] && [ "$S_PORT" -le 65535 ] || die "--port must be 1-65535, not $S_PORT"
  local ws="${WORKSPACE:-${S_WORKSPACE:-$HOME/$E_WS}}"
  case "$ws" in "~"*) ws="$HOME${ws#\~}" ;; /*) ;; *) ws="$PWD/$ws" ;; esac
  ws="${ws%/}"
  # Written down as a clean absolute path (no ../), the form Claude Code and the office see.
  if [ -d "$(dirname "$ws")" ]; then ws="$(cd "$(dirname "$ws")" && pwd -P)/$(basename "$ws")"; fi
  S_WORKSPACE="$ws"
  if [ "$NO_TS" = 1 ] || { [ "$S_TAILSCALE" = 0 ] && [ "$ACTION" != install ]; }; then NO_TS=1; S_TAILSCALE=0; else S_TAILSCALE=1; fi

  case "$ACTION" in
    start)
      [ "$HAS_SETTINGS" = 1 ] || die "$E_NAME is not installed yet." "Run ./install.sh first."
      start_app || exit 1
      if [ "$OPEN" = 1 ] && [ "$DRY" != 1 ]; then
        if [ "$OS" = mac ]; then open "http://localhost:$S_PORT/"; elif have xdg-open; then xdg-open "http://localhost:$S_PORT/" >/dev/null 2>&1 || true; fi
      fi
      return 0 ;;
    stop) stop_app; return 0 ;;
    restart) stop_app; start_app; return ;;
    status)
      if health; then echo "  $E_NAME: running on port $S_PORT; workspace $S_WORKSPACE"; return 0; fi
      echo "  $E_NAME: not running (port $S_PORT); workspace $S_WORKSPACE"
      return 1 ;;
    doctor) doctor; return ;;
    update) update; return ;;
    uninstall) uninstall; return ;;
    password)
      [ "$HAS_SETTINGS" = 1 ] || die "$E_NAME is not installed yet." "Run ./install.sh first."
      local running=0
      health && running=1
      ensure_password 1
      if [ "$running" = 1 ] && [ "$PASSWORD_CHANGED" = 1 ]; then info "Restarting so the new password takes effect..."; stop_app >/dev/null; start_app >/dev/null || true; fi
      [ -n "$SHOW_PASSWORD" ] && printf '\n  %sYour new sign-in password: %s%s\n' "$C_YELLOW" "$SHOW_PASSWORD" "$C_OFF"
      return 0 ;;
  esac

  # ---- install
  printf '\n  %s%s installer%s\n' "$C_BOLD" "$E_NAME" "$C_OFF"
  printf '  %syour own team of Claude Code agents, on this computer, in your pocket%s\n' "$C_DIM" "$C_OFF"
  info "app folder: $ROOT"
  info "workspace:  $S_WORKSPACE"
  info "port:       $S_PORT"

  step "Checking this computer"
  if [ "$OS" = mac ]; then ok "macOS $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
  else ok "Linux $(uname -r) ($(uname -m))$([ "$IS_WSL" = 1 ] && echo ', inside WSL')"; fi
  if [ -n "$PKG" ]; then ok "package manager: $PKG (used to install anything missing)"; else info "No package manager found: anything missing is installed per user (nvm, the official installers) or by hand."; fi
  ensure_node
  ensure_git
  ensure_claude
  ensure_claude_login
  ensure_tailscale
  S_NODE="$(command -v node || true)"

  step "Installing the app"
  local owner
  owner="$(port_owner "$S_PORT" || true)"
  if [ -n "$owner" ] && [ -z "$(app_pids)" ]; then
    die "Port $S_PORT is already in use by $owner." "Close it, or choose another port: ./install.sh --port $((S_PORT + 1))"
  fi
  build_app
  write_settings

  step "Your workspace"
  setup_workspace

  step "Sign-in password"
  ensure_password "$RESET_PW"

  step "Starting at login"
  setup_autostart
  write_settings

  if [ "$NO_START" != 1 ]; then
    step "Starting $E_NAME"
    if [ "$DRY" != 1 ] && { [ "$PASSWORD_CHANGED" = 1 ] || [ "$REBUILT" = 1 ]; }; then stop_app >/dev/null; fi
    start_app || { [ "$DRY" = 1 ] || die "$E_NAME did not start." "Run ./doctor.sh to see why."; }
  else info "Not starting it (--no-start). Use ./start.sh when you are ready."; fi

  if [ "$NO_TS" != 1 ]; then
    step "Reaching it from your phone (Tailscale)"
    setup_tailscale
  fi
  if [ "$DRY" = 1 ]; then printf '\n  %sDry run finished: nothing was changed.%s\n' "$C_MAG" "$C_OFF"; return 0; fi
  summary
}

main "$@"; exit $?
