# ADR-0014: Severidade de alerta + roteamento de notificações

- **Status:** Proposed
- **Data:** 2026-07-09
- **Tier:** T3 (schema novo + toca o caminho de notificação) — exige "Go" humano.
- **Inspiração:** SigNoz (severity + routing policies). Ver [`docs/analise-signoz.md`](../analise-signoz.md) §3 (P1.2).
- **Relacionado:** [ADR-0013](0013-anomaly-detection-alerts.md) (consumidor deste roteamento), [ADR-0010](0010-teams-rbac-multitenancy.md) (teams como eixo de escopo), [ADR-0003](0003-notification-providers-as-plugins.md) (providers).

## Contexto

Hoje o vínculo notificação↔monitor é **estático e binário**: a tabela `monitor_notification` liga um canal a um monitor, e `Monitor.getNotificationList()` (`server/model/monitor.js:1298`) resolve os canais com um `SELECT ... FROM notification, monitor_notification WHERE monitor_id = ?`. `Monitor.sendNotification()` (`:1224`) itera essa lista e dispara **todos** os canais anexados, sempre com o mesmo peso. Não existe:

- **Severidade** — um blip de 1 monitor secundário e a queda do gateway de pagamento acionam os mesmos canais, do mesmo jeito, 3h da manhã incluído.
- **Roteamento por atributo** — não há como dizer "críticos → PagerDuty + on-call; avisos → um canal de Slack silencioso".
- **Escopo por team** — com o multi-tenant chegando ([ADR-0010](0010-teams-rbac-multitenancy.md)), cada team vai querer suas próprias regras de encaminhamento.

O SigNoz resolve isso com **severity** (`warning`/`critical`) + **labels** + **routing policies** (label/severidade → canal). Curiosamente, é o **único** eixo em que o SigNoz está à frente do SuperKuma em notificação: temos ~90 providers (`server/notification-providers/`) contra ~9 dele. O gap não é "mais canais" — é **transformar a largura que já temos num sistema de escalonamento**.

Este ADR também é **pré-requisito do [ADR-0013](0013-anomaly-detection-alerts.md)**: o alerta de anomalia emite um evento com `severity` e precisa de um destino de roteamento para ser útil. Roteamento é a fundação; anomalia é um dos consumidores.

## Decisão

Nós vamos introduzir **severidade de alerta** e um **resolvedor de roteamento** opcional, atrás de flag dark-launch, mantendo o caminho legado **byte-idêntico quando desligado** (mesma disciplina de regressão da [ADR-0010](0010-teams-rbac-multitenancy.md)).

**1. Severidade no contexto do alerta.** Todo evento notificável carrega uma `severity` ∈ {`critical`, `warning`, `info`}:
- **UP/DOWN:** deriva de um campo novo por monitor `alert_severity` (default `critical` = comportamento atual de "todo DOWN é grave"). Recuperação (UP) herda a severidade da queda que resolveu.
- **Anomalia:** vem do `alert_event.severity` da [ADR-0013](0013-anomaly-detection-alerts.md).
- **Expiração de cert/domínio:** `warning` por default.

**2. Regras de roteamento (opt-in, aditivas).** Migration Knex nova: tabela `notification_route` com um **seletor** e um **destino**:
- Seletor: `team_id` (escopo), `min_severity`, e um match por **tag de monitor** (reusa `monitor_tag`/`tag` já existentes) e/ou `monitor_id`.
- Destino: `notification_id` (canal já cadastrado).
- Semântica: uma rota diz "eventos que casam o seletor **também** vão para este canal". É **aditiva sobre** o vínculo estático atual — nunca remove canais que o usuário já anexou (evita silenciar algo por engano).

**3. Ponto de inserção único e cirúrgico.** O resolvedor entra em **um** lugar: uma função `resolveNotificationTargets(monitor, alertContext)` que `sendNotification` chama no lugar de `getNotificationList`. Com a flag OFF (ou sem nenhuma rota cadastrada), ela retorna exatamente o resultado de `getNotificationList` de hoje — **zero mudança de comportamento**. Com rotas, ela faz a **união** (dedupe por `notification_id`) entre os canais estáticos do monitor e os canais das rotas que casam a `severity`/tags/team.

**4. Filtro de severidade por canal (fase 2).** Permitir que uma rota declare `min_severity` para que um canal "barulhento" só receba `critical` — o embrião de escalonamento (avisos num Slack, críticos no PagerDuty).

**5. UI.** Nova tela "Notification Routing" (lista de rotas por team) + seletor de `alert_severity` no `EditMonitor.vue`. Front-heavy → fatiar; a fase backend (severity + resolvedor + rotas aditivas) entrega valor sozinha via API antes da UI.

## Consequências

- (+) Escalonamento real: severidade + destino por atributo, reusando os ~90 providers existentes — capitaliza o maior ativo do projeto.
- (+) Casa com o multi-tenant **em execução**: `team_id` no seletor nasce alinhado à [ADR-0010](0010-teams-rbac-multitenancy.md), em vez de ser remendado depois.
- (+) Desbloqueia o valor prático da [ADR-0013](0013-anomaly-detection-alerts.md) (anomalia sabe pra onde ir).
- (+) Aditivo e flag-gated → contrato de regressão simples (OFF = idêntico ao legado).
- (−) Novo conceito ("rota") que o modelo hoje não tem; custo de documentação e de UI.
- (−) Regras aditivas podem gerar **notificação duplicada** se o usuário anexar o canal estaticamente **e** por rota — mitigado pelo dedupe por `notification_id` no resolvedor.
- (−) `min_severity` por canal (fase 2) reabre a possibilidade de **suprimir** notificação — precisa de UI clara pra não "sumir" alerta sem o usuário perceber.
- (−) Migration + toque no caminho de notificação = **T3**.

## Alternativas consideradas

- **Rotas que substituem (em vez de somar) os canais estáticos:** mais poderoso, mas arrisca silenciar alertas por config incompleta. Descartado na v1 em favor do modelo aditivo seguro; "substituir" pode ser um modo explícito futuro.
- **Severidade sem roteamento (só um label informativo no texto):** barato, mas não resolve o problema real (mesmo destino pra tudo). Meia-solução.
- **Delegar ao Alertmanager externo:** contradiz a proposta self-hosted "bateria inclusa"; e jogaria fora os 90 providers nativos. O `prometheus.js` já é a ponte pra quem tem esse stack.
- **Roteamento por expressão livre (mini-DSL de labels estilo Alertmanager):** flexível demais para a v1; seletor estruturado (team + severidade + tag) cobre 90% dos casos com UI simples.

## Sequenciamento sugerido

1. **Backend, fase 1 (aditiva, sem UI):** campo `alert_severity` no monitor + migration `notification_route` + `resolveNotificationTargets()` com flag OFF byte-idêntica. TDD do resolvedor (união/dedupe/severidade) isolado da I/O.
2. **Fiação:** `sendNotification` passa a chamar o resolvedor; testes de caracterização garantindo OFF = legado.
3. **UI:** tela de rotas (team-scoped) + seletor de severidade no `EditMonitor.vue`.
4. **Fase 2:** `min_severity` por canal (supressão consciente) + integração com o `alert_event` da [ADR-0013](0013-anomaly-detection-alerts.md).
