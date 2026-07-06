# Infrastructure discovery playbooks

Goal: build a read-only inventory of a site — for each asset capture **name, IP/hostname, role,
services/ports to watch, criticality** — then feed it into
[monitor-mapping.md](monitor-mapping.md).

**Rules:** use read-only queries and least-privilege credentials. Never write to the source
systems. Never store or echo passwords / API tokens / SNMP community strings — reference them
from the client's secret store or env. Confirm scope with the client before scanning.

## 0. Network baseline (start here)

Get the L3 layout, then sweep each subnet for live hosts and open ports.

```bash
# Live hosts on a subnet (adjust range)
nmap -sn 10.0.0.0/24 -oG - | awk '/Up$/{print $2}'
# Common service ports on live hosts (top ports, no scripts)
nmap -Pn -T4 --top-ports 100 10.0.0.0/24 -oX scan.xml
```

Cross-reference with DHCP leases (pfSense / Windows DHCP) and DNS (below) to name the hosts.

## 1. Active Directory / Domain Controller (Windows)

Read from any domain-joined host with RSAT / PowerShell AD module (a read-only account is enough).

```powershell
# Domain controllers
Get-ADDomainController -Filter * | Select HostName, IPv4Address, Site, IsGlobalCatalog
# Servers and workstations (computers)
Get-ADComputer -Filter * -Properties OperatingSystem, IPv4Address, LastLogonDate |
  Select Name, DNSHostName, IPv4Address, OperatingSystem
# DNS records (run on the DNS server / a DC)
Get-DnsServerResourceRecord -ZoneName "corp.local" -RRType A |
  Select HostName, @{n='IP';e={$_.RecordData.IPv4Address}}
```

If no Windows host is available, query LDAP read-only:
`ldapsearch -x -H ldap://dc.corp.local -b "dc=corp,dc=local" "(objectClass=computer)" name dNSHostName`.

**Monitor on each DC:** `ping`; `port` 389 (LDAP), 636 (LDAPS), 88 (Kerberos), 3268 (GC), 53
(DNS), 445; `dns` (resolve a known record). Flag DCs as **critical**.

## 2. Proxmox VE

Use a read-only API token (Datacenter → Permissions → API Tokens, role `PVEAuditor`).

```bash
# Cluster resources (nodes, VMs, containers, storage) — one call
curl -sk -H "Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET" \
  https://pve.corp.local:8006/api2/json/cluster/resources | jq '.data[] | {type,node,name,vmid,status,maxmem}'
# Nodes only
curl -sk -H "Authorization: PVEAPIToken=..." https://pve.corp.local:8006/api2/json/nodes | jq '.data[].node'
```

**Monitor:** each node → `ping`, `port` 8006 (web/API) + 22 (ssh); the cluster web UI via `http`
`https://pve:8006` with `ignoreTls: true`. Optionally per-guest `ping`/service checks. Node hosts
are **critical**.

## 3. Linux servers

SSH with a read-only user (or sudo -n for read-only commands). Inventory listening services:

```bash
ss -tlnp                                   # listening TCP ports + process
systemctl list-units --type=service --state=running --no-legend | awk '{print $1}'
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null    # if Docker present
command -v nginx apache2 postgres mysqld redis-server 2>/dev/null
```

**Monitor:** `ping`; `port` 22 (ssh) and each listening service port (80/443 → `http`, 5432 →
`postgres`, 3306 → `mysql`, 6379 → `redis`, …); Docker containers via the `docker` type (needs a
configured Docker host in SuperKuma).

## 4. pfSense (firewall/router)

Read from the web UI (Status → Dashboard/Interfaces/Gateways/Services) or export
`Diagnostics → Backup & Restore → config.xml` (read-only). Capture: WAN/LAN interfaces + IPs,
gateways, and enabled services (DNS Resolver, DHCP, OpenVPN/IPsec, HAProxy).

**Monitor:** WAN gateway IP → `ping` (upstream reachability); the web UI → `http`
`https://pfsense` (`ignoreTls: true`); DNS Resolver → `dns` on the LAN IP:53; VPN endpoint →
`port`; each downstream gateway → `ping`. The firewall itself is **critical**.

## 5. Managed switches (SNMP)

Enable **SNMP v2c (read-only community)** or v3 on the switch. Discover via SNMP + LLDP:

```bash
snmpwalk -v2c -c public SWITCH_IP sysDescr.0                      # model/firmware
snmpwalk -v2c -c public SWITCH_IP ifDescr                         # ports
snmpwalk -v2c -c public SWITCH_IP 1.0.8802.1.1.2.1.4.1.1.9        # LLDP neighbors (topology)
```

**Monitor:** `ping` + a `snmp` monitor (e.g. `sysUpTime` `1.3.6.1.2.1.1.3.0`, or per-port
`ifOperStatus`). Use LLDP neighbors to build the topology and confirm which uplinks matter.

## 6. UniFi (controller + devices)

