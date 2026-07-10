# Asset → monitor mapping

How to turn each discovered asset/service into `create_monitor` calls. Defaults: `interval` 60s,
`retryInterval` 60s, `maxretries` 2, attach the site notification via `notificationIds`, and set
`parent` to the site/rack group.

## Service → monitor type

| Discovered service                             | Monitor type                                               | Key fields                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Host reachability (any device)                 | `ping`                                                     | `hostname`                                                                                                                            |
| Web app / admin UI (HTTP/S)                    | `http`                                                     | `url`; `acceptedStatusCodes: ["200-299"]`; `ignoreTls: true` for self-signed; `expiryNotification: true` on public TLS                |
| Page must contain text                         | `keyword`                                                  | `url`, `keyword` (or `invertKeyword: true`)                                                                                           |
| JSON/health endpoint                           | `json-query`                                               | `url`, `jsonPath`, `expectedValue`                                                                                                    |
| Generic TCP service (SSH/RDP/LDAP/SMTP/VPN)    | `port`                                                     | `hostname`, `port`                                                                                                                    |
| DNS server                                     | `dns`                                                      | `hostname` = the **record to resolve** (e.g. a domain), `dns_resolve_server` = the DNS server IP, `port: 53`, `dns_resolve_type: "A"` |
| Databases (PostgreSQL/MySQL/MSSQL/Mongo/Redis) | `postgres`/`mysql`/`sqlserver`/`mongodb`/`redis` or `port` | connection string, or just `port` for reachability                                                                                    |
| SNMP device (switch/router/UPS)                | `snmp`                                                     | `hostname`, `snmpVersion`, `snmpOid`, community                                                                                       |
| Docker container                               | `docker`                                                   | container name + a configured Docker host in SuperKuma                                                                                |
| Push-only host (agent behind NAT)              | `push`                                                     | host runs a cron that pings the generated push URL                                                                                    |
| Host metrics (CPU/RAM/disk I/O, SQL Server)    | `prometheus`                                               | `url` (Prometheus), `promql`, `conditionOperator`, `expectedValue`, `metricUnit` (`%`/`GB`/…) — see below                             |
| Host metrics via Telegraf → InfluxDB (pfSense) | `influxdb`                                                 | `url` (InfluxDB), `influxdbDatabase`, `influxql`, `conditionOperator`, `expectedValue`, `metricUnit` — see [pfsense-telegraf.md](pfsense-telegraf.md) |
| Certificate expiry                             | `http`                                                     | `expiryNotification: true` (fires ahead of expiry)                                                                                    |

## Per-platform recipe

- **Domain controller:** `ping`; `port` 389/636/88/3268; `dns` with `dns_resolve_server` set to
  the DC's IP and `hostname` set to a known domain record (e.g. the AD domain name itself) to
  confirm the DC actually resolves it. Tag `role:dc`, `criticality:critical`.
- **Proxmox node:** `ping`; `http` `https://node:8006` (`ignoreTls: true`); `port` 22. Guests →
  `ping` (+ service ports for important VMs).
- **Linux server:** `ping`; `port` 22; one monitor per listening service (80/443 → `http`, DB
  ports → db/`port`). Docker apps → `docker`.
- **pfSense:** `ping` the WAN gateway (upstream health); `http` the web UI; `dns` the resolver;
  `port` VPN endpoints. Deep metrics (CPU/load/memory/packet-loss/gateway-RTT) come from the pfSense
  Telegraf package → InfluxDB → `influxdb` monitors: see
  [pfsense-telegraf.md](pfsense-telegraf.md).
- **Managed switch:** `ping` + `snmp` (`sysUpTime` `1.3.6.1.2.1.1.3.0`, or per-uplink
  `ifOperStatus`). Tag `role:switch`.
- **UniFi:** `http` `https://controller:8443` (`ignoreTls: true`); `ping` each device; `snmp` if
  enabled on the gateway/switches.
- **VMware ESXi / vCenter:** `ping`; `http` the UI; `port` 443/902; `snmp` host hardware
  (temp/PSU/fans) via ENTITY-SENSOR-MIB. Hosts **critical**.
- **Mikrotik:** `ping`; `port` 8291 (winbox) or `http`; `snmp` temp/voltage + uptime.
- **TrueNAS:** `ping`; `http` UI; `port` per share (445/2049/3260); `snmp` pool/disk health + temp.
  **critical**.
- **Cameras / NVR:** NVR → `ping` + `http` + `port` 554; key cameras → `ping`/`port` 554. NVR
  **high**, cameras **normal**.
- **Router / other:** `ping`; `snmp` if a read community exists; `http` admin UI for reachability.

## Environmental SNMP (temperature / PSU / fans)

SuperKuma's `snmp` monitor fetches one OID and compares it with `jsonPath` / `jsonPathOperator` /
`expectedValue` (for a scalar value use `jsonPath: "$"`). Sensor **indices vary per model** —
always `snmpwalk` the sensor subtree first to find the exact index, then monitor that OID.

