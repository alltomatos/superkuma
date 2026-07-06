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

```powershell
# Default collectors
msiexec /i windows_exporter-<ver>-amd64.msi
# Or pick collectors explicitly (adds the mssql collector for SQL Server metrics — see below)
msiexec /i windows_exporter-<ver>-amd64.msi --% ENABLED_COLLECTORS="cpu,memory,logical_disk,net,mssql" ADDLOCAL=FirewallException
```

Installs and starts as a Windows service automatically. Metrics at
`http://<host>:9182/metrics`. Verified names:

- CPU: `windows_cpu_time_total` (filter `mode="idle"`)
- Memory: `windows_os_physical_memory_free_bytes`, `windows_cs_physical_memory_bytes` (total)
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

```jsonc
// Page life expectancy — DOWN below 300s (memory pressure)
{ "type": "prometheus", "name": "sql01 — PLE", "url": "http://prometheus:9090",
  "promql": "mssql_page_life_expectancy{instance=\"sql01:4000\"}",
  "conditionOperator": "<", "expectedValue": "300" }

// Deadlocks in the last 5 minutes — DOWN if any occurred
{ "type": "prometheus", "name": "sql01 — deadlocks", "url": "http://prometheus:9090",
  "promql": "rate(mssql_deadlocks{instance=\"sql01:4000\"}[5m])",
  "conditionOperator": ">", "expectedValue": "0" }
```

Always scope the query to one instance (`{instance="host:port"}`) so it resolves to a single
number — a monitor can't evaluate a multi-series result.
