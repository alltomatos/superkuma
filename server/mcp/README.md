# SuperKuma MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets an
AI agent inspect and configure a running SuperKuma instance — **monitors, notifications,
tags, status pages, maintenance windows and team dashboards** — through a safe, gated set
of **39 tools**.

It runs in two ways: as a local **stdio** process, or as a **remote HTTP endpoint** hosted
by the instance itself. Design rationale: [ADR-0011](../../docs/adr/0011-mcp-server-for-agent-configuration.md).

## How it works

The MCP tools authenticate with an **API key** (via the `loginByApiKey` event) and drive
the same Socket.io handlers the web dashboard uses. They add **no new authorization
surface**: every operation is still gated by SuperKuma's own `checkLogin` + RBAC checks,
scoped to the API key's user/role/team.

There are two ways to run it:

- **stdio** (local) — the agent host spawns `node server/mcp/index.js` as a child process:

  ```
  AI agent  ──stdio (MCP)──▶  superkuma-mcp  ──socket.io (API key)──▶  SuperKuma server
  ```

- **Remote HTTP** (hosted by the instance) — the running SuperKuma instance itself exposes
  an MCP endpoint at `/mcp`; the client connects remotely (see below):

  ```
  AI client  ──HTTP (MCP + Bearer key)──▶  SuperKuma instance  /mcp
  ```

## Setup

1. **Create an API key** in SuperKuma: _Settings → API Keys → Add API Key_. Copy the
   generated key (format `uk<id>_<secret>` — it is shown only once).
   - The key is tied to the user that created it; the MCP acts as that user.
   - Prefer a dedicated, least-privilege user for automation.