- **Cross-vendor (preferred) — ENTITY-SENSOR-MIB:** discover with
  `snmpwalk -v2c -c RO IP 1.3.6.1.2.1.99.1.1.1` and label via `entPhysicalName`
  (`1.3.6.1.2.1.47.1.1.1.1.7`). Value: `entPhySensorValue 1.3.6.1.2.1.99.1.1.1.4.<idx>`; status
  (1 = ok): `entPhySensorOperStatus 1.3.6.1.2.1.99.1.1.1.5.<idx>`. Supported by modern **Cisco**,
  **HP/Aruba (AOS-CX/ProVision)** and **VMware ESXi**.
- **Cisco (classic CISCO-ENVMON-MIB):** temp value `1.3.6.1.4.1.9.9.13.1.3.1.3.<idx>`, temp state
  `…13.1.3.1.6.<idx>`; PSU state `ciscoEnvMonSupplyState 1.3.6.1.4.1.9.9.13.1.5.1.3.<idx>`; fan
  state `1.3.6.1.4.1.9.9.13.1.4.1.3.<idx>` (state 1 = normal). Walk `1.3.6.1.4.1.9.9.13` for indices.
- **HP / Aruba:** prefer ENTITY-SENSOR-MIB above. Legacy ProCurve: walk
  `1.3.6.1.4.1.11.2.14.11.1.2.6` (fault-finder/sensors) for temp/fan/PSU.
- **Ubiquiti (UniFi / EdgeSwitch / UISP):** SNMP is limited and model-dependent — UniFi switches
  often expose only MIB-II (uptime/interfaces), not temperature. Enterprise OIDs live under
  `1.3.6.1.4.1.41112`; `snmpwalk` it to see what the model returns. Fall back to `ping` +
  `sysUpTime` + `ifOperStatus` when no sensor OID exists.
- **Mikrotik (MIKROTIK-MIB):** temp `1.3.6.1.4.1.14988.1.1.3.10.0`, voltage
  `1.3.6.1.4.1.14988.1.1.3.8.0`. Walk `1.3.6.1.4.1.14988.1.1.3` for the model's health OIDs.

```jsonc
// PSU state on a Cisco switch (index found via snmpwalk) — UP while it reports 1 (normal)
{ "type": "snmp", "name": "sw-core — PSU1", "hostname": "10.0.0.2", "snmpVersion": "2c",
  "snmpOid": "1.3.6.1.4.1.9.9.13.1.5.1.3.1", "jsonPath": "$", "jsonPathOperator": "==", "expectedValue": "1" }

// Temperature threshold via ENTITY-SENSOR-MIB — UP while sensor < 60
{ "type": "snmp", "name": "esxi01 — inlet temp", "hostname": "10.0.0.30", "snmpVersion": "2c",
  "snmpOid": "1.3.6.1.2.1.99.1.1.1.4.<idx>", "jsonPath": "$", "jsonPathOperator": "<", "expectedValue": "60" }
```

## Deep host metrics via Prometheus (CPU/RAM/disk I/O, SQL Server)

SuperKuma is an uptime/status monitor, but the **`prometheus`** monitor type lets it alert on the
rich metrics a Prometheus already collects — it runs a PromQL instant query and compares the
returned number against a threshold. Point it at a Prometheus fed by `node_exporter` (Linux),
`windows_exporter` (Windows) and `mssql_exporter` (SQL Server); SuperKuma queries the Prometheus
HTTP API, so **no agent is needed on each host**.

Fields: `url` = Prometheus base URL, `promql` = the query, `conditionOperator` + `expectedValue` =
the threshold. **The monitor logic is `value <conditionOperator> expectedValue` → UP when TRUE,
DOWN when FALSE** (same `evaluateJsonQuery` mechanism the `snmp`/`json-query` types use — see
`server/monitor-types/prometheus.js`). This trips people up because it's the inverse of how you'd
naturally phrase an alert threshold: to express "DOWN when CPU > 90%" you must give the operator
for the **healthy** side, `<=` `90`, not `>` `90` — verified the hard way in the field (Tecbrita,
2026-07-07: created 4 monitors with the intuitive-but-inverted operator, all reported DOWN despite
healthy hosts, e.g. `19% free RAM < 10` evaluating false → DOWN, when 19% free is fine). Always
phrase the table below as "UP while", not "DOWN when". Optional `bearerToken`; `ignoreTls` for
self-signed TLS. The query must return a single number — add label filters like
`{instance="10.0.0.10:9100"}` so it resolves to one series per monitor.

Set **`metricUnit`** to the unit the query returns (`%`, `GB`, `MB`, `s`, …). It's display-only —
it doesn't change the query — but the monitor page uses it to label the value and to render a
**radial gauge + trend chart**: **`%` locks both to a fixed 0-100 scale**, any other unit
auto-scales toward the threshold. Always set `%` for the percentage queries below so CPU/RAM read
on a proper 0-100 gauge; use `GB`/`MB` for byte-derived queries.

