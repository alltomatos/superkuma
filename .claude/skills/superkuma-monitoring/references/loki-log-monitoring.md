# Loki log monitoring (ADR-0019)

SuperKuma's `loki` monitor type queries an existing Grafana Loki server via LogQL and turns aggregated counts (e.g. "how many ERROR lines in the last 5 minutes") into alerts. SuperKuma never stores or full-text-searches raw log content -- Loki is the log store, SuperKuma is a client.

## 1. Bring up the bundled Loki (optional)

`compose.yaml` includes an optional `loki` service (same pattern as `influxdb`) -- single-binary mode, local filesystem storage:

```sh
docker compose up -d loki
curl http://<host>:3100/ready   # expect 200
```

If the client already runs their own Loki, skip this and just point the monitor at it.

## 2. Point a log-shipping agent at it

SuperKuma does not ship a log collector. Point any of these at the Loki push API (`http://<host>:3100/loki/api/v1/push`):

- **Grafana Alloy** (recommended, successor to Promtail) -- `loki.write` component.
- **Promtail** -- `clients: [{url: "http://<host>:3100/loki/api/v1/push"}]`.
- **Fluentbit** -- `loki` output plugin.
- **OTel Collector** -- `loki` exporter, or the native OTLP logs pipeline if the target Loki version supports it.

Label your streams meaningfully (`job`, `host`, `service`) -- LogQL rules select on these labels.

## 3. Create a `loki`-type monitor

In SuperKuma: Add Monitor -> type `Loki (LogQL)`.

- **Loki URL**: base URL, e.g. `http://loki:3100`.
- **Reachability Query** (optional): a cheap LogQL query just to confirm Loki answers (e.g. `{job="app"}`). Leave empty to use `GET /ready` instead. This is the _only_ thing that can turn the monitor DOWN.
- **Log Rules**: add one row per pattern to watch. Each rule is independent -- its own LogQL, operator/threshold, and severity. A tripped rule never turns the monitor DOWN; it raises a severity-routed `alert_event` (same pipeline as anomaly detection, ADR-0013/0014).

Example rule:

| Field     | Value                                           |
| --------- | ----------------------------------------------- |
| Name      | ERROR spikes                                    |
| LogQL     | `count_over_time({job="app"} \|= "error" [5m])` |
| Operator  | `>`                                             |
| Threshold | `5`                                             |
| Severity  | `critical`                                      |

## 4. Route the alert

Log-rule alerts go through the same `notification_route` mechanism as every other severity-based alert (Settings -> Notification Routing). A route with `min_severity: warning` and no `monitor_id`/`tag_id` (a wildcard) catches every warning-or-above alert across every monitor, including log rules -- no Loki-specific routing config needed.

## MCP

If creating `loki` monitors via the MCP server, use the standard `create_monitor`/`update_monitor` tools with `type: "loki"`, `url`, and optionally `loki_reachability_query`. Log rules are a separate per-monitor resource -- create the monitor first, then add rules via the `addLogRule`/`updateLogRule`/`deleteLogRule`/`getLogRuleList` socket events (or the equivalent MCP tools, if exposed -- check `server/mcp/tools/monitors.js`).
