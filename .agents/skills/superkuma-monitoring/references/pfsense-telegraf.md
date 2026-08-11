# pfSense (and other Telegraf hosts) via InfluxDB

How to turn the rich metrics a **pfSense firewall** already reports through the
[pfSense Telegraf package](https://docs.netgate.com/pfsense/en/latest/packages/telegraf.html)
into SuperKuma alerts, using the **`influxdb`** monitor type. This is the InfluxDB dual of the
`prometheus` path ([prometheus-exporters.md](prometheus-exporters.md)): where `prometheus` queries a
Prometheus that _scrapes_, `influxdb` queries an InfluxDB that agents _push_ to. Use it when the
site already runs Telegraf → InfluxDB (the pfSense package's default output) and you don't want to
stand up Prometheus alongside.

> **SuperKuma is not a TSDB.** It doesn't store the pfSense time series — it runs one InfluxQL query
> per check and turns the returned number into UP/DOWN + a value gauge/trend. Keep the long-term
> dashboards in Grafana; use SuperKuma for the _thresholds that should page someone_.

> **Two separate services, do not conflate them.** SuperKuma's own data (monitors, users, heartbeats)
> lives in MariaDB/SQLite — that never changes. InfluxDB is a _second_, independent service that only
> exists so Telegraf has somewhere to push metrics _to_, and so SuperKuma's `influxdb` monitor has
> somewhere to query _from_. SuperKuma never writes to it and doesn't need it to boot.

## 0. SuperKuma's `compose.yaml` already bundles InfluxDB

SuperKuma's public `compose.yaml` ships an `influxdb` (v1.8) container alongside MariaDB, with a
`telegraf` database and an admin user auto-created on first boot from `SUPERKUMA_INFLUXDB_PASSWORD`
in `.env` (see the README quick-start). Its port `8086` is published on the Docker host, since
Telegraf typically runs on a _different_ machine (the pfSense box itself), not inside the Compose
network.

- **From pfSense:** point the Telegraf package at `http://<docker-host-ip>:8086`, database
  `telegraf`, username `superkuma`, password = your `SUPERKUMA_INFLUXDB_PASSWORD`.
- **From SuperKuma's `influxdb` monitor:** use the **internal** Docker network address,
  `http://influxdb:8086` (the service name resolves inside the Compose network — no need to go
  through the published host port), same database/credentials.

If you're not using the `influxdb` monitor type at all, you can ignore this container entirely —
it costs an idle process and a small volume, nothing else.

## 1. pfSense side (Services → Telegraf)

1. **System → Package Manager** → install **Telegraf**.
2. **Services → Telegraf → General Options:**
   - **Enable** Telegraf.
   - **Update Interval:** `10` (default) — the InfluxQL `WHERE time > now() - Nm` guards below assume
     data at least every ~60s.
   - **Telegraf Output:** select **InfluxDB**.
   - **InfluxDB Server:** `http://<docker-host-ip>:8086` (the bundled InfluxDB's published port — see
     §0). For a standalone InfluxDB elsewhere, its own URL instead.
   - **InfluxDB Database:** `telegraf` (already auto-created by the bundled container).
   - **InfluxDB Username / Password:** `superkuma` / your `SUPERKUMA_INFLUXDB_PASSWORD` — the bundled
     container has auth **enabled by default**, this is not optional.
   - **Enable Ping Monitor** and set **Ping Host 1..4** to the WAN gateway(s) / upstreams you want
     latency + packet-loss on — this feeds the `ping` measurement (the "Packet Loss" / "RTTsd" /
     "ICMP ECHO" panels).
3. Point **SuperKuma's `influxdb` monitor at the same InfluxDB + database**, using the internal
   address `http://influxdb:8086` (§0) and the same credentials via `basicAuthUser`/`basicAuthPass`
   (HTTP Basic — InfluxDB v1's recommended auth, see §3). SuperKuma only reads (`GET /query`); it
   never writes.

The package emits standard Telegraf input plugins: `cpu`, `system` (load), `mem`, `swap`, `disk`,
`net` (per-interface bytes/packets), plus `ping` from the Ping Monitor. Every point is tagged with
`host` = the pfSense hostname (FQDN unless **Short Hostname** is checked).

## 2. Discover the exact names first (do not guess)

Measurement/field/tag names drift with the package and Telegraf version. Before wiring a monitor,
list what your InfluxDB actually has — same discipline as verifying an exporter's `/metrics`:

```sql
-- via the influx CLI on the InfluxDB host, or POST to /query
SHOW MEASUREMENTS
SHOW FIELD KEYS FROM "cpu"
SHOW TAG VALUES FROM "system" WITH KEY = "host"
SHOW TAG VALUES FROM "ping" WITH KEY = "url"
SELECT last("load1") FROM "system" WHERE "host" = 'pfsense.localdomain'
```

## 3. The `influxdb` monitor — fields & the UP-while gotcha

`type: "influxdb"` with: `url` (InfluxDB base URL), `influxdbDatabase` (the `db`), `influxql` (a
query returning **one number**), `conditionOperator` + `expectedValue` (the threshold), `metricUnit`
(`%`, `ms`, `Mbps`, …), `ignoreTls` for self-signed HTTPS.

**Auth: use `basicAuthUser`/`basicAuthPass`.** The bundled InfluxDB (§0) has auth enabled by default,
username `superkuma`. HTTP Basic is InfluxDB v1's recommended, unambiguous auth method. A `bearerToken`
field also exists (sent as `Authorization: Token <value>`), but InfluxDB v1's "Token" scheme actually
expects the literal `username:password` string — not an opaque secret like v2 — so it's easy to misuse;
stick to `basicAuthUser`/`basicAuthPass` unless you have a specific reason not to.

**The monitor is UP when `value <conditionOperator> expectedValue` is TRUE** — give the operator for
the **healthy** side, not the alert side. This is the same `evaluateJsonQuery` inversion that trips
people up on `prometheus`/`snmp` (see
[monitor-mapping.md](monitor-mapping.md#deep-host-metrics-via-prometheus-cpuramdisk-io-sql-server),
field-verified the hard way): to page on "CPU busy > 80%", monitor `usage_idle` and phrase it as
**UP while `>=` `20`**, never `<= 80` on the busy side.

**Bound queries in time so a dead Telegraf reads as DOWN.** `last("load1")` alone returns the last
point _forever_, even if Telegraf stopped an hour ago. Add `AND time > now() - 2m`: if nothing
recent arrived, the series is empty → the monitor goes DOWN ("no data") — a free dead-man's switch on
the pfSense agent itself.

## 4. Verified recipes (standard Telegraf measurements)

Replace `pfsense.localdomain` with your `host` tag and the ping `url` with your gateway IP. Names
below are the Telegraf plugin defaults — still run the `SHOW` queries above to confirm on your box.

| Signal (dashboard panel)               | InfluxQL                                                                                                            | UP while  | Unit |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| Load (1m) — "LoadAvg"                  | `SELECT last("load1") FROM "system" WHERE "host"='pfsense.localdomain' AND time > now()-2m`                         | `<=` `4`  | —    |
| CPU busy — "CPU"                       | `SELECT last("usage_idle") FROM "cpu" WHERE "cpu"='cpu-total' AND "host"='pfsense.localdomain' AND time > now()-2m` | `>=` `20` | `%`  |
| Memory used — "Memory"                 | `SELECT last("used_percent") FROM "mem" WHERE "host"='pfsense.localdomain' AND time > now()-2m`                     | `<=` `90` | `%`  |
| Swap used                              | `SELECT last("used_percent") FROM "swap" WHERE "host"='pfsense.localdomain' AND time > now()-2m`                    | `<=` `50` | `%`  |
| Packet loss to gateway — "Packet Loss" | `SELECT last("percent_packet_loss") FROM "ping" WHERE "url"='1.1.1.1' AND time > now()-2m`                          | `<=` `20` | `%`  |
| Gateway RTT — "ICMP ECHO"              | `SELECT last("average_response_ms") FROM "ping" WHERE "url"='1.1.1.1' AND time > now()-2m`                          | `<=` `80` | `ms` |
| Gateway jitter — "RTTsd"               | `SELECT last("standard_deviation_ms") FROM "ping" WHERE "url"='1.1.1.1' AND time > now()-2m`                        | `<=` `30` | `ms` |
| Root filesystem used                   | `SELECT last("used_percent") FROM "disk" WHERE "path"='/' AND "host"='pfsense.localdomain' AND time > now()-2m`     | `<=` `90` | `%`  |

**Per-interface throughput** ("WAN - Mbps") and **firewall states** are chartable but package/version
specific. Throughput is a derivative of the `net` counters —
`SELECT derivative(mean("bytes_recv"), 1s) * 8 FROM "net" WHERE "interface"='igb0' AND time > now()-2m GROUP BY time(1m)`
returns bits/s (set `metricUnit: "bps"`); a raw `bytes_recv` counter is not a useful threshold on its
own. **Firewall state count** has no standard Telegraf measurement — `SHOW MEASUREMENTS` on your
InfluxDB and confirm what the package exposes before wiring it; don't assume a name.

## 5. Example `create_monitor` payloads (MCP)

```jsonc
// pfSense — CPU busy. UP while >=20% idle (DOWN once busy passes 80%).
// url/basicAuthUser/basicAuthPass are the same for every influxdb monitor against the bundled
// container -- only the name/influxql/threshold change per signal.
{ "type": "influxdb", "name": "pfsense — CPU", "url": "http://influxdb:8086",
  "influxdbDatabase": "telegraf", "basicAuthUser": "superkuma", "basicAuthPass": "<SUPERKUMA_INFLUXDB_PASSWORD>",
  "influxql": "SELECT last(\"usage_idle\") FROM \"cpu\" WHERE \"cpu\"='cpu-total' AND \"host\"='pfsense.localdomain' AND time > now()-2m",
  "conditionOperator": ">=", "expectedValue": "20", "metricUnit": "%", "parent": <siteGroupId>,
  "notificationIds": [<notifId>] }

// pfSense — packet loss to the WAN gateway. UP while <=20% lost.
{ "type": "influxdb", "name": "pfsense — WAN gw loss", "url": "http://influxdb:8086",
  "influxdbDatabase": "telegraf", "basicAuthUser": "superkuma", "basicAuthPass": "<SUPERKUMA_INFLUXDB_PASSWORD>",
  "influxql": "SELECT last(\"percent_packet_loss\") FROM \"ping\" WHERE \"url\"='1.1.1.1' AND time > now()-2m",
  "conditionOperator": "<=", "expectedValue": "20", "metricUnit": "%", "parent": <siteGroupId> }

// pfSense — memory. UP while <=90% used.
{ "type": "influxdb", "name": "pfsense — memory", "url": "http://influxdb:8086",
  "influxdbDatabase": "telegraf", "basicAuthUser": "superkuma", "basicAuthPass": "<SUPERKUMA_INFLUXDB_PASSWORD>",
  "influxql": "SELECT last(\"used_percent\") FROM \"mem\" WHERE \"host\"='pfsense.localdomain' AND time > now()-2m",
  "conditionOperator": "<=", "expectedValue": "90", "metricUnit": "%", "parent": <siteGroupId> }
```

Set **`metricUnit`** on every one — it turns the threshold check into a value gauge + trend chart on
the monitor page (and a gauge on public status pages); `%` locks the gauge to 0-100, other units
auto-scale. These numeric monitors also feed the anomaly detector and severity/notification routing
just like any other metric monitor. Keep the black-box pfSense checks too (`ping` the WAN gateway,
`http` the web UI, `dns` the resolver — see [monitor-mapping.md](monitor-mapping.md#per-platform-recipe));
the Telegraf metrics are the white-box layer on top, not a replacement.

## When NOT to use this

- No InfluxDB, but you _do_ run Prometheus → use `prometheus` ([prometheus-exporters.md](prometheus-exporters.md)).
- You only need "is the firewall up / is the WAN gateway reachable" → plain `ping`/`http`/`dns`/`port`
  black-box monitors are simpler and need no agent.
- InfluxDB **v2/v3 only** (Flux, org/bucket/token) → the `influxdb` type targets the v1 `/query`
  InfluxQL API (what the pfSense package emits). v2's InfluxQL compatibility endpoint works if you've
  mapped a DBRP; native Flux is a future enhancement.
