# Example Prometheus stack (Docker)

A minimal Prometheus deploy to feed SuperKuma's `prometheus` monitor type, for an environment
that already runs Docker. Verified working: both targets `health: up`, real host metrics flowing
(`node_memory_MemAvailable_bytes` returned an actual value from the host in testing).

## Deploy

```bash
cd assets/prometheus-stack        # or copy docker-compose.yml + prometheus.yml elsewhere
# Edit prometheus.yml: uncomment/add your real exporter targets (windows_exporter, mssql
# exporter, other Linux hosts running node_exporter natively — see ../prometheus-exporters.md)
docker compose up -d
```

Prometheus is now at `http://<this-host>:9090`. The bundled `node-exporter` service gives you
this Docker host's own CPU/RAM/disk metrics immediately (no config needed) — add other hosts as
targets in `prometheus.yml`.

## Wire it into SuperKuma

In SuperKuma, create a monitor: type **Prometheus**, URL `http://<this-host>:9090`, then a PromQL
query + threshold — see [../prometheus-exporters.md](../prometheus-exporters.md) and
[../monitor-mapping.md](../monitor-mapping.md#deep-host-metrics-via-prometheus-cpuramdisk-io-sql-server)
for verified metric names and ready-to-use queries (CPU, RAM, disk, SQL Server).

## Notes

- `node-exporter` here mounts `/proc`, `/sys` and `/` read-only to read the **Docker host's**
  metrics (not just the container's), while staying on the compose network (reachable as
  `node-exporter:9100`) so `prometheus.yml` can address it by service name. Trade-off:
  network-interface metrics (`node_network_*`) reflect the container's network namespace, not the
  host's — for accurate host network stats, run `node_exporter` as a native systemd service
  instead (see `../prometheus-exporters.md`) and point `prometheus.yml` at the host's real IP.
- `windows_exporter` and the SQL Server exporter are **not** containers in this stack — they run
  on/near the Windows and SQL Server hosts you're monitoring. Install steps:
  `../prometheus-exporters.md`.
- Data persists in the `prometheus-data` named volume. This is a starting point, not a
  production Prometheus deploy (no auth, no TLS, no retention/alerting config) — harden before
  exposing it beyond a trusted network.
