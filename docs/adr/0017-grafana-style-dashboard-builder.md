# ADR-0017: Builder de dashboards estilo Grafana (evolui ADR-0016)

- **Status:** Implemented (Phase 1, 2026-07-12) — commits `70595ba5`..`a3f5babb` na branch `claude/superkuma-pfsense-telegraf-c4f669`. Verificado ao vivo (dev server real) + verificação adversarial (5 mutações, 4 pegas de cara, 1 gap real fechado). Fase 2 (fontes de dados/query direta) segue não iniciada.
- **Data:** 2026-07-12
- **Tier:** T3 (evolui schema de `dashboard`/`dashboard_widget` + **nova superfície pública** `/panel/:slug` + nova dependência frontend) — exige "Go" humano.
- **Relacionado:** [ADR-0016](0016-team-dashboards.md) (o conceito de dashboard por time que isto evolui), [ADR-0015](0015-otel-telemetry-receiver.md) / monitor-type `influxdb` (a telemetria que os painéis consomem — o valor da métrica já vai no canal `ping`/heartbeat), [ADR-0010](0010-teams-rbac-multitenancy.md) (autorização por `team_id`), [ADR-0009](0009-master-long-term-metrics-history.md) (séries `stat_*` para janelas longas de trend).

## Contexto

A ADR-0016 entregou dashboards internos por time como uma **lista ordenada de widgets** (3 tipos: `status_tile`, `metric_gauge`, `group_summary`) sobre monitores existentes, acessados via `/team-dashboards`. O usuário pediu para evoluir isso num **builder visual estilo Grafana**:

- Um botão **"Novo Dashboard"** par ao "Nova Página de Status", com URL `/panel/<slug>` (espelhando `/status/<slug>`).
- Um **builder de edição drag-and-drop** com grade redimensionável ("telas estilo Grafana").
- Catálogo de painéis rico: **gauge de CPU, gráfico de pizza, trend (linha), velocímetro de placa de rede, número único (stat)** — além dos 3 tipos já existentes.
- Dados de **telemetria Prometheus/InfluxDB** — que hoje já chegam via o monitor-type `influxdb` (o monitor "omniroute - CPU" do usuário já é uma query InfluxQL cujo valor está no canal `ping`).

Três decisões de arquitetura foram tomadas explicitamente pelo usuário (via perguntas diretas) e são a base deste ADR: **(1)** modelo de dados **híbrido faseado**; **(2)** visibilidade por **toggle "publicado" por dashboard**; **(3)** layout em **grid drag-and-drop redimensionável**.

## Decisões

### D1 — Modelo de dados: híbrido faseado

- **Fase 1 (escopo deste ADR):** cada painel **referencia um monitor existente** (`monitor_id`). O painel renderiza:
  - valor atual do monitor → `gauge` / `stat` / `speedometer` (reusa `MetricGaugeWidget` + `extractMetricValue`);
  - histórico do monitor → `trend` (linha, via `getMonitorBeats(monitorId, período)`, mesmo canal `ping`/`value` da ADR-0015, e `stat_*` para janelas longas);
  - distribuição up/down/pending → `pie` (doughnut do chart.js, já instalado);
  - além de manter `status_tile` e `group_summary` da ADR-0016.
  - **Fica pronto de imediato para os monitores InfluxDB/Telegraf do usuário** — cada monitor `influxdb` já é uma métrica.
- **Fase 2 (ADR futuro, fora deste escopo):** uma tabela `data_source` (endpoints Prometheus/InfluxDB) + **query própria por painel** (PromQL/InfluxQL) executada por um proxy no servidor, com seletor de intervalo de tempo e multi-série (ex.: RX/TX da placa no mesmo gráfico). O schema da Fase 1 já deixa espaço: `config_json` por painel e a possibilidade de tornar `monitor_id` nullable quando a Fase 2 chegar.

**Por que faseado:** a Fase 1 entrega telas reais e úteis usando dados e bibliotecas que já existem (zero subsistema novo de query), enquanto a Fase 2 — que é o verdadeiro peso (registro de fontes, editor de query, proxy, cache, time-range) — é isolada e adiada. De-risca a entrega.

### D2 — Evolução de schema (aditiva, preserva dados da ADR-0016)

Migração aditiva, **sem renomear tabelas** (evita churn e preserva dashboards já criados):

- **`dashboard`** ganha:
  - `slug` (string, único global como `status_page.slug`, `[a-z0-9-]+`) — a chave da URL pública. Backfill dos dashboards existentes a partir do `title` (slugify) + sufixo do `id` para garantir unicidade.
  - `published` (boolean, default `false`) — o toggle público/interno (ver D3). Nasce **não-publicado** (seguro).
  - `description` (text, nullable), `refresh_interval` (int, default 300), `theme` (string, default `'auto'`) — paridade com `status_page`.
- **`dashboard_widget`** ganha (o painel vira posicionado numa grade, em vez de só ordenado):
  - `pos_x`, `pos_y`, `width`, `height` (int) — geometria na grade de 12 colunas (convenção Grafana/Bootstrap). Defaults sensatos para migrar as linhas existentes (empilhadas em coluna).
  - `title` (string, nullable) — título por painel.
  - `config_json` (text, nullable) — opções por painel (unidade, thresholds, cores, min/max; e, na Fase 2, a query).
  - `kind` (já é `varchar(20)`, enum app-level) — **sem mudança de schema**, só amplia o conjunto de valores aceitos: `+ trend`, `+ pie`, `+ speedometer`, `+ stat`.
  - `monitor_id` **permanece NOT NULL na Fase 1** (todo painel referencia um monitor). Torná-lo nullable é adiado para a migração da Fase 2 — evita um rebuild de tabela arriscado no SQLite agora, sem custo para a Fase 1.