Query the UniFi Controller API (self-hosted `:8443` or UDM). Use a read-only local admin.

```bash
# Login (cookie jar), then list devices and clients
curl -sk -c cj.txt -X POST https://unifi:8443/api/login \
  -H 'Content-Type: application/json' -d '{"username":"ro","password":"***"}'
curl -sk -b cj.txt https://unifi:8443/api/s/default/stat/device |
  jq '.data[] | {name, model, type, ip, mac, state}'    # APs, switches, gateways
curl -sk -b cj.txt https://unifi:8443/api/s/default/stat/sta | jq '.data | length'   # active clients
```

(UDM/UniFi OS: prefix paths with `/proxy/network` and login via `/api/auth/login`.)

**Monitor:** the controller → `http` `https://unifi:8443` (`ignoreTls: true`); each device
(gateway/switch/AP) → `ping` and, if enabled, `snmp`. Gateway/USG is **critical**.

## 7. VMware vSphere / ESXi

Read-only via `govc` or the vCenter REST API (a read-only role). Enable SNMP on ESXi for hardware
sensors.

```bash
export GOVC_URL='https://ro@vcenter.corp.local' GOVC_INSECURE=1
govc ls -l '/*/host/*'        # ESXi hosts
govc find / -type m           # VMs
# vCenter REST alternative
curl -sk -u 'ro:***' https://vcenter/rest/vcenter/host | jq '.value[] | {name,connection_state}'
```

**Monitor:** vCenter/ESXi UI → `http` `https://vcenter` (`ignoreTls: true`); each ESXi host →
`ping` + `port` 443/902; hardware temp/PSU/fans via `snmp` (ESXi exposes ENTITY-SENSOR-MIB — see
[monitor-mapping.md](monitor-mapping.md#environmental-snmp-temperature--psu--fans)). Hosts and
vCenter are **critical**.

## 8. Mikrotik (RouterOS)

Read via SSH, the RouterOS API (8728/8729, read-only user), or SNMP (RouterOS has rich OIDs).

```bash
snmpget -v2c -c public MT_IP 1.3.6.1.2.1.1.5.0            # sysName
snmpwalk -v2c -c public MT_IP 1.3.6.1.4.1.14988.1.1.3     # MIKROTIK-MIB health (temp/voltage)
ssh ro@MT_IP '/system resource print; /interface print; /ip address print'
```

**Monitor:** `ping`; winbox/UI → `port` 8291 or `http` 80/443; `snmp` on health (temp
`1.3.6.1.4.1.14988.1.1.3.10.0`, voltage `1.3.6.1.4.1.14988.1.1.3.8.0`) + uptime. Edge routers are
**critical**.

## 9. TrueNAS

Read via the REST API v2.0 (an API key, read-only) or SNMP.

```bash
curl -sk -H "Authorization: Bearer <API_KEY>" https://truenas/api/v2.0/pool |
  jq '.[] | {name, status, healthy}'
curl -sk -H "Authorization: Bearer <API_KEY>" https://truenas/api/v2.0/service |
  jq '.[] | select(.state=="RUNNING") | .service'
```

**Monitor:** `ping`; UI → `http` `https://truenas` (`ignoreTls: true`); the shares in use → `port`
445 (SMB), 2049 (NFS), 3260 (iSCSI); `snmp` for pool/disk health + temperature. Storage is
**critical** (data at risk).

## 10. IP cameras / NVR

Cameras speak ONVIF (HTTP) + RTSP; the NVR aggregates them. Discover by port-scanning the camera
VLAN.

```bash
nmap -Pn -p 80,443,554,8000,37777,34567 <camera-subnet> -oG -   # http(s), rtsp, common NVR ports
```

**Monitor:** the NVR → `ping` + `http` UI + `port` 554 (RTSP); a few key cameras → `ping` (and
`port` 554 for stream reachability). Don't create dozens of near-identical camera checks — cover
the NVR + critical cameras. NVR is **high**, individual cameras usually **normal**.

## 11. Generic routers / other network gear

`ping` for reachability; `snmp` if a read community is available; `http`/`https` for the admin UI
(as a reachability check, not to log in). Use nmap output (step 0) to spot management ports.

## Output

Produce a table the human can approve, e.g.:

| name    | ip        | role             | site | criticality | monitors                         |
| ------- | --------- | ---------------- | ---- | ----------- | -------------------------------- |
| dc01    | 10.0.0.10 | AD DC / DNS      | HQ   | critical    | ping, port:389, port:636, dns:53 |
| pve01   | 10.0.0.20 | Proxmox node     | HQ   | critical    | ping, http:8006, port:22         |
| pfsense | 10.0.0.1  | firewall         | HQ   | critical    | ping(wan-gw), http:443, dns:53   |
| sw-core | 10.0.0.2  | core switch      | HQ   | high        | ping, snmp:sysUpTime             |
| unifi   | 10.0.0.5  | UniFi controller | HQ   | high        | http:8443                        |
