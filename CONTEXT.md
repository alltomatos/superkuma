# CONTEXT — Uptime Kuma (linguagem de domínio)

> Glossário e modelo de domínio do projeto. Use estes termos (não sinônimos) em issues, refactors, testes e ADRs.
> Decisões de arquitetura em [`docs/adr/`](docs/adr). Regras de dev em [`CLAUDE.md`](CLAUDE.md).

Uptime Kuma é uma aplicação self-hosted de **monitoramento de disponibilidade**. O núcleo bate periodicamente em alvos, registra o resultado, agrega estatísticas e notifica em mudanças de estado.

---

## Subdomínios (bounded contexts)

| Subdomínio | Responsabilidade | Código |
|---|---|---|
| **Monitoring** | Definir e executar verificações | `server/model/monitor.js`, `server/monitor-types/` |
| **Uptime Statistics** | Agregar heartbeats em métricas | `server/uptime-calculator.js`, tabelas `stat_*` |
| **Notifications** | Entregar alertas em canais | `server/notification.js`, `server/notification-providers/` |
| **Status Pages** | Exposição pública de status | `server/model/status_page.js`, `server/routers/` |
| **Maintenance** | Janelas de manutenção agendadas | `server/model/maintenance.js` |
| **Access & Config** | Usuários, sessão, chaves, ajustes | `server/auth.js`, `server/2fa.js`, `server/settings.js` |

---

## Glossário (linguagem ubíqua)

- **Monitor** — alvo monitorado + sua configuração (tipo, intervalo, retries, alvo). Pertence a um **usuário** (`user_id`).
- **Monitor Type** — estratégia de verificação (http, ping, dns, tcp, postgres, mqtt, grpc, …). Cada tipo é um plugin (`MonitorType.check()`).
- **Check / Beat** — uma execução de verificação de um monitor.
- **Heartbeat** — o resultado de um check. Tem **status**: `UP` (1), `DOWN` (0), `PENDING` (2), `MAINTENANCE` (3).
- **Important Beat** — heartbeat que representa **mudança de estado** (dispara notificação e entra no log de eventos).
- **Retry** — tentativa após falha. O monitor só vira `DOWN` após `maxretries` falhas consecutivas; no meio fica `PENDING`.
- **Group / Parent** — monitor do tipo `group` que agrega monitores-filhos (hierarquia).
- **Uptime Calculator** — agregador em memória que mantém janelas móveis e persiste em `stat_*`.
- **Stat bucket** — bucket de estatística por granularidade: **minutely** (24h), **hourly** (30d), **daily** (365d).
- **Notification** — configuração de um canal. **Notification Provider** — implementação do canal (Discord, Slack, e-mail, …), plugin com `send()`.
- **Template** — corpo de mensagem renderizado via **LiquidJS** com variáveis do monitor/heartbeat.
- **Status Page** — página pública (por **slug**) que expõe monitores marcados como públicos. Pode ter **Incidents**.
- **Badge** — SVG público de status/uptime/ping/cert de um monitor.
- **Maintenance** — janela agendada (cron) durante a qual monitores afetados ficam em `MAINTENANCE`.
- **API Key** — credencial `uk<ID>_<secret>` para endpoints de API (hash bcrypt no DB).
- **Push monitor** — monitor que recebe heartbeats externos via `POST /api/push/:pushToken`.

---

## Invariantes / regras

1. Todo heartbeat tem exatamente um status do conjunto `{UP, DOWN, PENDING, MAINTENANCE}`.
2. Monitores são **escopados por usuário** — acesso sempre valida `user_id = socket.userID`.
3. `DOWN` só após `maxretries` falhas consecutivas (senão `PENDING`).
4. Janelas de uptime: minutely=24h, hourly=30d, daily=365d.
5. Notificação dispara em **Important Beat** (mudança de estado), não em todo beat.
6. Handlers de socket protegidos exigem `checkLogin(socket)`; páginas públicas/badges/push são intencionalmente sem auth.

---

## Persistência

- ORM runtime: **redbean-node** (`R.find`, `R.dispense`, `R.exec`). Migrations: **Knex** (`db/knex_migrations/`).
- Engines: SQLite (default), MariaDB, MySQL, Postgres.
- ⚠️ Credenciais de monitor/notificação e o JWT secret ficam **em texto plano** no DB — trade-off conhecido; ver [ADR-0007](docs/adr/0007-defer-secret-encryption.md).

---

## Federação (Master-Agent) — em planejamento

> Feature nova; design em [ADR-0008](docs/adr/0008-master-agent-federation.md) + [PRD](docs/prd/master-agent.md).

- **Instância** — uma instalação do Uptime Kuma. Tem um **papel (role)**: `standalone` (default), `agent`, ou `master`.
- **Agent** — instância no cliente que monitora local e encaminha status ao Master.
- **Master** — instância central (do provedor) que agrega o status de N Agents; pode também monitorar local (**híbrido**).
- **`instance_id`** — identificador único de uma instância Agent perante o Master.
- **Remote Instance** — no Master, o registro de um Agent conhecido (`remote_instance`).
- **Monitor remoto** — no Master, um `monitor` com `remote_instance_id` preenchido (NULL = monitor local), alimentado externamente como um monitor `push`.
- **Keepalive de instância** — sinal de vida do Agent; seu silêncio = "agente caiu" (distinto de "serviço caiu").

### Histórico de métricas (Master) — [ADR-0009](docs/adr/0009-master-long-term-metrics-history.md)

- **Retenção em camadas** — cada nível de dado tem sua política: `heartbeat` (curto) < `stat_minutely` (24h) < `stat_hourly` (30d) < `stat_daily` < `stat_monthly` (longo).
- **`stat_monthly`** — novo tier de agregação para histórico multi-ano barato (SLA).
- **Relatório de SLA por cliente** — uptime/latência de longo prazo por `remote_instance` (join `stat_* → monitor → remote_instance`).
- No Master, **MariaDB é recomendado** (SQLite só para standalone pequeno).
