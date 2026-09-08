---
name: metrics-graphana
description: Query Very Happy connection and RPC metrics, maintain its Grafana dashboard, and diagnose the private Prometheus collection path. Use for monitoring, Grafana, Prometheus, and connection-quality panels.
---

# Very Happy monitoring

Read [docs/monitoring/README.md](../../../docs/monitoring/README.md) first: it owns
the deployed topology, object names, data semantics and rollback. Application
release remains owned by the `release` skill and `docs/operations.md`.

## Choose the actual management path

- Production uses the existing sy Grafana/Prometheus stack. Reach its Kubernetes
  API through `ssh k8s`; verify host identity and current Service addresses before
  queries. A local kubeconfig context named sy is not evidence its credentials work.
- The connection dashboard is managed by the dedicated ConfigMap documented in
  the runbook. Edit `docs/monitoring/connection-quality.dashboard.json`, resolve
  `${DS_PROMETHEUS}` to the verified existing data source UID when provisioning,
  and change only the owned ConfigMap after exporting its previous state.
- Its existing provider has `allowUiUpdates=false`. Do not switch to an API/UI
  overwrite, change the global provider, or install grafanactl just to update it.
  Other dashboards may have a different owner; inspect before changing them.
- Do not assume a repo `.env`, Basic Auth, or an initial Kubernetes admin Secret
  provides current Grafana access. An auth failure is not permission to reset a
  password. Never print credentials or persist session cookies in artifacts.

## Query and verify

Resolve the Prometheus Service address using the cluster API, then query its
`/api/v1/query` or `/api/v1/query_range` from the authorized private host. Keep
operational artifacts under `~/code/github/skills/tmp/<task>/`.

Start with `up{job="very-happy"}` and `max(up{job="very-happy"})`, then inspect
`browser_connection_stage_results_total` and `rpc_calls_total`. Use the checked-in
dashboard for PromQL; avoid duplicating expressions in this skill.

Creation of a ServiceMonitor or a dashboard is not verification. Check the
Prometheus active targets, actual received samples, query responses, and the
loaded dashboard's UID/data source separately. A stopped inactive blue-green
slot is expected; absent samples are unknown, not zero failures or zero latency.

If the operator reconciles a new target but it is absent from runtime config,
compare the generated Secret, the reloader's mounted config, `config_out`, and
Prometheus `/api/v1/status/config`. The runbook records one stale reloader case;
do not infer every missing target needs a restart. Restore only the failed layer
within the authorized scope, then verify samples without restarting the TSDB.

Connection latency covers received, active foreground telemetry, not a complete
availability SLO. Prefer a real operation on an owned account for verification;
keep synthetic samples identifiable and out of mobile/region latency claims.
