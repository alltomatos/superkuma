<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="SuperKuma Logo" />
</div>

# SuperKuma

SuperKuma is an easy-to-use self-hosted monitoring tool, with built-in Master-Agent federation, multi-tenant Teams/RBAC, and a built-in **MCP server** that lets AI agents configure and manage your monitoring — across multiple instances and teams.

<a target="_blank" href="https://github.com/alltomatos/superkuma"><img src="https://img.shields.io/github/stars/alltomatos/superkuma?style=flat" /></a> <a target="_blank" href="https://github.com/alltomatos/superkuma"><img src="https://img.shields.io/github/last-commit/alltomatos/superkuma" /></a>

<img src="./docs/images/dashboard.png" width="700" alt="SuperKuma Dashboard Screenshot" />

## ⭐ Features

- ~30 monitor types: HTTP(s) / Keyword / JSON Query / Browser Engine, TCP Port, Ping, DNS, Docker Container, System Service, Push, gRPC(s), MQTT, RabbitMQ, Kafka Producer, SNMP, SMTP, Websocket, Globalping, Steam / GameDig game servers, and direct database checks for MySQL/MariaDB, PostgreSQL, MongoDB, Redis, MSSQL, Oracle and Radius — [full list](server/monitor-types/)
- Fancy, Reactive, Fast UI/UX
- Notifications via Telegram, Discord, Gotify, Slack, Pushover, Email (SMTP), and [90+ notification services, click here for the full list](https://github.com/alltomatos/superkuma/tree/main/src/components/notifications)
- 20-second intervals
- [Multi Languages](https://github.com/alltomatos/superkuma/tree/main/src/lang)
- Multiple status pages
- Map status pages to specific domains
- Ping chart
- Certificate info
- Proxy support
- 2FA support
- Master-Agent federation for multi-instance monitoring
- Long-term monthly metrics history
- Query **Prometheus** with PromQL to alert on host metrics — CPU / RAM / disk I/O, SQL Server, and anything an exporter exposes
- Multi-tenant **Teams** with granular **role-based access control (RBAC)**
- Built-in **MCP server** — let an AI agent add/edit monitors, notifications, tags, status pages and maintenance ([docs](server/mcp/README.md))

## 📸 Screenshots

<table>
  <tr>
    <td><img src="./docs/images/monitor-detail.png" width="380" alt="Monitor detail with response-time chart" /><br />Monitor detail with response-time chart</td>
    <td><img src="./docs/images/teams-settings.png" width="380" alt="Teams / RBAC settings" /><br />Teams / RBAC settings</td>
  </tr>
  <tr>
    <td colspan="2"><img src="./docs/images/status-page.png" width="780" alt="Public status page" /><br />Public status page</td>
  </tr>
</table>

## 🔧 How to Install

### 🐳 Docker Compose

Ships with a dedicated **MariaDB** container out of the box — no database setup step, no manual
configuration:

```bash
mkdir superkuma
cd superkuma
curl -o compose.yaml https://raw.githubusercontent.com/alltomatos/superkuma/main/compose.yaml
echo "SUPERKUMA_DB_PASSWORD=$(openssl rand -hex 24)" > .env
docker compose up -d
```

SuperKuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001) — go straight to creating your admin account, the database is already configured.

> [!WARNING]
> File Systems like **NFS** (Network File System) are **NOT** supported. Please map to a local directory or volume.

> [!NOTE]
> Prefer SQLite for a small, single-file standalone install? Use the "Docker Command" or "Non-Docker" install path below and pick SQLite in the setup wizard — it's still fully supported, just no longer the Docker Compose default.

### 🐳 Docker Command

```bash
docker run -d --restart=always -p 3001:3001 -v superkuma:/app/data --name superkuma ronaldodavi/superkuma:2
```

SuperKuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001).

If you want to limit exposure to localhost only:

```bash
docker run ... -p 127.0.0.1:3001:3001 ...
```

### 🛠️ Build the image yourself

The repo ships a **self-contained `Dockerfile`** (repo root) that builds everything in one
step — no pre-published base images required:

```bash
git clone https://github.com/alltomatos/superkuma.git
cd superkuma
docker build -t superkuma .
docker run -d --restart=always -p 3001:3001 -v superkuma:/app/data --name superkuma superkuma
```

