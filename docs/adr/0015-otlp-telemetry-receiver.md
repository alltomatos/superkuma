# ADR-0015: Receptor de telemetria OTLP (ingestão push de métricas)

- **Status:** Proposed
- **Data:** 2026-07-09
- **Tier:** T3 (nova superfície de ingestão + novo tipo de monitor + token de auth + risco de cardinalidade) — exige "Go" humano.
- **Inspiração:** SigNoz (ingestão OpenTelemetry-native). Ver [`docs/analise-signoz.md`](../analise-signoz.md) §3 (P3.1).
- **Relacionado:** [ADR-0013](0013-anomaly-detection-alerts.md) (anomalia consome as métricas ingeridas), [ADR-0014](0014-alert-severity-and-notification-routing.md) (severidade/roteamento do alerta), [ADR-0002](0002-monitor-types-as-plugins.md) (tipos como plugin), [ADR-0008](0008-master-agent-federation.md) (federação = mesma forma de push).

## Contexto

O relatório de análise do SigNoz levanta o receptor OTLP como a oportunidade mais ambiciosa (P3.1) — e a mais perigosa de contemplar mal. O SigNoz é **observabilidade white-box**: ingere traces/logs/métricas via OpenTelemetry e os armazena em **ClickHouse** (colunar, alta cardinalidade) para busca/flamegraph/correlação. O SuperKuma persiste em **SQLite/MariaDB via redbean/Knex** ([ADR-0001](0001-hybrid-persistence-redbean-knex.md)) — **não é um store de telemetria** e não deve tentar ser. Copiar o SigNoz "de verdade" significaria trocar o storage e o produto inteiro; é um **non-goal explícito**.

A questão certa não é "como armazenar telemetria" e sim **"como deixar o SuperKuma reagir a telemetria que a aplicação já emite, sem virar um store"**. E aqui o projeto já tem **três** peças que apontam o caminho:

1. **Monitor push** — endpoint `/api/push/:pushToken` ([api-router.js:47](../../server/routers/api-router.js)) recebe batida externa; o `beat()` do tipo push ([monitor.js:489](../../server/model/monitor.js)) é um **watchdog passivo** (marca DOWN se não chegou nada na janela). Ingestão passiva + watchdog já existem.
2. **Monitor prometheus** ([monitor-types/prometheus.js](../../server/monitor-types/prometheus.js)) — puxa um valor numérico (PromQL) e o compara a um threshold via `evaluateJsonQuery`. O núcleo "métrica → UP/DOWN" já existe.
3. **Federação Master-Agent** ([ADR-0008](0008-master-agent-federation.md)) — agentes fazem POST de heartbeats para um Master que os espelha como `type=push`. Ingestão push distribuída já existe.

O receptor de telemetria é o **dual push do monitor prometheus**: em vez de o SuperKuma *puxar* a métrica, a aplicação (via OTel Collector/SDK) a *empurra*.

## Decisão

Nós vamos tratar o receptor de telemetria **não como um novo pilar de storage, mas como um quarto adaptador de ingestão sobre o mesmo núcleo de avaliação** que as ADRs 0013/0014 já constroem. O SuperKuma passa a ter:

> **Um núcleo de avaliação** (threshold via `evaluateJsonQuery` + anomalia [ADR-0013] + severidade/roteamento [ADR-0014]) alimentado por **múltiplos adaptadores de ingestão**: pull ativo (`prometheus`), push-heartbeat passivo (`push`), e agora **push-OTLP passivo** (`otel`).

Cinco decisões que mantêm isso *em escopo* e *no SQLite*:

**1. Só métricas na v1.** Traces, logs e exceptions ficam de fora do storage. Quando (fase 2+) forem contemplados, é por **redução no ingest**: um span vira contadores RED (Rate/Errors/Duration); um lote de logs de erro vira uma contagem. Nunca guardamos o span/log cru — só o número derivado. Isso dá "APM-lite" sem ClickHouse.

**2. Nunca persistir telemetria crua — reduzir no ingest.** Cada datapoint que **casa um monitor** vira: um heartbeat (pipeline existente) + o valor numérico fluindo para `stat_*` via `UptimeCalculator` (mesma vala do `ping`). Consequência de graça: o detector de anomalia da [ADR-0013](0013-anomaly-detection-alerts.md) passa a funcionar sobre métricas de telemetria **sem código extra**. O que não casa nenhum monitor é **descartado**, não armazenado.

**3. Selector-first, drop-by-default (a trava de cardinalidade).** Um `otel` monitor **declara** o que quer: nome da métrica + matchers de atributo (ex.: `http.server.request.duration{service=payments}`) + agregação (last/avg/max/sum quando o selector casa várias séries) + condição (threshold e/ou anomalia). Um Collector empurrando 500 métricas só afeta as que têm monitor casando; o resto **não é guardado**. É isto que impede a alta cardinalidade do OTLP de estourar o SQLite — o modelo é *declarativo e restritivo por padrão*, o oposto do "ingere tudo" do SigNoz.

