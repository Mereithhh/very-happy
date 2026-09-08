# Connection quality

Import `connection-quality.dashboard.json` into Grafana and select the Prometheus
source that scrapes Very Happy. The import creates a dedicated dashboard; it does
not modify an existing dashboard. Device and region filters have finite values.

The production server exposes metrics on the active slot's **loopback** port:
blue 9101, green 9102. Confirm `/opt/happy/release/state.env` and actual HTTP
response before configuring a scrape. Do not expose these ports publicly.
A collector on that host can scrape both slots with job name `very-happy`;
relabelling/target discovery must distinguish inactive slots from an outage. A
remote collector needs an existing authenticated/private path to the host.
Repository Kubernetes overlays are local examples, not the production topology.

The dashboard includes received terminal success rate, foreground P50/P95,
stage failures, central compatibility route share, timing sample quality,
deduplication/coordination drops, sample count, and collector scrape health.
There is no automatic production Grafana import or collector installation.

Interpretation:

- These are **received telemetry samples**, not a complete availability SLO.
  Offline pages may lose their memory-only queue; a connection with no final
  event is not included. Check sample counts and scrape health alongside rates.
- Only successful, active, uncensored foreground samples enter latency panels.
  Background, old-client unknown, and capped samples remain visible separately.
- Fallback means regional routing was unavailable and a machine RPC used the
  central compatibility path. Missing assignments or cooldown count; this is
  not an error rate. Its ratio deliberately aggregates across regions because
  attempted and executed regions differ. Short windows can be skewed by upload
  delay; use a longer window rather than clamping misleading ratios to 100%.
- Redis prevents replay counting across replicas within 15 minutes. A delayed
  replay beyond that TTL can be counted again. Without Redis, deduplication is
  local and bounded. Coordination failures drop metric samples, not diagnostic
  logs; the skipped-sample panel exposes that gap.
- Samples span process restarts through Prometheus. Without a configured scrape
  only the process's current counters exist; no dashboard can recover history.

The complete field/compatibility contract and PromQL are in
`specs/2026-09-connection-metrics.md`. Validate a release using a synthetic event
from an owned account, its default log record, the matching exported metric,
and finally a successful collector query; these are separate checks.
