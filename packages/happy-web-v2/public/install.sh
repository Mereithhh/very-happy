#!/bin/sh

# Very Happy first-machine bootstrap for macOS and Linux.
# Source: https://github.com/Mereithhh/very-happy/blob/main/packages/happy-web-v2/public/install.sh
#
# This script deliberately does not use sudo, install tmux, or configure an AI
# provider credential. It resolves one exact npm version, installs it, runs
# local diagnostics, opens the normal Web approval flow, and starts the
# detached machine daemon.

set -eu

DRY_RUN=0
SKIP_AUTH=0
SKIP_DAEMON=0

usage() {
  cat <<'EOF'
Very Happy first-machine bootstrap

Usage:
  sh install.sh [--dry-run] [--no-auth] [--no-daemon]

Options:
  --dry-run    Print the commands without installing, authenticating, or starting.
  --no-auth    Install and diagnose without opening the Web approval flow.
  --no-daemon  Install and authenticate without starting the background daemon.
  -h, --help   Show this help.

Environment:
  VERY_HAPPY_CLI_VERSION  Install this exact version instead of the npm latest tag.
  HAPPY_SERVER_URL        Relay API/socket endpoint (defaults to Very Happy Cloud).
  HAPPY_WEBAPP_URL        Browser approval origin (defaults to Very Happy Cloud).
  HAPPY_HOME_DIR          Separate local state directory for a custom relay.
EOF
}

say() { printf '%s\n' "$*"; }
fail() { printf 'very-happy install: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-auth) SKIP_AUTH=1 ;;
    --no-daemon) SKIP_DAEMON=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

case "$(uname -s 2>/dev/null || true)" in
  Darwin|Linux) ;;
  *) fail 'this bootstrap currently supports macOS and Linux; use the manual npm instructions on other systems' ;;
esac

command -v node >/dev/null 2>&1 || fail 'Node.js is required (20.19+ within 20.x, 22.13+ within 22.x, or 24+)'
command -v npm >/dev/null 2>&1 || fail 'npm is required'

NODE_VERSION=$(node -p 'process.versions.node')
node -e '
  const [major, minor] = process.argv[1].split(".").map(Number);
  const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24;
  process.exit(ok ? 0 : 1);
' "$NODE_VERSION" || fail "unsupported Node.js $NODE_VERSION (need 20.19+ within 20.x, 22.13+ within 22.x, or 24+)"

NODE_ARCH=$(node -p 'process.arch')
case "$NODE_ARCH" in
  x64|arm64) ;;
  *) fail "unsupported CPU architecture $NODE_ARCH (the published CLI supports x64 and arm64)" ;;
esac

CUSTOM_SERVER_URL=${HAPPY_SERVER_URL:-}
CUSTOM_WEBAPP_URL=${HAPPY_WEBAPP_URL:-}
if { [ -n "$CUSTOM_SERVER_URL" ] && [ -z "$CUSTOM_WEBAPP_URL" ]; } ||
   { [ -z "$CUSTOM_SERVER_URL" ] && [ -n "$CUSTOM_WEBAPP_URL" ]; }; then
  fail 'HAPPY_SERVER_URL and HAPPY_WEBAPP_URL must be configured together'
fi
if [ -n "$CUSTOM_SERVER_URL" ]; then
  node -e '
    for (const value of process.argv.slice(1)) {
      let url;
      try { url = new URL(value); } catch { process.exit(1); }
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) process.exit(1);
    }
  ' "$CUSTOM_SERVER_URL" "$CUSTOM_WEBAPP_URL" || fail 'custom endpoints must use HTTPS (plain HTTP is allowed only on loopback)'
fi