**4. Superfície OTLP/HTTP padrão.** Novo router `server/routers/telemetry-router.js` (irmão de push/federation), expondo `POST /v1/metrics` (OTLP protobuf **e** JSON). O usuário aponta um **OTel Collector** para o SuperKuma — o Collector faz o trabalho pesado (batching, retry, transformação). Auth por **ingest token** (padrão `push_token`, um por monitor ou por team), **team-scoped** ([ADR-0010](0010-teams-rbac-multitenancy.md)). Sem socket/`checkLogin` — é superfície pública autenticada por token, como o push.

**5. Tipo de monitor no molde push (passivo + watchdog).** Novo `server/monitor-types/otel.js` reusa a lógica do tipo `push`: não checa ativamente; o `beat()` é watchdog de inatividade ("sem datapoint na janela → DOWN", dead-man's switch). A **avaliação da condição** roda no handler do router a cada datapoint recebido, reusando `evaluateJsonQuery` (idêntico a prometheus/snmp) e, opt-in, a anomalia da [ADR-0013](0013-anomaly-detection-alerts.md). Severidade e destino via [ADR-0014](0014-alert-severity-and-notification-routing.md).

## Consequências

- (+) OTel-native **sem** ClickHouse: capta valor da telemetria que o cliente já emite, mantendo a proposta self-hosted "bateria inclusa".
- (+) **Reuso máximo**: núcleo de avaliação, `stat_*`, anomalia, severidade/roteamento — tudo compartilhado. O receptor é "só mais um produtor".
- (+) História arquitetural limpa e defensável: *um núcleo, N adaptadores de ingestão* (pull / push-heartbeat / push-OTLP).
- (+) Sinergia com federação: agentes/apps empurrando métricas é a mesma forma do Master-Agent; pode até dividir transporte no futuro.
- (−) Parsing de **OTLP protobuf** é chato (dependência nova, schema versionado). Mitigação: começar por OTLP/JSON e delegar batching/transform ao Collector.
- (−) **Temporalidade** (delta vs cumulative) e múltiplos datapoints por série exigem cuidado; v1 fixa regra simples (último valor por série casada, agrega se o selector casar N séries) e documenta o resto como limitação.
- (−) Superfície pública nova = superfície de ataque nova (token, rate-limit, tamanho de payload). Precisa de hardening desde o dia 1.
- (−) Risco de expectativa: usuários podem esperar "observabilidade" e receber "alerta sobre métrica". A doc precisa dizer o **não-escopo** em voz alta.

## Não-escopo (explícito, para gerir expectativa)

Isto **não** é observabilidade. Sem flamegraph, sem busca de trace, sem busca de log, sem correlação log↔trace↔metric, sem storage colunar. Quem precisa disso roda SigNoz/Grafana **ao lado**. O receptor do SuperKuma é: *"pegue uma métrica OTLP que sua app já emite e transforme num alerta self-hosted, com o mesmo motor de threshold/anomalia/roteamento dos outros monitores"*. O `prometheus.js` já é a ponte para quem tem Prometheus; o `otel` é a ponte para quem emite OTLP e **não** quer montar um stack de observabilidade completo.

## Alternativas consideradas

- **Ingerir e armazenar traces/logs (SigNoz de verdade):** exige ClickHouse; troca o produto. Non-goal.
- **Armazenar séries de métrica cruas (virar um TSDB):** estoura o SQLite em cardinalidade e reimplementa Prometheus mal. A redução-no-ingest evita isso.
- **Estender o endpoint `/api/push` para aceitar um valor numérico + labels (sem OTLP):** menor esforço e cobre o caso simples, mas perde o principal atrativo (ser OTel-native e plugar num Collector existente). **Candidato a MVP-0** se o apetite for testar a ideia barato antes do OTLP completo.
- **Delegar 100% a um Collector + Prometheus + `prometheus.js`:** já funciona hoje para quem tem esse stack — este ADR é justamente para quem **não** quer o intermediário Prometheus.

## Sequenciamento sugerido

Depende de 0013/0014 estarem de pé — o receptor é um **produtor** para o núcleo que elas constroem; construí-lo antes seria alimentar um motor que não existe.

1. **Pré-requisito:** [ADR-0014](0014-alert-severity-and-notification-routing.md) (roteamento) + [ADR-0013](0013-anomaly-detection-alerts.md) fase-1 (o núcleo de avaliação/anomalia).
2. **MVP-0 (opcional, barato):** estender `/api/push` para aceitar `value` numérico → valida a redução-no-ingest e o selector com esforço mínimo, sem OTLP.
3. **Receptor OTLP/JSON:** `telemetry-router.js` + `POST /v1/metrics` (JSON) + ingest token team-scoped + tipo `otel` (watchdog no molde push).
4. **Selector + avaliação:** matcher metric+attrs, agregação, `evaluateJsonQuery`, ligação com anomalia/severidade.
5. **OTLP/protobuf + hardening:** rate-limit, limite de payload, guardrails de cardinalidade (teto de séries casadas por monitor).
6. **Fase 2 (só depois):** redução de spans → RED e de logs → contagem, se houver demanda real.
