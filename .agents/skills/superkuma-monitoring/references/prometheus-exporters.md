# Prometheus exporters — quick-start & verified metrics

How to get metrics flowing into Prometheus so the `prometheus` monitor type has something to
query. Covers `node_exporter` (Linux), `windows_exporter` (Windows), and
`awaragi/prometheus-mssql-exporter` (SQL Server) — all metric names below are verified against
each exporter's real output, not guessed.

## node_exporter (Linux)

```bash
ver=1.9.1   # check https://github.com/prometheus/node_exporter/releases for the latest
wget "https://github.com/prometheus/node_exporter/releases/download/v${ver}/node_exporter-${ver}.linux-amd64.tar.gz"
tar xvf node_exporter-*.tar.gz && sudo mv node_exporter-*/node_exporter /usr/local/bin/
sudo useradd -rs /bin/false node_exporter

sudo tee /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now node_exporter
```

Metrics at `http://<host>:9100/metrics`. Verified names used in this skill's PromQL:
`node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_memory_MemTotal_bytes`,
`node_filesystem_avail_bytes`, `node_filesystem_size_bytes`, `node_disk_io_time_seconds_total`.
(Older unsuffixed names like `node_cpu`/`node_memory_MemTotal` are deprecated — don't use them.)

## windows_exporter (Windows)

Use the packaged script — it's idempotent (safe to re-run), kills a stray console-mode
process if one is already running, installs as a proper Windows service (survives reboot/
logoff, unlike running the `.exe` by hand in a terminal), and verifies the endpoint responds
before it exits: [`assets/windows/install-windows_exporter.ps1`](../assets/windows/install-windows_exporter.ps1).

```powershell
# As Administrator, from wherever you copied the script + (optionally) the downloaded MSI:
.\install-windows_exporter.ps1
# or pin a version / port / collector set:
.\install-windows_exporter.ps1 -Version 0.31.8 -Port 9182 -Collectors "cpu,memory,logical_disk,net,os,service,system"
# SQL Server host? add the mssql collector for buffer-cache-hit-ratio raw counters:
.\install-windows_exporter.ps1 -Collectors "cpu,memory,logical_disk,net,os,service,system,mssql"
```

Manual equivalent if you'd rather run `msiexec` directly:

```powershell
msiexec /i windows_exporter-<ver>-amd64.msi
# Or pick collectors explicitly (adds the mssql collector for SQL Server metrics — see below)
msiexec /i windows_exporter-<ver>-amd64.msi --% ENABLED_COLLECTORS="cpu,memory,logical_disk,net,mssql" ADDLOCAL=FirewallException
```

`ADDLOCAL=FirewallException` opens the port automatically; if you install some other way
(bare `.exe --service install`, no MSI), add the rule yourself:
`New-NetFirewallRule -DisplayName "windows_exporter" -Direction Inbound -Protocol TCP -LocalPort 9182 -Action Allow`.

Installs and starts as a Windows service automatically. Metrics at
`http://<host>:9182/metrics`. Verified names:

- CPU: `windows_cpu_time_total` (filter `mode="idle"`)
- Memory: `windows_memory_physical_free_bytes`, `windows_memory_physical_total_bytes` (total) —
  confirmed against a real `windows_exporter` v0.30.4 install (Tecbrita, 2026-07-07). Older docs
  and some tutorials reference `windows_os_physical_memory_free_bytes`/
  `windows_cs_physical_memory_bytes` — those names come from an older exporter version and were
  **not present** on v0.30.4; always confirm against your own `/metrics` output
  (`curl host:9182/metrics | grep windows_memory` or Prometheus's
  `/api/v1/label/__name__/values`) before wiring a monitor, metric names do drift across releases.
- Logical disk: `windows_logical_disk_free_bytes`, `windows_logical_disk_size_bytes`,
  `windows_logical_disk_requests_queued`, `windows_logical_disk_read_bytes_total`,
  `windows_logical_disk_write_bytes_total`

## SQL Server — `awaragi/prometheus-mssql-exporter`

The simplest widely-used option (single container, no query config needed). For multi-instance
or custom-query needs, `burningalchemist/sql_exporter` is more flexible but requires writing your
own collector YAML — treat its metric names as lower-confidence until you've verified them
against your own config.

```bash
docker run -d --restart=always -p 4000:4000 \
  -e SERVER=<sql-host> -e USERNAME=<ro-login> -e PASSWORD=<password> \
  --name prometheus-mssql-exporter awaragi/prometheus-mssql-exporter
```

The SQL login needs `VIEW SERVER STATE` and `VIEW ANY DEFINITION` (read-only). Metrics at
`http://<host>:4000/metrics`.

### Verified metrics

| Metric                                    | Meaning                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `mssql_up`                                | 1 if the exporter can reach SQL Server                                      |
| `mssql_page_life_expectancy`              | Seconds a page stays in buffer pool (health signal — low = memory pressure) |
| `mssql_batch_requests`                    | Batch requests since restart (counter — `rate()` for /sec)                  |
| `mssql_deadlocks`                         | Deadlocks since restart (counter)                                           |
| `mssql_connections`                       | Connections, labeled by database/state                                      |
| `mssql_client_connections`                | Connections labeled by client/database                                      |
| `mssql_database_filesize`                 | File size in KB, labeled by database/file/type (`type="LOG"` = log file)    |
| `mssql_log_growths`                       | Count of log-file auto-growth events since restart                          |
| `mssql_memory_utilization_percentage`     | SQL Server memory utilization                                               |
| `mssql_user_errors`                       | User errors since restart                                                   |
| `mssql_io_stall` / `mssql_io_stall_total` | I/O wait time (ms)                                                          |

**Buffer cache hit ratio has no ready-made metric** in this exporter (or in `sql_exporter`'s
common set) — it's exposed by `windows_exporter`'s own separate `mssql` collector as two raw
counters, `windows_mssql_bufman_buffer_cache_hits` / `windows_mssql_bufman_buffer_cache_lookups`,
and computed via PromQL (see below). **Blocked processes / lock waits has no dedicated metric**
in `awaragi/prometheus-mssql-exporter` either — `mssql_deadlocks` and `mssql_io_stall` are the
closest built-in proxies; a true blocking metric needs a custom `sys.dm_os_waiting_tasks` query
via `sql_exporter`, which is out of scope for the quick-start path. Don't invent a metric name for
either — verify against your own `/metrics` output first.

### Example PromQL (verified metric names)

```promql
# Page life expectancy dropping below 300s — memory pressure
mssql_page_life_expectancy < 300

# Batch requests/sec over the last 5 minutes
rate(mssql_batch_requests[5m])

# Deadlocks in the last 5 minutes
rate(mssql_deadlocks[5m]) > 0

# Buffer cache hit ratio (requires windows_exporter's mssql collector, not awaragi's)
windows_mssql_bufman_buffer_cache_hits / windows_mssql_bufman_buffer_cache_lookups * 100 < 90

# Log file size (KB) for a given database, alert on a fixed ceiling
mssql_database_filesize{database="MyApp", type="LOG"} > 5000000
```

### SuperKuma monitor examples

The `prometheus` monitor type is UP when `value <conditionOperator> expectedValue` is TRUE — give
the operator for the **healthy** side, not the alert side (see
[monitor-mapping.md](monitor-mapping.md#deep-host-metrics-via-prometheus-cpuramdisk-io-sql-server)
for the full explanation and a field-verified example of getting this backwards).

```jsonc
// Page life expectancy — UP while >= 300s (DOWN below 300s = memory pressure)
{ "type": "prometheus", "name": "sql01 — PLE", "url": "http://prometheus:9090",
  "promql": "mssql_page_life_expectancy{instance=\"sql01:4000\"}",
  "conditionOperator": ">=", "expectedValue": "300" }

// Deadlocks in the last 5 minutes — UP while none occurred (DOWN if any did)
{ "type": "prometheus", "name": "sql01 — deadlocks", "url": "http://prometheus:9090",
  "promql": "rate(mssql_deadlocks{instance=\"sql01:4000\"}[5m])",
  "conditionOperator": "<=", "expectedValue": "0" }
```

Always scope the query to one instance (`{instance="host:port"}`) so it resolves to a single
number — a monitor can't evaluate a multi-series result.

**Feeding InfluxDB instead of Prometheus?** (pfSense's Telegraf package, other network gear that
speaks Telegraf natively) — see [pfsense-telegraf.md](pfsense-telegraf.md); SuperKuma's own
`compose.yaml` already bundles the InfluxDB container for this, no separate stack needed.

## Network gotchas that hit both the Prometheus and InfluxDB paths

### A container-networked Prometheus/InfluxDB can't reach a target only routable via a custom host route

If SuperKuma's host needed a manually-added route to reach a target (e.g. a p2p/VPN-only
network segment reachable only via a specific gateway, added with `ip route add ... via
<gateway>` or a netplan `routes:` stanza), a Prometheus/Telegraf-consumer container on the
**default Docker bridge network does not inherit that route** — it has its own network
namespace with only the compose network's routing table. Symptom: the host can `curl`/`ping`
the target fine, but the containerized scraper reports `dial tcp ...: connect: no route to
host` or similar for the exact same address. Fix: run that specific container with
`network_mode: host` (shares the host's full routing table, including the manual route) instead
of the compose bridge network — verified fixing a Prometheus container's inability to scrape a
`windows_exporter` across a p2p VPN segment on the same host that already had a working manual
route to it.

### Docker's default bridge subnet can silently collide with a real network

If the SuperKuma host also needs a route into `172.17.0.0/16` (Docker's default bridge subnet)
for something else — a client's separate p2p/VPN network happens to use `172.17.0.0/24`, for
example — the kernel prefers the **locally-connected** `docker0` route over your manual/gateway
route to that same range, even when `docker0` has no containers on it and is link-down. Every
packet to a real host in that range silently vanishes into the unused local bridge instead of
reaching the gateway. Symptom: `ping <target-in-that-range>` returns "Destination Host
Unreachable" **from your own docker0 interface's IP**, not a real timeout — that's the tell.
Fix without touching Docker's config: add a **host route** for the specific target that's more
specific than Docker's `/16` (Linux does longest-prefix-match, so a `/32` route wins):
`ip route add <target-ip>/32 via <real-gateway> dev eth0` — then persist it (e.g. a netplan
`routes:` stanza on Ubuntu/Debian) so it survives reboot. Don't reach for changing Docker's
`bip`/default-address-pools as the first fix; it's more invasive and unnecessary if only one or
two specific hosts need reaching.
