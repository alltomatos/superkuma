# ADR-0019: Monitoramento de logs via Grafana Loki

- **Status:** Proposed
- **Data:** 2026-07-15
- **Tier:** T2 (novo monitor type + nova tabela + serviço opcional de infra; não toca superfície pública de ingestão nem o caminho crítico de `beat()`).
- **Relacionado:** ADR-0013 (anomaly detection / `alert_event`), ADR-0014 (severidade e roteamento de notificação), ADR-0015 (OTLP telemetry receiver — precedente direto do "não é observabilidade"), ADR-0010 (RBAC/multi-tenancy).

## Contexto

O SuperKuma hoje só monitora **métricas** (ping/value via push, Prometheus/InfluxDB/OTel via pull/push numérico) — não existe forma de olhar **conteúdo de log** e alarmar sobre padrões nele (erros, exceções, termos específicos).

O ADR-0015 já enfrentou essa questão pro sinal "logs" do OTLP e decidiu explicitamente **não** armazenar log bruto no SuperKuma ("isto não é observabilidade" — sem full-text search, sem storage colunar, reduction-no-ingest). Este ADR estende esse mesmo princípio: se o objetivo é alarmar sobre logs, o SuperKuma não precisa (e não deve) virar um log store — só precisa consultar um.

**Grafana Loki** é o motor de log purpose-built pra isso: indexa só labels (não full-text), armazenamento comprimido, consultado via **LogQL** (`count_over_time({job="app"} |= "error" [5m])` retorna uma contagem numérica agregada). Ingestão de log é responsabilidade de um agente externo (Promtail/Grafana Alloy/Fluentbit/OTel Collector) — o SuperKuma nunca recebe/armazena a linha de log, só a contagem que uma query LogQL já reduziu.

## Decisão

**1. SuperKuma vira um cliente LogQL, nunca um log store.** Um monitor `loki` roda queries LogQL contra um Loki (bundled opcionalmente, ver item 5, ou já existente no ambiente do cliente) e avalia **contagens numéricas** — nunca lê nem persiste linhas de log cru. `extractLokiValue()` rejeita explicitamente resultados `streams` (log lines) pelo mesmo motivo que `prometheus.js` rejeita `matrix`.

**2. Um monitor suporta N regras independentes**, não uma LogQL única — desvio deliberado do padrão 1-condição-por-monitor de `prometheus.js`/`otel`. Cada regra (`monitor_log_rule`: nome, LogQL, operador, threshold, severidade) é avaliada separadamente a cada beat. Justificativa: "identificar erros e alarmar" na prática significa vigiar vários padrões simultâneos (ex: "ERROR" com um threshold/severidade, "timeout" com outro) — forçar isso numa única condição pré-existente seria uma abstração forçada.

**3. Reachability do monitor é desacoplada da avaliação das regras** — mesma separação já estabelecida pelo ADR-0013 entre heartbeat UP/DOWN e `alert_event`. Só a Fase A (`GET /ready`, ou uma LogQL leve opcional em `monitor.loki_reachability_query`) decide o status do monitor. Uma regra disparada nunca vira DOWN; ela produz um `alert_event` (`type: "log_rule"`, `log_rule_id` apontando pra regra) via `Monitor.evaluateLogRule()` — estruturalmente irmã de `Monitor.evaluateAnomaly()` (mesmo cooldown anti-ruído, mesmo insert em `alert_event`, mesmo swallow-all-errors pra nunca contaminar o heartbeat).

**4. Zero mudança em `server/notification-routing.js` (ADR-0014).** Cada regra disparada chama `Monitor.getRoutedNotificationList(monitor, rule.severity)` — a mesma função que a anomaly detection já usa. `SEVERITY_ORDER`/`routeMatches`/`resolveNotificationTargets` já são genéricos o suficiente pra qualquer fonte de alerta com `{teamId, monitorId, tagIds, severity}`.