> The published `ronaldodavi/superkuma` image is built from this same `Dockerfile` and
> pushed by the [Release Docker workflow](.github/workflows/release-docker.yml) on each
> version tag. It's currently published for **linux/amd64 only**; on arm64 (e.g. Raspberry Pi)
> build it yourself with the command above instead of pulling the published image.

### 💪🏻 Non-Docker

Requirements:

- Platform
  - ✅ Major Linux distros such as Debian, Ubuntu, Fedora and ArchLinux etc.
  - ✅ Windows 10 (x64), Windows Server 2016 (x64) or higher
  - ❌ FreeBSD / OpenBSD / NetBSD
  - ❌ Replit / Heroku
- [Node.js](https://nodejs.org/en/download/) >= 20.4
- [Git](https://git-scm.com/downloads)
- [pm2](https://pm2.keymetrics.io/) - For running SuperKuma in the background

```bash
git clone https://github.com/alltomatos/superkuma.git
cd superkuma
npm run setup

# Option 1. Try it
node server/server.js

# (Recommended) Option 2. Run in the background using PM2
# Install PM2 if you don't have it:
npm install pm2 -g && pm2 install pm2-logrotate

# Start Server
pm2 start server/server.js --name superkuma
```

SuperKuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001).

More useful PM2 Commands

```bash
# If you want to see the current console output
pm2 monit

# If you want to add it to startup
pm2 startup && pm2 save
```

## 🤖 AI Agents (MCP)

SuperKuma ships a built-in [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, so an AI assistant can inspect and configure your instance — create/edit monitors, manage notifications, tags, status pages and maintenance windows — through a safe, gated set of tools.

- **Read-only by default.** Writes and deletes are opt-in via environment variables; deletes also require a per-call confirmation.
- **Authenticates with an API key** (no password), scoped by the same Teams/RBAC as the dashboard.
- **Two transports.** Run it locally over stdio, or enable the built-in **remote HTTP endpoint** (`/mcp`) so a client connects to your instance directly (e.g. via `mcp-remote`).

See [`server/mcp/README.md`](server/mcp/README.md) for setup, and [ADR-0011](docs/adr/0011-mcp-server-for-agent-configuration.md) for the design.

Using [Claude Code](https://claude.com/claude-code)? The [`superkuma-monitoring` skill](.claude/skills/superkuma-monitoring) drives the MCP server to discover a site's infrastructure and set up monitors, tags and status pages for you, and includes a playbook for standing up a new instance.

## 🆕 What's Next?

Requests/issues are assigned to upcoming milestones.

<https://github.com/alltomatos/superkuma/milestones>

## Credits

SuperKuma began as a fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) — an excellent self-hosted monitoring tool built by Louis Lam and its contributors — and builds on that foundation. It has since grown into its own project, extending the original with [Master-Agent federation](docs/adr/0008-master-agent-federation.md) for multi-instance monitoring, long-term metrics history, PromQL-based host-metrics alerting, multi-tenant [Teams/RBAC](docs/adr/0010-teams-rbac-multitenancy.md), and a built-in [MCP server](server/mcp/README.md) for AI agents.

If you find SuperKuma useful, consider giving it a ⭐ — and if you'd like to support the project it's built on, [Uptime Kuma](https://github.com/louislam/uptime-kuma) deserves one too.

## License

SuperKuma is [MIT licensed](LICENSE).

## 🗣️ Discussion / Ask for Help

- [GitHub Issues](https://github.com/alltomatos/superkuma/issues)

## Contributions

### Create Pull Requests

Pull requests are awesome.
To keep reviews fast and effective, please make sure you've [read our pull request guidelines](https://github.com/alltomatos/superkuma/blob/main/CONTRIBUTING.md#can-i-create-a-pull-request-for-superkuma). New to the codebase? [`CONTEXT.md`](CONTEXT.md) has a domain glossary and map of the main areas.

### Releases / Changelog

See what changed in each version: <https://github.com/alltomatos/superkuma/releases>

### Test Beta Version

Check out the latest beta release here: <https://github.com/alltomatos/superkuma/releases>

### Bug Reports / Feature Requests

If you want to report a bug or request a new feature, feel free to open a [new issue](https://github.com/alltomatos/superkuma/issues).

### Translations

If you want to translate SuperKuma into your language, please visit [the translations readme](https://github.com/alltomatos/superkuma/blob/main/src/lang/README.md).

### Spelling & Grammar

Feel free to correct the grammar in the documentation or code.
