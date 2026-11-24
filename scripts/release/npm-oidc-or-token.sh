#!/usr/bin/env bash
# B-967: run an npm write command (publish / dist-tag) through npm trusted
# publishing (GitHub OIDC) first; during the transition, fall back to the
# long-lived NPM_TOKEN only when OIDC fails, and say so loudly.
#
# Usage: npm-oidc-or-token.sh <label> npm <args...>
#   env NPM_FALLBACK_TOKEN  optional; the repo secret NPM_TOKEN. Empty = no fallback.
#
# Why not just set NODE_AUTH_TOKEN and let npm pick: npm >= 11.5.1 tries OIDC
# first but falls back to the configured token *silently* (only a verbose log
# line), so a broken trusted-publisher config would never be noticed before the
# token is revoked. Here the first attempt carries no usable token at all, so it
# can only succeed through OIDC, and the notice/warning below is the audit trail.
#
# Remove the fallback branch (and the NPM_TOKEN secret) once the first release
# has been seen to publish and promote via OIDC.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> npm <args...>" >&2
  exit 2
fi
label=$1
shift

# The .npmrc written by actions/setup-node reads ${NODE_AUTH_TOKEN}. A
# placeholder keeps that file valid while guaranteeing it cannot authenticate.
if NODE_AUTH_TOKEN=oidc-only-placeholder "$@"; then
  echo "::notice title=npm auth::${label}: authenticated via OIDC trusted publishing"
  exit 0
fi

if [ -z "${NPM_FALLBACK_TOKEN:-}" ]; then
  echo "::error title=npm auth::${label}: OIDC trusted publishing failed and no NPM_TOKEN fallback is configured. Check the trusted publisher on npmjs.com (repo, workflow file publish.yml, allowed actions) and that the job has id-token: write." >&2
  exit 1
fi

echo "::warning title=npm auth::${label}: OIDC trusted publishing failed; retrying with the NPM_TOKEN fallback (transition only, B-967). Fix the trusted publisher config before the token is revoked."
NODE_AUTH_TOKEN=$NPM_FALLBACK_TOKEN "$@"
echo "::warning title=npm auth::${label}: succeeded via NPM_TOKEN fallback, NOT via OIDC"
