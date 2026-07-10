# ADR-0016: Dashboards internos por time (visão "RMM")

- **Status:** Proposed
- **Data:** 2026-07-10
- **Tier:** T3 (schema novo + superfície MCP nova + toca autorização por `team_id`) — exige "Go" humano.
- **Inspiração:** ferramentas RMM (NinjaOne/Datto RMM/Atera-style: visão operacional por cliente/time)
  — não deriva do relatório SigNoz como as ADRs 0013-0015.
- **Relacionado:** [ADR-0010](0010-teams-rbac-multitenancy.md) (eixo `team_id` + padrão de autorização
  a replicar), [ADR-0009](0009-master-long-term-metrics-history.md) (séries `stat_*` que os widgets de
  métrica consomem), [ADR-0011](0011-mcp-server-for-agent-configuration.md) (o MCP é o modo primário
  de criação previsto para esta feature).

## Contexto

O pedido que originou este ADR: um usuário quer pedir a um agente (via MCP) **"crie um dashboard com
os monitores do time X"** e receber uma visão operacional pronta — o tipo de tela que ferramentas RMM
mostram por cliente: status agregado, métricas lado a lado, agrupamento por site/papel. Isso expõe
que **"o que o SuperKuma pretende ser"** não está documentado em lugar nenhum hoje — o
[`CONTEXT.md`](../../CONTEXT.md) define o projeto como "monitoramento de disponibilidade", sem
menção a uma central operacional multi-time. Este ADR propõe a peça de produto que começa a preencher
essa lacuna, e assume que a direção (RMM-like, dashboards internos por time) é uma decisão já tomada
pelo usuário — o que resta em aberto é _como_ construir isso sem colidir com o que já existe.

**Por que não é só um Status Page.** O SuperKuma já tem um primitivo muito próximo:
[`status_page`](../../server/model/status_page.js) + os MCP tools em
[`status-pages.js`](../../server/mcp/tools/status-pages.js) (`create_status_page`/`save_status_page`
com `groups: [{name, monitorIds}]`), e a [ADR-0010](0010-teams-rbac-multitenancy.md) (decisão D8) já
deu a ele `team_id` + `is_public` — ou seja, um status page **já pode** ser interno e escopado por
time hoje. Cogitamos reusar exatamente isso. A razão para **não** reusar:

- Status Page tem uma audiência e um propósito fixos: comunicar "está no ar?" a alguém de fora
  (cliente, usuário público), com uma UI deliberadamente simples (grupo → lista de monitor + barra de
  uptime). É a superfície _pública_ do projeto — mesmo com `is_public=false`, seu modelo de dados e
  sua UI foram desenhados para esse caso de uso.
- Uma visão estilo RMM quer compor **tipos diferentes de widget** lado a lado — não só "monitor +
  status binário", mas o **gauge de métrica** que os monitores `prometheus`/`influxdb`/`snmp`
  numéricos já produzem (`MetricGaugeWidget.vue`, já construído para a página de detalhe e para
  status pages), além de rollups agregados ("3 críticos, 12 ok"). Forçar isso dentro do Status Page
  faria seu schema/UI acumularem conceitos de uma audiência (técnico interno) que não é a dele
  (cliente externo) — as duas audiências têm necessidades que vão divergir com o tempo.
- Consequência prática: **Dashboard é sempre autenticado/interno, nunca ganha um `is_public`** — ao
  contrário do Status Page, essa porta nem existe aqui. Isso simplifica a autorização (não há um
  segundo eixo público/privado para raciocinar).

**O gap que bloqueia isso hoje, independente do caminho escolhido:** os MCP tools de monitor
(`server/mcp/tools/monitors.js`) não devolvem nem filtram por `team_id` — `summarizeMonitor()` não
inclui o campo. Ou seja, hoje um agente não consegue responder "quais são os monitores do time X" via
MCP, mesmo que o dado exista no banco (ADR-0010 já deu `team_id` a `monitor`). Este é um
**pré-requisito compartilhado**, não específico deste ADR — vale corrigi-lo mesmo que a decisão aqui
tivesse sido "reusar Status Page".

## Decisão

Introduzir um conceito novo, **`dashboard`**, sempre interno e sempre escopado a exatamente um time —
uma composição ordenada de _widgets_, cada um referenciando um monitor existente.

