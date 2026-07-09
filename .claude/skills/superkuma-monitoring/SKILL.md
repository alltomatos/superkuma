---
name: superkuma-monitoring
description: Deploy a new SuperKuma instance (Proxmox VM, Docker Compose + MariaDB), update/upgrade an already-deployed instance to a new version, and/or operate the SuperKuma MCP server to onboard a site's infrastructure into monitoring. Use when deploying SuperKuma to a client's infrastructure, rolling out a new SuperKuma release to an existing client instance, setting up or expanding SuperKuma monitoring, using the SuperKuma MCP tools, or discovering/inventorying infrastructure (Active Directory / domain controllers, Proxmox VE, VMware/ESXi, Linux servers, pfSense, Mikrotik, managed switches, UniFi, TrueNAS, IP cameras/NVR, routers) to turn assets into monitors.
---

# SuperKuma Monitoring

Set up and grow monitoring on a **SuperKuma** instance through its **MCP server**: discover a
site's infrastructure, then create the monitors, tags, notifications and status pages that watch
it.

## Prerequisites

- The SuperKuma instance has the HTTP MCP endpoint enabled (`SUPERKUMA_MCP_HTTP_ENABLED=true`)
  and you hold an **API key** (`uk<id>_<secret>`) from _Settings → API Keys_.
- Your MCP client is connected, e.g.
  `npx mcp-remote https://<instance>/mcp --header "Authorization:Bearer uk1_..."`.
- Network reach + **read-only** credentials for each system you will inventory.
- Connection details and the full tool catalog: [references/mcp-tools.md](references/mcp-tools.md).
- **No instance yet?** See [references/deployment-playbook.md](references/deployment-playbook.md)
  for standing one up on a client's own infrastructure (Proxmox VM, Docker Compose + MariaDB, and
  the concrete pitfalls hit doing this in the field) before continuing below.
- **Already have an instance and need to roll out a new version?** See
  [references/deployment-playbook.md](references/deployment-playbook.md#5-keeping-an-instance-up-to-date)
  (cutting a release, safely updating a running instance, testing unreleased code live).

## Quick start

1. `get_info` — confirm the connection (version, capabilities, monitor count).
2. `list_monitors` — see what already exists; never create a duplicate.
3. Writes are opt-in: the endpoint must run with `SUPERKUMA_ALLOW_MUTATIONS=true`; deletes also
   need `SUPERKUMA_ALLOW_DELETE=true` plus `confirm: true`.

## Onboarding workflow

Run this loop per site:

1. **Inventory** — discover hosts and services for each platform using
   [references/discovery-playbooks.md](references/discovery-playbooks.md) (Active Directory,
   Proxmox VE, VMware/ESXi, Linux, pfSense, Mikrotik, switches via SNMP, UniFi, TrueNAS,
   cameras/NVR, routers). For every asset capture: name, IP/hostname, role, the services/ports to
   watch, and criticality.
2. **Plan** — map each asset to monitor type(s) with
   [references/monitor-mapping.md](references/monitor-mapping.md). Decide tags (site,
   device-type, criticality) and grouping. **Present the plan and get the human's OK before any
   bulk creation.**
3. **Structure** — `create_tag` for site/type/criticality; create one `group` monitor per site or
   rack; `create_notification` (or reuse an existing one) and note its id.
4. **Create monitors** — `create_monitor` per asset/service, setting `parent` to the group and
   `notificationIds`. Start conservative: `interval` 60s, `maxretries` 2.
5. **Publish** — `create_status_page` and add the key monitors so the client sees status at a
   glance.
6. **Verify** — `list_monitors`, then `get_monitor_beats` on a few monitors to confirm they are
   actually checking.
7. **Deep metrics (optional)** — for CPU/RAM/disk I/O and SQL Server internals beyond
   up/down, set up Prometheus + exporters
   ([references/prometheus-exporters.md](references/prometheus-exporters.md), example stack in
   [assets/prometheus-stack/](assets/prometheus-stack/)) and add `prometheus`-type monitors
   ([references/monitor-mapping.md](references/monitor-mapping.md#deep-host-metrics-via-prometheus-cpuramdisk-io-sql-server)).
   Set `metricUnit` (`%`, `GB`, …) on these — and on any numeric `snmp` / `json-query` monitor —
   so the detail page shows a value gauge + trend chart (`%` gives a fixed 0-100 scale); it's the
   unit that turns a threshold check into a readable metric dial.

## Safety

- Read first (`list_monitors`, `get_monitor`), act second. Never recreate an existing monitor.
- Bulk-create in small batches; confirm with the human before large runs.
- `delete_*` returns a dry-run unless `confirm: true` — re-check the id first.
- Discovery uses **read-only** queries only. Never store, log or echo credentials or SNMP
  community strings; keep them in the client's secret store / env.

## Teams (multi-tenant visibility)

An instance can have multiple **Teams** (_Settings → Teams_, superadmin-only): create a team, add
users to it with a role (Owner/Admin/Editor/Viewer — Viewer is read-only, the others can create and
edit), and every monitor belongs to exactly one team (the creator's active team at the time it was
made). This is **dark-launched**: a `rbacEnforced` setting, off by default, gates whether it
actually restricts anything. While off, every logged-in user (and every MCP API key) sees every
monitor regardless of team — team membership exists but has no visible effect. Once an admin turns
enforcement on, each user/API key only sees their own team's resources (a superadmin still sees
everything).

For MCP specifically: an API key is scoped to exactly one team's role at creation time and never
inherits its owner's superadmin status, even if the owner is a superadmin. `create_monitor` always
lands the new monitor in that key's team; `get_info` reports which team a connection is scoped to
(`team`/`teams` fields) so you can confirm scope before bulk-creating. If enforcement is on and
`list_monitors`/`get_monitor` return fewer monitors than expected, the API key's team is probably
not the one you think it is — check `get_info` first, or ask the human to move the key/user into
the right team via _Settings → Teams_.
