# Connection quality

Import `connection-quality.dashboard.json` into Grafana and select the Prometheus
source that scrapes Very Happy. The import creates a dedicated dashboard; it does
not modify an existing dashboard. Device and region filters have finite values.

## Deployed collection topology

The monitoring stack is the existing **sy / k8s-main** installation. Grafana and
Prometheus run in `cattle-monitoring-system`; Prometheus retains 30 days. No
Grafana or Prometheus server was added to the application host.

```text
Grafana (sy) → existing Prometheus (sy)
  → monitoring/very-happy-metrics ServiceMonitor, job=very-happy
  → 100.100.0.2:19101 / :19102 on k8s-main
  → authenticated SSH to vh-sg
  → 127.0.0.1:9101 blue / :9102 green on vh-sg
```

| Component | Deployment identity |
| --- | --- |
| Tunnel / ingress guard | `vh-metrics-tunnel.service` / `vh-metrics-firewall.service` on k8s-main |
| Tunnel account | sy `vh-metrics-tunnel` → vh-sg `vh-metrics` |
| Services and Endpoints | `monitoring/very-happy-metrics-blue`, `monitoring/very-happy-metrics-green` |
| ServiceMonitor | `monitoring/very-happy-metrics`, 30s interval, 10s timeout |
| Metric target labels | `job="very-happy"`, `slot="blue"` or `slot="green"` |
| Dashboard provisioning | `cattle-dashboards/very-happy-connection-quality` ConfigMap, `grafana_dashboard="1"` |
| Grafana data source | Existing `prometheus` UID, cluster-local `rancher-monitoring-prometheus.cattle-monitoring-system:9090` |
| Dashboard | UID `very-happy-connections`; [view](https://grafana.mereith.com/d/very-happy-connections) or [Singapore proxy](https://stat.mereith.com/d/very-happy-connections) |

Both slot targets stay configured through releases. A stopped inactive slot is
**expected to be offline**. Overall scrape health is
`max(up{job="very-happy"})`: at least one slot must be scrapeable. The same panel
also shows individual slot series for diagnosis. No series means collection is
missing, not healthy. Check `/opt/happy/release/state.env` and the actual metrics
response to identify the active slot; do not alert on every inactive-slot zero.

The application metrics ports remain loopback-only on vh-sg. The tunnel binds
only sy's private address `100.100.0.2`; the owned `VH_METRICS` iptables chain
allows the verified sy pod CIDR `10.42.0.0/24` and the host itself to ports
19101/19102, rejecting other sources. It does not modify Kubernetes-owned
chains. The firewall unit starts before the tunnel and persists across reboot;
verify these rules again if the pod CIDR or host address changes.

SSH uses a dedicated on-disk private key under `/var/lib/vh-metrics-tunnel`, with
restricted file permissions and a pinned host key. Never put keys in this repo.
The existing Grafana Secret does not provide a working login: the tested public
login returned 403 and the internal login returned 401. No password was reset.
The dashboard therefore uses the existing ConfigMap provisioning path in
`cattle-dashboards`, with label `grafana_dashboard="1"`. The existing provider
scans every 30 seconds and has `allowUiUpdates=false`; changes belong in the
repository JSON and its managed ConfigMap, not the Grafana UI. Its UID was checked
for collision in the existing Grafana database before provisioning. Resolve
`DS_PROMETHEUS` to the existing `prometheus` UID when preparing the ConfigMap.
This does not change the global provider or create a new data source.

When collection was first added, the Prometheus configuration Secret updated but
the config-reloader's old watch did not update `config_out`. Restarting only the
**config-reloader container**, without restarting Prometheus or its TSDB, restored
configuration delivery; the green target was then verified up. Check both
rendered configuration and live targets before considering a future collection
change complete. Do not restart the whole monitoring stack for a stale sidecar
without first establishing the same evidence.

## Rollback

Before changes, export affected objects/dashboard to a private operator backup.
Remove only `monitoring/very-happy-metrics` ServiceMonitor and the two explicitly
named Service/Endpoints pairs after checking their ownership. Then stop and
disable `vh-metrics-tunnel.service` **before** stopping its firewall unit. The
owned `/etc/very-happy-metrics/firewall stop` removes only its exact INPUT jump
and `VH_METRICS` chain; never flush INPUT or Kubernetes chains. Remove the two
owned unit files and reload systemd only after verifying no tunnel is running.
Revoke the dedicated vh-sg authorized key after stopping the connection; retain
private keys securely for investigation or remove them under separate cleanup.

For the dashboard, restore the prior ConfigMap backup, or delete only the newly
created `cattle-dashboards/very-happy-connection-quality` ConfigMap after checking
its ownership. Verify that the sidecar removes the file and the existing provider
removes the provisioned UID; do not alter the global provider to force deletion. Collection rollback does not need
an application restart, image rollback, Caddy change or database change. The
repository's Kubernetes overlays are examples, not this production deployment.

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