- `unique(team_id, title)` da ADR-0016 é **mantido** (título continua único por time); `slug` é único globalmente (namespace da URL pública, como status page).

### D3 — Visibilidade: toggle "publicado" por dashboard + rota pública

- Cada dashboard é **sempre de um time** (posse via `team_id`, RBAC de edição inalterado: `dashboard:read`/`dashboard:manage`), e tem um flag `published`:
  - `published = false` (default): interno, só visível para o time via socket.io autenticado (comportamento ADR-0016).
  - `published = true`: legível publicamente via `/panel/<slug>`, **sem autenticação**, como uma status page.
- **Nova rota pública** (superfície de leitura nova — ver "Segurança"): `server/routers/dashboard-router.js`, `GET /panel/:slug` (página) + um endpoint REST de dados, espelhando `status-page-router.js` (validação de slug `[a-z0-9-]+`, `cache`, rate-limit).
- Isto é uma **mudança consciente em relação à decisão "nunca público" da ADR-0016** — justificada pelo pedido explícito do usuário e por já existir toda a infraestrutura de `slug`/`published`/rota pública nas status pages para replicar.

### D4 — Layout: grid drag-and-drop redimensionável

- Nova dependência frontend: **`grid-layout-plus`** (port Vue 3, mantido, do `vue-grid-layout`; o `vue-grid-layout` original é Vue 2 e incompatível). Pin com `~` conforme convenção do repo. Fornece arrastar/soltar/redimensionar numa grade de 12 colunas, persistindo `x/y/w/h` por painel.
- O builder (`DashboardEditor.vue`) edita a grade; o modo de visualização (`DashboardView.vue`, também a rota pública) renderiza a mesma grade em modo somente-leitura.

### D5 — Catálogo de tipos de painel (Fase 1)

| `kind`          | Origem do dado (Fase 1)                  | Componente                           |
| --------------- | ---------------------------------------- | ------------------------------------ |
| `metric_gauge`  | valor atual do monitor                   | `MetricGaugeWidget` (reuso)          |
| `stat`          | valor atual (número grande + unidade)    | `StatPanel` (novo)                   |
| `speedometer`   | valor atual (gauge com agulha; ex.: NIC) | `SpeedometerPanel` (novo)            |
| `trend`         | `getMonitorBeats` (linha temporal)       | `TrendPanel` (novo, chart.js line)   |
| `pie`           | distribuição up/down/pending             | `PiePanel` (novo, chart.js doughnut) |
| `status_tile`   | status atual (ADR-0016)                  | inline (reuso)                       |
| `group_summary` | rollup de grupo (ADR-0016)               | `GroupSummaryWidget` (reuso)         |

### D6 — Superfícies de escrita (socket.io + MCP)

- `saveDashboard` (socket) e `save_dashboard` (MCP) passam a carregar, por painel: `kind`, `pos_x/pos_y/width/height`, `title`, `config_json`, além do `monitorId`. `createDashboard`/`create_dashboard` ganham `slug` (opcional, auto-gerado do título se ausente) e `published`. A validação R3 da ADR-0010 (cada `monitorId` revalidado contra o time do dashboard antes de qualquer escrita) é **mantida integralmente**.

## Segurança (rota pública nova)

A rota pública é a única superfície nova sensível. Regras:

1. **Só `published = true`** é servido; um slug não-publicado ou inexistente retorna **404** (não 403 — não vaza existência).
2. O payload público expõe **apenas o não-sensível**: nome do monitor, valor/status atuais, geometria e tipo do painel. **Nunca** config de monitor, credenciais, tokens, ou dados de outros times. Consistente com o que a status page já expõe publicamente (nomes de monitor + status).
3. Rate-limit no endpoint público (reusa `apiRateLimiter` ou um limiter dedicado), como as status pages.
4. Edição continua 100% atrás de `checkLogin` + RBAC (`dashboard:manage`); a rota pública é somente-leitura.

## Consequências

- **Migração de schema** aditiva sobre a ADR-0016 (colunas novas + backfill de slug). Reversível (`down` remove as colunas novas). Idempotente (`hasColumn` guards).
- **Dado histórico da Fase 1** é limitado à taxa de amostragem do SuperKuma (1 valor por monitor por intervalo) — suficiente para trends operacionais; multi-série e agregações ad-hoc chegam na Fase 2.
- **Nova dependência** `grid-layout-plus` (frontend apenas).
- ADR-0016 **não é revogado** — é evoluído; os 3 tipos de widget originais continuam válidos, os dashboards existentes migram sem perda (empilhados na grade, `published=false`).

## Sequenciamento (Fase 1)

1. Migração de schema (slug/published/description/refresh/theme em `dashboard`; pos/size/title/config_json em `dashboard_widget`) + backfill de slug. **[T3 — precisa de "Go"]**
2. Backend: `dashboardSocketHandler`/`saveDashboard` carregam geometria+tipo+config; `dashboard-router.js` público (`/panel/:slug`, só `published`).
3. Frontend: dependência `grid-layout-plus`; `DashboardEditor.vue` (grid drag-drop) + `DashboardView.vue` (leitura/pública); painéis novos (`StatPanel`/`SpeedometerPanel`/`TrendPanel`/`PiePanel`); botão "Novo Dashboard" + fluxo de slug; nav/rotas.
4. MCP: `create_dashboard`/`save_dashboard` ganham slug/published/geometria/tipo/config.
5. i18n (en + pt-BR), testes (migração, authz da rota pública, geometria round-trip) com verificação adversarial, e verificação ao vivo no dev server.
