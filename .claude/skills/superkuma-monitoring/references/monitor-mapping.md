# Asset → monitor mapping

How to turn each discovered asset/service into `create_monitor` calls. Defaults: `interval` 60s,
`retryInterval` 60s, `maxretries` 2, attach the site notification via `notificationIds`, and set
`parent` to the site/rack group.

## Service → monitor type

| Discovered service                             | Monitor type                                               | Key fields                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Host reachability (any device)                 | `ping`                                                     | `hostname`                                                                                                             |
| Web app / admin UI (HTTP/S)                    | `http`                                                     | `url`; `acceptedStatusCodes: ["200-299"]`; `ignoreTls: true` for self-signed; `expiryNotification: true` on public TLS |
| Page must contain text                         | `keyword`                                                  | `url`, `keyword` (or `invertKeyword: true`)                                                                            |
| JSON/health endpoint                           | `json-query`                                               | `url`, `jsonPath`, `expectedValue`                                                                                     |
| Generic TCP service (SSH/RDP/LDAP/SMTP/VPN)    | `port`                                                     | `hostname`, `port`                                                                                                     |
| DNS server                                     | `dns`                                                      | `hostname`, `port: 53`, `dns_resolve_type: "A"`, a known record in `keyword`/`url`                                     |
| Databases (PostgreSQL/MySQL/MSSQL/Mongo/Redis) | `postgres`/`mysql`/`sqlserver`/`mongodb`/`redis` or `port` | connection string, or just `port` for reachability                                                                     |
| SNMP device (switch/router/UPS)                | `snmp`                                                     | `hostname`, `snmpVersion`, `snmpOid`, community                                                                        |
| Docker container                               | `docker`                                                   | container name + a configured Docker host in SuperKuma                                                                 |
| Push-only host (agent behind NAT)              | `push`                                                     | host runs a cron that pings the generated push URL                                                                     |
| Certificate expiry                             | `http`                                                     | `expiryNotification: true` (fires ahead of expiry)                                                                     |

## Per-platform recipe

- **Domain controller:** `ping`; `port` 389/636/88/3268; `dns` resolving a known A record. Tag
  `role:dc`, `criticality:critical`.
- **Proxmox node:** `ping`; `http` `https://node:8006` (`ignoreTls: true`); `port` 22. Guests →
  `ping` (+ service ports for important VMs).
- **Linux server:** `ping`; `port` 22; one monitor per listening service (80/443 → `http`, DB
  ports → db/`port`). Docker apps → `docker`.
- **pfSense:** `ping` the WAN gateway (upstream health); `http` the web UI; `dns` the resolver;
  `port` VPN endpoints.
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

## Example payloads

```jsonc
// Domain controller — LDAPS reachability, critical
{ "type": "port", "name": "dc01 — LDAPS", "hostname": "10.0.0.10", "port": 636,
  "interval": 60, "maxretries": 2, "parent": <hqGroupId>, "notificationIds": [<notifId>] }

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