| Metric               | PromQL                                                                           | UP while   | Unit |
| -------------------- | -------------------------------------------------------------------------------- | ---------- | ---- |
| CPU % (Linux)        | `100 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100`      | `<=` `90`  | `%`  |
| CPU % (Windows)      | `100 - avg by(instance)(rate(windows_cpu_time_total{mode="idle"}[5m]))*100`      | `<=` `90`  | `%`  |
| Free RAM % (Linux)   | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100`              | `>=` `10`  | `%`  |
| Free RAM % (Windows) | `windows_memory_physical_free_bytes / windows_memory_physical_total_bytes * 100` | `>=` `10`  | `%`  |
| Free disk %          | `node_filesystem_avail_bytes / node_filesystem_size_bytes * 100`                 | `>=` `10`  | `%`  |
| Disk I/O saturation  | `rate(node_disk_io_time_seconds_total[5m])`                                      | `<=` `0.9` | —    |
| SQL Server up        | `mssql_up`                                                                       | `==` `1`   | —    |
| SQL Server deadlocks | `rate(mssql_deadlocks[5m])`                                                      | `<=` `0`   | —    |

```jsonc
// CPU alert via Prometheus — UP while CPU <= 90% (i.e. DOWN once it exceeds 90%)
{ "type": "prometheus", "name": "node01 — CPU", "url": "http://prometheus:9090",
  "promql": "100 - avg by(instance)(rate(node_cpu_seconds_total{mode=\"idle\"}[5m]))*100",
  "conditionOperator": "<=", "expectedValue": "90", "metricUnit": "%", "parent": <hqGroupId> }
```

**The metric UI is not Prometheus-only.** Any monitor whose check yields a *number* against a
threshold — `prometheus`, and numeric `snmp` / `json-query` — renders the same value + gauge +
trend + min/max on its detail page (and a gauge on public status pages), with the uptime-%
boxes hidden. So the SNMP temperature/PSU and json-query numeric examples above also benefit from
a `metricUnit` (e.g. `°C`, `GB`). A `snmp`/`json-query` monitor that compares a *string* keeps the
normal uptime display. Set `metricUnit` on those too when the compared value is numeric.

## Example payloads

```jsonc
// Domain controller — LDAPS reachability, critical
{ "type": "port", "name": "dc01 — LDAPS", "hostname": "10.0.0.10", "port": 636,
  "interval": 60, "maxretries": 2, "parent": <hqGroupId>, "notificationIds": [<notifId>] }

// Domain controller — DNS resolution check. NOTE: hostname is the RECORD being
// resolved, dns_resolve_server is the DNS SERVER being queried — do not swap
// them (verified against server/monitor-types/dns.js; a wrong assumption here
// was caught during a real deployment).
{ "type": "dns", "name": "dc01 — DNS", "hostname": "corp.local", "dns_resolve_server": "10.0.0.10",
  "port": 53, "dns_resolve_type": "A", "parent": <hqGroupId> }

// Proxmox node web UI (self-signed TLS)
{ "type": "http", "name": "pve01 — web", "url": "https://10.0.0.20:8006",
  "ignoreTls": true, "acceptedStatusCodes": ["200-299","400-499"], "parent": <hqGroupId> }

// pfSense upstream gateway health
{ "type": "ping", "name": "pfsense — WAN gw", "hostname": "<wan-gateway-ip>",
  "interval": 30, "maxretries": 3, "parent": <hqGroupId> }

// Core switch via SNMP (uptime)
{ "type": "snmp", "name": "sw-core — uptime", "hostname": "10.0.0.2",
  "snmpVersion": "2c", "snmpOid": "1.3.6.1.2.1.1.3.0", "parent": <hqGroupId> }

// Public site with cert-expiry alerting
{ "type": "http", "name": "portal", "url": "https://portal.corp.com",
  "keyword": "Sign in", "expiryNotification": true, "notificationIds": [<notifId>] }
```

## Tags, grouping & status page

- **Group per site/rack:** `create_monitor {type:"group", name:"HQ"}` → use its `monitorID` as the
  `parent` of every HQ monitor.
- **Tags:** `site:<name>`, `role:<dc|proxmox|switch|firewall|ap|server>`,
  `criticality:<critical|high|normal>`. `create_tag` once, then `add_monitor_tag` per monitor.
- **Notifications:** create/reuse one per client channel (e.g. Telegram or SMTP) and pass its id
  to every monitor; consider `isDefault: true` so new monitors auto-attach.
- **Status page:** `create_status_page {title, slug}`, then surface the critical monitors so the
  client has an at-a-glance view; use `post_incident` during outages.
- **Maintenance:** wrap planned work with `create_maintenance` (single window) so alerts are
  suppressed.

## Intervals & noise

- Reachability (`ping`) of critical gear: 30–60s, `maxretries` 3.
- Web/app checks: 60s. Certificate/expiry: the default long interval is fine.
- Avoid over-monitoring: one reachability + the few services that matter per host beats dozens of
  redundant checks. Start small, expand after the baseline is stable.
