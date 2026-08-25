#!/usr/bin/env bash

# Ordinary CI scans only commits introduced by the current push or pull request.
# The public lineage was sanitized and passed a complete-history scan before
# publication; `--history` remains the repeatable full-lineage audit mode.

set -euo pipefail

GITLEAKS_VERSION="8.30.0"
GITLEAKS_LINUX_X64_SHA256="79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e"

die() {
  echo "secret-scan: $*" >&2
  exit 2
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    GITLEAKS_BIN="$(command -v gitleaks)"
    return
  fi

  [ "$(uname -s)" = Linux ] || die "automatic install only supports Linux; install gitleaks ${GITLEAKS_VERSION} locally"
  [ "$(uname -m)" = x86_64 ] || die "automatic install only supports Linux x86_64"

  GITLEAKS_SCAN_TMP="$(mktemp -d)"
  local archive binary
  archive="${GITLEAKS_SCAN_TMP}/gitleaks.tar.gz"
  binary="${GITLEAKS_SCAN_TMP}/gitleaks"
  trap 'rm -rf "${GITLEAKS_SCAN_TMP:-}"' EXIT

  curl --fail --silent --show-error --location \
    --output "$archive" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  echo "${GITLEAKS_LINUX_X64_SHA256}  ${archive}" | sha256sum --check --status \
    || die "gitleaks archive checksum mismatch"
  tar -xzf "$archive" -C "$GITLEAKS_SCAN_TMP" gitleaks
  chmod 700 "$binary"
  GITLEAKS_BIN="$binary"
}

mode="${1:-range}"
GITLEAKS_BIN=""
GITLEAKS_SCAN_TMP=""
install_gitleaks

case "$mode" in
  --history)
    log_opts="--all"
    ;;
  --range)
    [ "$#" -eq 2 ] || die "usage: $0 --range <git-log-range>"
    log_opts="$2"
    ;;
  --ci)
    [ "$#" -eq 1 ] || die "usage: $0 --ci"
    case "${GITHUB_EVENT_NAME:-}" in
      pull_request)
        [ -n "${GITHUB_BASE_SHA:-}" ] || die "GITHUB_BASE_SHA is required for pull_request"
        [ -n "${GITHUB_SHA:-}" ] || die "GITHUB_SHA is required for pull_request"
        log_opts="${GITHUB_BASE_SHA}..${GITHUB_SHA}"
        ;;
      push)
        [ -n "${GITHUB_SHA:-}" ] || die "GITHUB_SHA is required for push"
        if [ -n "${GITHUB_BEFORE_SHA:-}" ] \
          && [ "$GITHUB_BEFORE_SHA" != "0000000000000000000000000000000000000000" ] \
          && git cat-file -e "${GITHUB_BEFORE_SHA}^{commit}" 2>/dev/null; then
          log_opts="${GITHUB_BEFORE_SHA}..${GITHUB_SHA}"
        else
          log_opts="${GITHUB_SHA}^!"
        fi
        ;;
      workflow_dispatch)
        log_opts="${GITHUB_SHA:-HEAD}^!"
        ;;
      *)
        die "unsupported GITHUB_EVENT_NAME=${GITHUB_EVENT_NAME:-unset}"
        ;;
    esac
    ;;
  *)
    die "usage: $0 --ci | --range <git-log-range> | --history"
    ;;
esac

echo "secret-scan: gitleaks ${GITLEAKS_VERSION}, git log ${log_opts}"
"$GITLEAKS_BIN" git . \
  --log-opts="$log_opts" \
  --redact=100 \
  --no-banner \
  --no-color