2. **Configure the MCP server** in your agent host (e.g. Claude Desktop
   `claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "superkuma": {
         "command": "node",
         "args": ["D:/dev/uptime-kuma/server/mcp/index.js"],
         "env": {
           "SUPERKUMA_URL": "http://localhost:3001",
           "SUPERKUMA_API_KEY": "uk1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
           "SUPERKUMA_ALLOW_MUTATIONS": "true",
           "SUPERKUMA_ALLOW_DELETE": "false"
         }
       }
     }
   }
   ```

   Or run it directly for a smoke test:

   ```bash
   SUPERKUMA_URL=http://localhost:3001 \
   SUPERKUMA_API_KEY=uk1_xxxx \
   npm run mcp-server
   ```

## Remote HTTP endpoint (hosted by the instance)

Instead of spawning the stdio server, the running SuperKuma instance can expose the MCP
tools directly at `https://<instance>/mcp`, so any MCP client connects **remotely** with
the API key in the `Authorization` header.

1. **Enable it** on the SuperKuma server by setting the environment variable
   `SUPERKUMA_MCP_HTTP_ENABLED=true` (it is **off by default**). The same
   `SUPERKUMA_ALLOW_MUTATIONS` / `SUPERKUMA_ALLOW_DELETE` gates apply, read from the
   server's environment.

2. **Connect** with the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge,
   passing the API key as a Bearer header:

   ```json
   {
     "mcpServers": {
       "superkuma": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "https://your-instance.example.com/mcp",
           "--header",
           "Authorization:${AUTH_HEADER}"
         ],
         "env": {
           "AUTH_HEADER": "Bearer uk1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

   Quick check with curl (an MCP `initialize` handshake):

   ```bash
   curl -sN https://your-instance.example.com/mcp \
     -H "Authorization: Bearer uk1_xxxx" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
   ```

> **Note on native connectors.** Claude's _custom connector_ dialog authenticates via OAuth
> and does not support a static Bearer header, so use the `mcp-remote` bridge above for
> API-key auth. Put the endpoint behind TLS and a trusted reverse proxy — it is a
> mutation-capable surface gated only by the API key.

## Environment variables

| Variable                     | Required | Default                 | Description                                                                                     |
| ---------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `SUPERKUMA_URL`              | no       | `http://localhost:3001` | URL of the running SuperKuma server (`http(s)://` or `ws(s)://`).                               |
| `SUPERKUMA_API_KEY`          | **yes**  | —                       | API key (`uk<id>_<secret>`) used to authenticate.                                               |
| `SUPERKUMA_ALLOW_MUTATIONS`  | no       | `false`                 | Set `true` to enable all write tools (create/update/pause/resume/post/test across every area).  |
| `SUPERKUMA_ALLOW_DELETE`     | no       | `false`                 | Set `true` to enable the destructive `delete_*` tools.                                          |
| `SUPERKUMA_INSECURE_TLS`     | no       | `false`                 | Set `true` to skip TLS verification (self-signed certs; best effort).                           |
| `SUPERKUMA_REQUEST_TIMEOUT`  | no       | `10000`                 | Per-request timeout in milliseconds.                                                            |
| `SUPERKUMA_MCP_HTTP_ENABLED` | no       | `false`                 | **Server-side.** Set `true` on the SuperKuma instance to serve the remote `/mcp` HTTP endpoint. |

> `SUPERKUMA_API_KEY` / `SUPERKUMA_URL` apply to the **stdio** server. For the remote HTTP
> endpoint the key comes from each request's `Authorization` header, and `SUPERKUMA_MCP_HTTP_ENABLED`
> plus the `ALLOW_*` gates are read from the **SuperKuma server's** environment.

## Safety model

- **Read-only by default.** Without `SUPERKUMA_ALLOW_MUTATIONS=true`, only the read tools
  (every `list_*` / `get_*` plus `get_info`) are registered; write and delete tools are not
  even exposed.
- **Deletes are double-gated.** The `delete_*` tools require both `SUPERKUMA_ALLOW_DELETE=true`
  _and_ a per-call `confirm: true`; without `confirm` they return a dry-run description instead
  of deleting.
- **Secrets stay hidden.** `list_notifications` returns only id/name/type — never the provider
  credentials stored in the notification config.
- **Least privilege.** The MCP inherits exactly what the API key's user/role/team can do; the
  key never inherits the owner's super-admin (ADR-0010 R2).

## Tools

**Monitors & observability**

| Tool                | Kind        | Purpose                                           |
| ------------------- | ----------- | ------------------------------------------------- |
| `get_info`          | read        | Connection status + capabilities + server info.   |
| `list_monitors`     | read        | Compact summaries of all visible monitors.        |
| `get_monitor`       | read        | Full config of one monitor.                       |
| `get_monitor_beats` | read        | Recent heartbeats for a monitor.                  |
| `create_monitor`    | write       | Create a monitor (only `type` + `name` required). |
| `update_monitor`    | write       | Update a monitor (fetch-merge-save).              |
| `pause_monitor`     | write       | Pause a monitor.                                  |
| `resume_monitor`    | write       | Resume a monitor.                                 |
| `delete_monitor`    | destructive | Delete a monitor (needs delete gate + `confirm`). |

**Notifications**

| Tool                  | Kind        | Purpose                                                |
| --------------------- | ----------- | ------------------------------------------------------ |
| `list_notifications`  | read        | Summaries (id, name, type) — never returns secrets.    |
| `create_notification` | write       | Create a notification (`type` + provider `config`).    |
| `update_notification` | write       | Update a notification (fetch-merge-save).              |
| `test_notification`   | write       | Send a test message without saving (validates creds).  |
| `delete_notification` | destructive | Delete a notification (needs delete gate + `confirm`). |

**Tags**

| Tool                 | Kind        | Purpose                                       |
| -------------------- | ----------- | --------------------------------------------- |
| `list_tags`          | read        | All tags.                                     |
| `create_tag`         | write       | Create a tag (name + color).                  |
| `update_tag`         | write       | Rename a tag / change color.                  |
| `add_monitor_tag`    | write       | Attach a tag to a monitor (optional value).   |
| `remove_monitor_tag` | write       | Detach a tag from a monitor.                  |
| `delete_tag`         | destructive | Delete a tag (needs delete gate + `confirm`). |

**Status pages**

| Tool                 | Kind        | Purpose                                                             |
| -------------------- | ----------- | ------------------------------------------------------------------- |
| `list_status_pages`  | read        | Summaries (id, slug, title, published).                             |
| `get_status_page`    | read        | Full config of one status page by slug.                             |
| `create_status_page` | write       | Create a status page (title + slug).                                |
| `save_status_page`   | write       | Set title/description and organize monitors into groups (sections). |
| `post_incident`      | write       | Post/pin an incident on a status page.                              |
| `resolve_incident`   | write       | Unpin/resolve the pinned incident.                                  |
| `delete_status_page` | destructive | Delete a status page (needs delete gate + `confirm`).               |

**Maintenance**

| Tool                 | Kind        | Purpose                                                   |
| -------------------- | ----------- | --------------------------------------------------------- |
| `list_maintenances`  | read        | Summaries (id, title, strategy, active, status).          |
| `get_maintenance`    | read        | Full config of one maintenance window.                    |
| `create_maintenance` | write       | Create a maintenance (defaults to the `manual` strategy). |
| `update_maintenance` | write       | Update a maintenance (fetch-merge-save).                  |
| `pause_maintenance`  | write       | Pause a maintenance window.                               |
| `resume_maintenance` | write       | Resume a maintenance window.                              |
| `delete_maintenance` | destructive | Delete a maintenance (needs delete gate + `confirm`).     |

**Team dashboards**

| Tool               | Kind        | Purpose                                                                         |
| ------------------ | ----------- | ------------------------------------------------------------------------------- |
| `list_dashboards`  | read        | Summaries (id, title, teamId, widgetCount) visible to the API key.              |
| `get_dashboard`    | read        | A dashboard's full, ordered widget list by id.                                  |
| `create_dashboard` | write       | Create an empty dashboard in the API key's own team.                            |
| `save_dashboard`   | write       | Replace a dashboard's widget list (status_tile / metric_gauge / group_summary). |
| `delete_dashboard` | destructive | Delete a dashboard (needs delete gate + `confirm`).                             |

Dashboards (ADR-0016) are the RMM-style operational view SuperKuma is building toward: an
internal, always team-scoped composition of widgets over existing monitors, distinct from
the public Status Page. `team_id` is always resolved server-side from the API key's own
team — never accepted from the agent, so an agent can only build dashboards for the team
its key belongs to. Ask an agent to "create a dashboard for team X's firewalls" and it can
do the whole flow itself: `list_monitors` (with `teamId`) to find the right monitors,
`create_dashboard`, then `save_dashboard` to lay out the widgets.

All read/write/destructive tools honour the same gating: read-only by default,
writes need `SUPERKUMA_ALLOW_MUTATIONS=true`, deletes need `SUPERKUMA_ALLOW_DELETE=true`
plus a per-call `confirm: true`.
