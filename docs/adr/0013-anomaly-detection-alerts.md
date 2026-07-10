# ADR-0013: Alertas por anomalia de tempo de resposta (z-score sazonal)

- **Status:** Proposed
- **Data:** 2026-07-09
- **Tier:** T3 (toca o pipeline de heartbeat/uptime + novo schema de condição) — exige "Go" humano.
- **Inspiração:** SigNoz (anomaly-based alerts). Ver [`docs/analise-signoz.md`](../analise-signoz.md) §3 (P1.1).

## Contexto

Hoje um alerta no SuperKuma nasce **exclusivamente** de uma transição de status do heartbeat (UP↔DOWN), decidida em `server/model/monitor.js` (`beat()` → `isImportantBeat` → `Monitor.sendNotification`). O único alerta "quantitativo" possível é threshold de tempo de resposta embutido em alguns tipos (ex.: o monitor faz `throw` e o beat vira DOWN). Ou seja: **"alerta" e "DOWN" são a mesma coisa** no modelo atual.

Isso deixa um ponto cego: um serviço pode estar **UP** mas com o tempo de resposta 5× acima do normal (degradação, saturação, vizinho barulhento). Um threshold fixo não resolve bem porque o "normal" varia por hora do dia e dia da semana — um limite que serve às 3h da manhã dispara falso-positivo no pico das 14h, e vice-versa.

O SigNoz ataca isso com **anomaly-based alerts**: prevê o valor esperado por decomposição sazonal e dispara quando o valor real desvia N desvios-padrão do previsto:

```
previsto = moving_avg(passado_recente) + avg(estação_atual) − mean(estações_passadas)
score    = |real − previsto| / desvio_padrão(estação_atual)
dispara se score > z_threshold   (típico 2.0–4.0)
```

Dois fatos da nossa base tornam isso viável **sem ClickHouse**:

1. **A série já existe.** `server/uptime-calculator.js` persiste tempo de resposta por bucket em `stat_minutely` (24h), `stat_hourly` (30d), `stat_daily` (365d) e `stat_monthly` (60mo) — cada bucket com `avgPing`/`minPing`/`maxPing`. `getDataArray(num, type)` já devolve a série pronta. A **EPIC-M** ampliou essa retenção de propósito.
2. **Há um ponto de saída de notificação** reusável (`Monitor.sendNotification`).

### A tensão central de design

O modelo de dados equaciona **alerta = heartbeat DOWN**. Uma anomalia de latência **não é downtime**: se a marcarmos como DOWN, ela **contamina o cálculo de uptime/SLA** (`up`/`down` em todos os tiers `stat_*`) — justamente a métrica que a EPIC-M quer entregar limpa por cliente. Logo, o alerta de anomalia **precisa notificar sem escrever DOWN**. Essa é a decisão arquitetural principal deste ADR.

## Decisão

Nós vamos introduzir **alertas por anomalia como um canal desacoplado do status UP/DOWN**, opt-in por monitor, começando pelo tempo de resposta.

**1. Métrica-alvo (v1):** tempo de resposta (`avgPing` por bucket), lido de `UptimeCalculator.getDataArray()`. Métrica única e já persistida; generalizável depois.

**2. Detecção em duas fases:**
- **Fase 1 (MVP, sem sazonalidade):** média móvel ± Nσ sobre as últimas `W` amostras do tier minutely/hourly. `previsto = mean(janela)`, `score = |real − previsto| / stddev(janela)`. Dispara se `score > z_threshold` e a janela tiver amostras suficientes (`W_min`). Simples, determinístico, testável.
- **Fase 2 (sazonal):** replica a fórmula do SigNoz comparando a mesma **hora-do-dia / dia-da-semana** entre períodos passados (lendo os tiers hourly/daily). Sazonalidade configurável: horária, diária, semanal.