**5. SuperKuma hospeda um Loki opcional** (`compose.yaml`, serviço `loki`, mesmo padrão sem-profile do `influxdb` já existente) — single-binary, storage em filesystem local. Não é obrigatório: quem já roda um Loki no ambiente do cliente só aponta a URL. O serviço bundled existe pra cobrir o caso "cliente não tem Loki ainda e não quer operar um cluster S3-backed" — adequado ao volume de log de uma instância self-hosted, não pensado pra escalar como um Loki de produção multi-tenant.

## Consequências

- (+) Reaproveita quase tudo que já existe: `evaluateJsonQuery` (zero mudança), o padrão pull-based de `prometheus.js` (mesmo bloco de auth/TLS/timeout), e o pipeline de severidade/roteamento inteiro do ADR-0013/0014 (zero mudança).
- (+) Nunca contamina uptime/SLA (mesma garantia do ADR-0013) nem vira um segundo log store pro SuperKuma operar/escalar.
- (+) `monitor_log_rule` como tabela própria (não JSON em `monitor.conditions`) dá rastreabilidade real por regra em `alert_event` — auditoria de "qual regra disparou quando" sem parsear blobs.
- (−) Introduz um terceiro monitor type "pull + N-condições" ao lado do padrão "pull + 1-condição" já estabelecido — mais uma forma de configurar um monitor, custo de superfície de UI/documentação.
- (−) O Loki bundled em modo single-binary/filesystem não escala além de um único host pequeno; documentado como limitação explícita, não um roadmap de produção.
- (−) Depende de um agente de coleta de log externo (Promtail/Alloy/Fluentbit) que o SuperKuma não instala nem gerencia — mais uma peça de infra pro operador configurar (mitigado por documentação em `.claude/skills/superkuma-monitoring/references/loki-log-monitoring.md`).

## Não-escopo

- Sem full-text search de log na UI do SuperKuma (isso é o Grafana + Loki, não o SuperKuma).
- Sem tail ao vivo / visualização de linhas de log cru dentro do SuperKuma.
- Sem correlação log↔trace↔métrica.
- Sem embarcar Promtail/Alloy/Fluentbit — responsabilidade do operador/cliente.
- Sem suporte a resultado `streams` (linhas de log cru) nas regras — só agregações numéricas (`count_over_time`, `sum`, etc.).

## Alternativas consideradas

- **Delegar 100% a um Loki externo do cliente, sem tocar `compose.yaml`:** mais barato de implementar, mas deixa o operador sem opção "tudo incluso" quando o cliente ainda não tem Loki — rejeitado a pedido explícito do usuário (quer o Loki hospedável junto).
- **Reusar `prometheus.js` fazendo `count_over_time` como se fosse PromQL:** tecnicamente possível (LogQL de agregação retorna o mesmo shape JSON que PromQL), mas não suporta N regras nem expõe a UI certa (LogQL, não PromQL) — rejeitado.
- **Guardar as regras como JSON em `monitor.conditions`:** mais simples de implementar, mas perde a FK real que `alert_event.log_rule_id` precisa pra rastreabilidade por regra — rejeitado.

## Sequenciamento

1. Migration (`monitor_log_rule` + `monitor.loki_reachability_query` + `alert_event.log_rule_id`).
2. RBAC (`team-id-loaders.js`).
3. `extractLokiValue`/`parseRangeWindowMs` + testes puros.
4. `Monitor.evaluateLogRule` em `server/model/monitor.js`.
5. `server/monitor-types/loki.js` (`check()` completo), registrado em `superkuma-server.js`.
6. CRUD de `monitor_log_rule` (`server/socket-handlers/monitor-log-rule-socket-handler.js`).
7. Frontend: `LogRuleEditor.vue` + integração em `EditMonitor.vue`.
8. `compose.yaml` + documentação de referência do skill.
9. Este ADR, escrito por último documentando o que foi de fato implementado.