**1. Schema (migration Knex nova, 2 tabelas):**

```
dashboard
  id PK
  team_id INTEGER NOT NULL FK team(id) ON DELETE CASCADE   -- dashboard não carrega histórico
  title VARCHAR(255) NOT NULL
  created_date DATETIME DEFAULT now
  UNIQUE(team_id, title)                                    -- guarda-anti-duplicata, não é identidade

dashboard_widget
  id PK
  dashboard_id INTEGER NOT NULL FK dashboard(id) ON DELETE CASCADE
  monitor_id   INTEGER NOT NULL FK monitor(id)   ON DELETE CASCADE  -- widget some se o monitor morre
  kind VARCHAR NOT NULL DEFAULT 'status_tile'   -- status_tile | metric_gauge | group_summary (v1)
  section_name VARCHAR(255) NULL                -- cabeçalho opcional (agrupamento leve, tipo status_page.groups)
  sort_order INTEGER NOT NULL DEFAULT 0
  INDEX(dashboard_id)
```

`ON DELETE CASCADE` em ambas as FKs — **deliberadamente diferente** do `RESTRICT` que a
[ADR-0010](0010-teams-rbac-multitenancy.md) (D3) escolheu para `monitor.team_id`: lá, cascade
apagaria heartbeats/histórico (caro, irreversível); aqui, um dashboard é só uma **composição/view**
sem histórico próprio — perder seu layout ao apagar o time ou um monitor referenciado é barato e
esperado, não um risco de perda de dados.

**2. Autorização — replica o padrão da ADR-0010, sem exceção.** `dashboard` entra no loader tipado de
`server/security/authz.js` (`resourceType → SELECT team_id FROM dashboard WHERE id=?`);
`team_id` **nunca** aceito de payload de cliente/agente — sempre `bean.team_id = actor.activeTeamId`
no create, sempre re-afirmado a partir do DB no edit (mesma regra R3 da ADR-0010, §4.3). Esta é a
parte do design que mais precisa de revisão humana: é a primeira vez que um recurso _criado
predominantemente por agente via MCP_ carrega um campo sensível de tenancy.

**3. Widgets, v1 = 3 tipos, deliberadamente estreito:**

- `status_tile` — status atual + uptime%, reusa o componente/estilo já usado na lista de monitores.
- `metric_gauge` — para monitores numéricos (`prometheus`/`influxdb`/`snmp`/`json-query` com
  `metricUnit`), **reusa `MetricGaugeWidget.vue` tal como está** (já usado em Details.vue e status
  pages) — nenhum componente novo de gauge a construir.
- `group_summary` — rollup de um monitor `group`: contagem up/down/pausado dos filhos. Único
  componente genuinamente novo em v1.

**4. MCP — espelha a família de tools de status page quase literalmente** (mesmo formato
create/save-completo/get/list/delete que `status-pages.js` já usa, testado e já familiar a quem opera
o MCP): `create_dashboard({title})` (team resolvido do lado do servidor a partir da chave MCP
autenticada — nunca de um `teamId` no prompt), `save_dashboard({id, widgets: [{monitorId, kind,
sectionName?}]})` (substitui a lista inteira, mesma semântica "replace" do `save_status_page`),
`get_dashboard`, `list_dashboards`, `delete_dashboard`. **Pré-requisito, não escopo deste item:**
`list_monitors`/`summarizeMonitor` passam a expor/filtrar por `team_id` — sem isso, um agente não
consegue montar a lista de `monitorIds` do time X para popular o dashboard.

**5. UI — front-heavy, fatiar depois do backend** (mesma sequência das ADRs 0013/0014: o backend +
MCP já entregam valor sozinhos — um agente consegue criar e inspecionar um dashboard via MCP antes de
qualquer tela existir). Nova página (`src/pages/Dashboard.vue` ou similar), navegação por time,
renderiza os widgets na ordem/seção salva.

## Consequências

- (+) Separa limpo as duas audiências: Status Page continua simples/pública; Dashboard vira o lugar
  natural para compor os monitores numéricos (`influxdb`/`prometheus`/`snmp`) já entregues — cada um
  desses ganha um lar coletivo além da própria página de detalhe.
