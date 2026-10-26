#!/usr/bin/env bash
# B-827: refuse production compose files whose services do not rotate their
# container logs (json-file/local driver with max-size and max-file). Renders
# each file without interpolation, so no env file or secret is needed.
# Usage: check-log-rotation.sh <compose-file>...
set -euo pipefail

FILTER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/log-rotation.jq"
[ "$#" -gt 0 ] || { echo 'usage: check-log-rotation.sh <compose-file>...' >&2; exit 2; }

status=0
for file in "$@"; do
    rendered=$(docker compose -f "$file" config --no-interpolate --format json) || {
        echo "log rotation: cannot render $file" >&2
        status=1
        continue
    }
    offenders=$(jq -r -f "$FILTER" <<<"$rendered") || { echo "log rotation: cannot check $file" >&2; status=1; continue; }
    if [ -n "$offenders" ]; then
        echo "log rotation: $file has services without json-file max-size/max-file: $(echo $offenders)" >&2
        status=1
    else
        echo "log rotation ok: $file"
    fi
done
exit "$status"
