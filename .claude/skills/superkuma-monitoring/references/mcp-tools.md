# SuperKuma MCP — connection & tools

The SuperKuma MCP exposes the same operations as the dashboard, scoped by the API key's
user/role (Teams/RBAC — see [SKILL.md](../SKILL.md#teams-multi-tenant-visibility) for what that
means in practice; team scoping is always enforced, with no toggle to turn it off).
Full server docs: `server/mcp/README.md` and `docs/adr/0011-*`.

## Connecting

Two transports; both authenticate with an API key.

**Remote HTTP (recommended for a running instance)** — enable it on the server with
`SUPERKUMA_MCP_HTTP_ENABLED=true`, then connect with the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "superkuma": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<instance>/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer uk1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

**Local stdio** — spawn `node server/mcp/index.js` with `SUPERKUMA_URL` + `SUPERKUMA_API_KEY`.

Create the key in the dashboard: _Settings → API Keys → Add API Key_ → copy the `uk<id>_<secret>`
(shown once). Use a **dedicated, least-privilege user**; the agent acts as that user.

## Capability gates (server-side env)

- `SUPERKUMA_ALLOW_MUTATIONS=true` — enables write tools (create/update/pause/resume/post/test).
- `SUPERKUMA_ALLOW_DELETE=true` — enables `delete_*`; each still needs `confirm: true` per call.
- Without the gates, only read tools are registered. Read-only is the default.

## Tool catalog (34)

| Area          | Read                                                             | Write                                                                                 | Destructive           |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------- |
| Monitors      | `list_monitors`, `get_monitor`, `get_monitor_beats`, `get_info`¹ | `create_monitor`, `update_monitor`, `pause_monitor`, `resume_monitor`                 | `delete_monitor`      |
| Notifications | `list_notifications`                                             | `create_notification`, `update_notification`, `test_notification`                     | `delete_notification` |
| Tags          | `list_tags`                                                      | `create_tag`, `update_tag`, `add_monitor_tag`, `remove_monitor_tag`                   | `delete_tag`          |
| Status pages  | `list_status_pages`, `get_status_page`                           | `create_status_page`, `save_status_page`, `post_incident`, `resolve_incident`         | `delete_status_page`  |
| Maintenance   | `list_maintenances`, `get_maintenance`                           | `create_maintenance`, `update_maintenance`, `pause_maintenance`, `resume_maintenance` | `delete_maintenance`  |

¹ `get_info` also reports `team` (the single team this connection is scoped to: `{id, name, slug,
role, permissions}`, or `null` if none) and `teams` (same shape, as a list — for an API key this is
always that one team). Check this before bulk-creating, since team scoping is always enforced.

`update_*` tools fetch the current object and overlay your fields (fetch-merge-save); you only
pass what changes. `delete_*` is a dry-run unless `confirm: true`.

## Key payloads

**create_monitor** — only `type` + `name` are required; everything else defaults sensibly.
Common fields:

- `type` — `http`, `port`, `ping`, `dns`, `keyword`, `json-query`, `push`, `docker`, `group`,
  `snmp`, `prometheus`, `steam`, `mqtt`, `postgres`, `mysql`, `mongodb`, `redis`, `sqlserver`,
  `radius`, `real-browser`, `grpc-keyword`, `tailscale-ping`, `rabbitmq`.
- `prometheus` type: `url` (Prometheus base URL), `promql` (query returning one number),
  `conditionOperator` (`>`,`>=`,`<`,`<=`,`==`,`!=`,`contains`) + `expectedValue` (the threshold),
  optional `bearerToken` / `ignoreTls`. See [monitor-mapping.md](monitor-mapping.md#deep-host-metrics-via-prometheus-cpuramdisk-io-sql-server).
- `metricUnit` — display unit for a **metric monitor** (`prometheus`, and numeric `snmp` /
  `json-query`), e.g. `%`, `GB`, `MB`, `s`. Labels the value and drives the monitor page's
  gauge + trend chart. **`%` locks the gauge and chart to a fixed 0-100 scale**; any other unit
  auto-scales toward the threshold. It's display-only — set it to match what the query returns
  (e.g. a PromQL `…* 100` → `%`, a bytes-÷-1e9 query → `GB`). Prefer setting it (especially `%`)
  so CPU/RAM read on a proper 0-100 gauge instead of auto-scaling.
- `url` (http/keyword/json-query), `hostname` + `port` (port/dns/snmp/db types).
- `interval` (s, ≥20), `retryInterval`, `maxretries`, `upsideDown`.
- `keyword` + `invertKeyword` (keyword type); `acceptedStatusCodes` e.g. `["200-299"]` (http).
- `dns_resolve_type` + `dns_resolve_server` (dns); `snmpOid` + `snmpVersion` (snmp).
- `notificationIds` (array of ids), `parent` (group monitor id), `active`, `description`.
- `expiryNotification: true` on an https monitor → alert on TLS certificate expiry.

**create_notification** — `name`, `type` (provider, e.g. `telegram`, `slack`, `smtp`, `webhook`,
`ntfy`, `gotify`, `teams`), and `config` (provider fields, e.g. telegram: `telegramBotToken` +
`telegramChatID`). `isDefault: true` attaches to new monitors automatically.

**create_tag** — `name`, `color` (hex). Attach with `add_monitor_tag(tagId, monitorId, value?)`.

**create_status_page** — `title`, `slug` (a–z, 0–9, dashes). Then `save_status_page(slug, {title?,
description?, groups})` to organize its monitors into sections — `groups` is
`[{name, monitorIds: [...]}]` and **fully replaces** the current layout each call (pass every
group you want kept, in display order). Use `post_incident(slug, title, content, style)` for
incidents.

**create_maintenance** — `title`; `strategy` defaults to `manual` (toggle on/off). For a one-off
window use `strategy:"single"` + `startDateTime`/`endDateTime`.

## Patterns

- **Idempotency:** `list_monitors` / `list_tags` first; match by name/hostname; only create what's
  missing; `update_monitor` to change an existing one.
- **Grouping:** create a `type:"group"` monitor per site/rack, then set each child's `parent` to
  its id — the dashboard and status pages nest them.
- **Batching:** create in small batches, checking the ok/monitorID of each before continuing.