- (+) Reuso alto: `MetricGaugeWidget.vue` (zero trabalho novo de gauge), o formato de MCP tools do
  status page (create/save-completo/get/list/delete, já testado nesta base), e o padrão de
  autorização por `team_id` da ADR-0010 (copiado, não reinventado).
- (+) Pensado para ser construído por agente desde o design (MCP-first, UI depois) — casa com o pedido
  original do usuário.
- (−) Segundo recurso team-scoped e referenciando monitores, ao lado de `status_page`/`group` — mais
  superfície para manter consistente em autorização (mitigado por copiar a regra R3 da ADR-0010
  literalmente, não uma variante).
- (−) Schema novo + MCP novo + UI nova = **T3** de verdade, esforço bem maior que o caminho alternativo
  (reusar Status Page) — trade-off consciente pelo motivo do §Contexto.
- (−) Bloqueado por um pré-requisito fora do escopo direto deste ADR (`team_id` em `list_monitors`) —
  precisa entrar na fase 0 do sequenciamento, não pode ser esquecido.
- (−) 3 tipos de widget é deliberadamente pouco — quase certo que vai crescer (gráfico de série
  temporal, feed de incidentes) assim que o uso real aparecer; v1 não tenta prever esse crescimento.

## Não-escopo (v1, explícito)

- **Não** é um substituto do Status Page — páginas públicas continuam existindo exatamente como são;
  Dashboard nunca tem `is_public`, nunca tem slug público, nunca é acessível sem autenticação.
- **Não** é uma ferramenta de BI/relatório genérico — sem SQL livre, sem agregação cross-team.
- **Não** tem layout livre (drag-and-drop, posições/tamanhos arbitrários) em v1 — lista ordenada com
  cabeçalho de seção opcional, mesma ergonomia que `save_status_page.groups` já usa. Grid livre é um
  salto de escopo grande, fica para quando houver sinal real de que a lista ordenada não basta.
- **Não** tem push em tempo real (Socket.io) em v1 — recarrega como o resto do dashboard autenticado;
  live-push é uma evolução, não um requisito de v1.
- **Não** suporta dashboard cross-team em v1 — exatamente um `team_id` por dashboard. Uma visão
  global fica para quem tem acesso superadmin a cada time individualmente, por ora.

## Alternativas consideradas

- **Reusar Status Page com `is_public=false`** (a alternativa mais barata, oferecida e não escolhida):
  reaproveitaria schema/MCP prontos, mas conflaria duas audiências com necessidades que já se sabe que
  vão divergir (widgets ricos vs. lista pública simples) — ver §Contexto. Descartada pelo usuário em
  favor de um conceito próprio.
- **Dashboard "computado", sem persistência** (conteúdo derivado on-the-fly de tags/team, sem
  `dashboard_widget` salvo): mais simples, mas qualquer mudança de tag em outro lugar muda o dashboard
  sem aviso, e um agente não consegue "pedir uma vez e deixar do jeito que ficou" — perde exatamente o
  caso de uso que motivou o pedido. Descartada.
- **Grid livre (react-grid-layout-style) desde já:** UX mais rica, mas escopo bem maior sem sinal de
  que é necessário ainda. Adiada — lista ordenada + seção é o mesmo custo de implementação que o
  Status Page já provou suficiente.

## Sequenciamento sugerido

1. **Pré-requisito (pequeno, compartilhado):** `team_id` exposto/filtrável em
   `list_monitors`/`summarizeMonitor`. Não bloqueia só este ADR — é infraestrutura de qualquer feature
   team-scoped futura via MCP.
2. **Backend, fase 1:** migration `dashboard` + `dashboard_widget` + model + fiação em
   `server/security/authz.js` (loader do novo resourceType). Testes de autorização (team_id nunca do
   payload, mesma disciplina de teste da ADR-0010) antes de qualquer MCP tool.
3. **MCP:** `create_dashboard`/`save_dashboard`/`get_dashboard`/`list_dashboards`/`delete_dashboard`,
   espelhando `status-pages.js`. Entrega valor sozinho — um agente já consegue montar e inspecionar
   dashboards antes da UI existir.
4. **UI:** página nova + os 3 renderizadores de widget (`status_tile`/`metric_gauge` reusam
   componentes existentes; `group_summary` é o único novo).
5. **Fora de v1, avaliar só com uso real:** widgets de série temporal, grid livre, push em tempo real,
   dashboard cross-team.