CLI_VERSION=${VERY_HAPPY_CLI_VERSION:-}
if [ -z "$CLI_VERSION" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    CLI_VERSION='<published-version>'
  else
    say 'Resolving the current published CLI version...'
    CLI_VERSION=$(npm view very-happy-cli version 2>/dev/null) || fail 'could not resolve very-happy-cli from npm'
  fi
fi

if [ "$DRY_RUN" -ne 1 ] || [ "$CLI_VERSION" != '<published-version>' ]; then
  node -e '
    const version = process.argv[1];
    const valid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
    process.exit(valid ? 0 : 1);
  ' "$CLI_VERSION" || fail 'npm returned an invalid CLI version'
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ '
    printf '%s ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

say ''
say 'Connect to Very Happy Cloud, or point the CLI at your self-hosted deployment.'
say 'Deployment, privacy, and security details:'
say '  https://happy.mereith.com/docs/security'
say ''
if [ "$CLI_VERSION" = '<published-version>' ]; then
  say 'Package target: the current published very-happy-cli version (resolved during a real run)'
else
  say "Installing exact package: very-happy-cli@$CLI_VERSION"
fi
run npm install --global --no-fund --no-audit "very-happy-cli@$CLI_VERSION"

VH_BIN=very-happy
if [ "$DRY_RUN" -ne 1 ] && ! command -v "$VH_BIN" >/dev/null 2>&1; then
  NPM_PREFIX=$(npm prefix --global 2>/dev/null || true)
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/very-happy" ]; then
    VH_BIN="$NPM_PREFIX/bin/very-happy"
  else
    fail 'npm installed the package but very-happy is not on PATH; add the npm global bin directory and retry'
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  run "$VH_BIN" --version
else
  INSTALLED_VERSION_OUTPUT=$("$VH_BIN" --version 2>/dev/null) || fail 'the installed very-happy binary did not start'
  [ "$INSTALLED_VERSION_OUTPUT" = "very-happy version: $CLI_VERSION" ] || fail "installed binary version does not match $CLI_VERSION (found: $INSTALLED_VERSION_OUTPUT)"
  say "Verified installed CLI: $CLI_VERSION"
fi

say ''
say 'Checking this machine (provider credential values are not intentionally read)...'
say 'Review diagnostic output before sharing it.'
run "$VH_BIN" doctor

if command -v tmux >/dev/null 2>&1; then
  say 'tmux detected: durable Web terminals are available.'
else
  say 'tmux not detected: terminals will use the non-persistent direct-shell fallback.'
  say 'Install tmux separately if you want durable reconnectable terminals.'
fi

if [ "$SKIP_AUTH" -eq 0 ]; then
  say ''
  say 'Opening the normal one-time Web approval flow...'
  run "$VH_BIN" auth login
else
  say ''
  say 'Skipping authentication (--no-auth).'
fi

if [ "$SKIP_DAEMON" -eq 0 ]; then
  say ''
  say 'Starting the detached machine daemon...'
  run "$VH_BIN" daemon start
else
  say ''
  say 'Skipping daemon startup (--no-daemon).'
fi

WEB_URL=${HAPPY_WEBAPP_URL:-https://happy.mereith.com}
say ''
if [ "$DRY_RUN" -eq 1 ]; then
  say 'Preview complete; no local changes were made.'
  say 'Run the bootstrap again without --dry-run when you are ready.'
elif [ "$SKIP_AUTH" -eq 1 ] || [ "$SKIP_DAEMON" -eq 1 ]; then
  say 'The requested bootstrap steps are complete.'
  if [ "$SKIP_AUTH" -eq 1 ]; then
    say 'Authenticate this machine when needed:'
    say '  very-happy auth login'
  fi
  if [ "$SKIP_DAEMON" -eq 1 ]; then
    say 'Start the detached daemon when needed:'
    say '  very-happy daemon start'
  fi
  say "Then open $WEB_URL and create your first session."
else
  say 'Very Happy is ready on this machine.'
  say "Open $WEB_URL and create your first session."
fi
say 'Structured Claude needs a provider credential in the daemon startup environment.'
say 'If you configure it after this script, restart the daemon so it inherits the change:'
say '  very-happy daemon stop && very-happy daemon start'
