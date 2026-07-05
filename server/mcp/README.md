# SuperKuma MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets an
AI agent inspect and configure a running SuperKuma instance — list and read monitors,
create/update/pause/resume/delete monitors, and read tags — through a safe, gated
tool surface.

## How it works

The MCP server is a **pure Socket.io client** of a running SuperKuma server. It
authenticates with an **API key** (via the `loginByApiKey` event) and then drives the
same Socket.io handlers the web dashboard uses. It adds **no new authorization surface**:
every operation is still gated by SuperKuma's own `checkLogin` + RBAC checks, scoped to
the API key's user/role/team.

```
AI agent  ──stdio (MCP)──▶  superkuma-mcp  ──socket.io (API key)──▶  SuperKuma server
```

## Setup

1. **Create an API key** in SuperKuma: *Settings → API Keys → Add API Key*. Copy the
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
         "args": [ "D:/dev/uptime-kuma/server/mcp/index.js" ],
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

## Environment variables

| Variable                    | Required | Default                 | Description                                                            |
| --------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------- |
| `SUPERKUMA_URL`             | no       | `http://localhost:3001` | URL of the running SuperKuma server (`http(s)://` or `ws(s)://`).       |
| `SUPERKUMA_API_KEY`         | **yes**  | —                       | API key (`uk<id>_<secret>`) used to authenticate.                      |
| `SUPERKUMA_ALLOW_MUTATIONS` | no       | `false`                 | Set `true` to enable write tools (create/update/pause/resume).         |
| `SUPERKUMA_ALLOW_DELETE`    | no       | `false`                 | Set `true` to enable destructive tools (`delete_monitor`).             |
| `SUPERKUMA_INSECURE_TLS`    | no       | `false`                 | Set `true` to skip TLS verification (self-signed certs; best effort).  |
| `SUPERKUMA_REQUEST_TIMEOUT` | no       | `10000`                 | Per-request timeout in milliseconds.                                   |

## Safety model

- **Read-only by default.** Without `SUPERKUMA_ALLOW_MUTATIONS=true`, only read tools
  (`list_monitors`, `get_monitor`, `get_monitor_beats`, `list_tags`, `get_info`) are
  registered.
- **Deletes are double-gated.** `delete_monitor` requires both `SUPERKUMA_ALLOW_DELETE=true`
  *and* a per-call `confirm: true`; otherwise it returns a dry-run description.
- **Least privilege.** The MCP inherits exactly what the API key's user/role/team can do.

## Tools

**Monitors & observability**

| Tool                | Kind        | Purpose                                             |
| ------------------- | ----------- | --------------------------------------------------- |
| `get_info`          | read        | Connection status + capabilities + server info.     |
| `list_monitors`     | read        | Compact summaries of all visible monitors.          |
| `get_monitor`       | read        | Full config of one monitor.                         |
| `get_monitor_beats` | read        | Recent heartbeats for a monitor.                    |
| `create_monitor`    | write       | Create a monitor (only `type` + `name` required).   |
| `update_monitor`    | write       | Update a monitor (fetch-merge-save).                |
| `pause_monitor`     | write       | Pause a monitor.                                    |
| `resume_monitor`    | write       | Resume a monitor.                                   |
| `delete_monitor`    | destructive | Delete a monitor (needs delete gate + `confirm`).   |

**Notifications**

| Tool                   | Kind        | Purpose                                                  |
| ---------------------- | ----------- | -------------------------------------------------------- |
| `list_notifications`   | read        | Summaries (id, name, type) — never returns secrets.      |
| `create_notification`  | write       | Create a notification (`type` + provider `config`).      |
| `update_notification`  | write       | Update a notification (fetch-merge-save).                |
| `test_notification`    | write       | Send a test message without saving (validates creds).    |
| `delete_notification`  | destructive | Delete a notification (needs delete gate + `confirm`).   |

**Tags**

| Tool                 | Kind        | Purpose                                          |
| -------------------- | ----------- | ------------------------------------------------ |
| `list_tags`          | read        | All tags.                                        |
| `create_tag`         | write       | Create a tag (name + color).                     |
| `update_tag`         | write       | Rename a tag / change color.                     |
| `add_monitor_tag`    | write       | Attach a tag to a monitor (optional value).      |
| `remove_monitor_tag` | write       | Detach a tag from a monitor.                     |
| `delete_tag`         | destructive | Delete a tag (needs delete gate + `confirm`).    |

Status-page and maintenance tools are planned for the next phase (P3).