**3. Alerta desacoplado do uptime (a decisão-chave):** a avaliação de anomalia **não altera `bean.status`** nem os contadores `up`/`down`. Ela roda **após** o cálculo normal do beat e, se disparar, emite uma **notificação de tipo `anomaly`** por um caminho próprio. O heartbeat continua UP; o SLA permanece intacto. Persistência do evento: tabela nova `alert_event` (migration Knex) — `monitor_id`, `type` (`anomaly`), `value`, `expected`, `score`, `severity`, `time`. Mantém o histórico de anomalias sem tocar em `heartbeat`/`stat_*`.

**4. Anti-ruído reusando o que já existe:** exigir persistência (`k` de `n` amostras anômalas, análogo ao "at least once / every time" do SigNoz) antes de notificar, e um cooldown por monitor para não floodar — espelhando a intenção do `resendInterval` atual.

**5. Configuração por monitor (opt-in):** campos novos (via migration): `anomaly_enabled`, `anomaly_metric` (v1: `response_time`), `anomaly_window`, `anomaly_z_threshold`, `anomaly_seasonality` (`none|hourly|daily|weekly`), `anomaly_direction` (`above|below|both`), `anomaly_severity`. UI: nova seção em `EditMonitor.vue` (front-heavy — fatiar).

**6. Integração com severidade/roteamento:** o campo `severity` do evento é o gancho para o roteamento de notificações descrito em `docs/analise-signoz.md` §3 (P1.2). Os dois ADRs são complementares.

## Consequências

- (+) Feature genuinamente nova para o mundo Uptime Kuma; diferenciador real, alavancando dados que a EPIC-M **já** coleta.
- (+) Uptime/SLA permanecem corretos por construção (anomalia nunca vira DOWN).
- (+) `alert_event` abre caminho para outros alertas quantitativos futuros (threshold sustentado, burn-rate de SLO) sem sobrecarregar `heartbeat`.
- (−) Introduz um **segundo conceito de "alerta"** no código, que hoje só conhece UP/DOWN — custo de complexidade e de documentação (mitigado por manter tudo em `alert_event` + um único ponto de avaliação).
- (−) Detecção estatística tem **falso-positivo/negativo**; exige tuning (z-threshold, janela) e bons defaults. Sazonalidade fina intradia é limitada pela retenção minutely (24h) — sazonalidade robusta usa hourly/daily.
- (−) Migration + campos novos + toque no caminho crítico do `beat()` = **T3**, com testes de caracterização antes (a EPIC-2/EPIC-4 deixaram rede em `monitor.js`).

## Alternativas consideradas

- **Marcar anomalia como DOWN (reusar o pipeline existente):** descartado — contamina uptime/SLA, o oposto do objetivo da EPIC-M.
- **Reusar o flat-status MAINTENANCE (conta como UP):** hack; sequestra semântica de manutenção e confunde a UI. Descartado.
- **Só threshold fixo configurável (sem estatística):** mais simples, mas reintroduz o problema do limite que não acompanha a sazonalidade — é o que o threshold atual já não resolve bem.
- **Delegar a um Prometheus/Alertmanager externo:** foge da proposta self-hosted "bateria inclusa"; o `prometheus.js` já é a ponte para quem tem esse stack. Anomalia nativa é para quem **não** quer montar observabilidade completa.
- **Persistir só em memória (sem `alert_event`):** perde histórico e auditoria; incompatível com o relatório por cliente da EPIC-M.

## Sequenciamento sugerido

1. Rede de caracterização em torno do ponto de avaliação no `beat()` (baseline verde).
2. Migration `alert_event` + campos `anomaly_*` (dark, feature OFF = byte-idêntico ao legado).
3. Detector Fase 1 (média móvel ± Nσ) como módulo puro e testável isolado da I/O — TDD.
4. Fiação no `beat()` (pós-status, sem tocar `up`/`down`) + caminho de notificação `anomaly`.
5. UI em `EditMonitor.vue`.
6. Fase 2 (sazonal) só depois da Fase 1 validada em produção com dados reais.
