# Análise: o que aproveitar do SigNoz no SuperKuma

> Relatório de inteligência competitiva / oportunidades de feature.
> Fonte: [github.com/signoz/signoz](https://github.com/signoz/signoz) + docs oficiais (alertas, anomalia, canais de notificação).
> Data: 2026-07-09 · Baseline SuperKuma: v2.4.0.
> **Status: rascunho para decisão — nenhuma mudança de código foi feita.**

---

## 1. Sumário executivo

O SigNoz é uma **plataforma de observabilidade** (APM + traces + logs + métricas) em **Go + ClickHouse + OpenTelemetry**. O SuperKuma é um **monitor de disponibilidade black-box** (Vue + Node + Socket.io + SQLite/MariaDB) que faz *active check* (poll por intervalo) e recebe *heartbeats* push.

**São paradigmas diferentes:** SigNoz é *white-box* (telemetria de dentro da aplicação instrumentada); SuperKuma é *black-box* ("está no ar?"). Consequência direta: **reuso de código ≈ 0** (linguagem, storage e modelo de dados incompatíveis). O valor está em **inspiração de features** — capacidades que o SigNoz tem e que encaixam no pipeline e no roadmap que o SuperKuma já possui.

Três apostas se destacam por já terem "gancho" na base atual:

1. **Alertas por anomalia** (z-score sazonal) — encaixa na EPIC-M (histórico de métricas de longo prazo).
2. **Severidade + roteamento de alertas + janelas de manutenção** — enriquece o modelo de notificação atual (hoje é "anexa notificação X ao monitor Y", sem severidade nem roteamento).
3. **Threshold com "for duration" (debounce)** — extensão pequena e direta do monitor `prometheus.js` que já existe.

> **Arquitetura de referência** (as três apostas + o receptor OTLP num só eixo): [diagrams/arquitetura-nucleo-adaptadores.svg](diagrams/arquitetura-nucleo-adaptadores.svg) — *um núcleo de avaliação, N adaptadores de ingestão*.

---

## 2. SigNoz num relance

| Dimensão | SigNoz |
| --- | --- |
| Categoria | Observabilidade full-stack (APM/traces/logs/métricas) |
| Stack | Go (backend), TypeScript/React (front), ClickHouse (storage colunar), OpenTelemetry (ingestão) |
| Sinais | Traces distribuídos (flamegraph/waterfall), logs, métricas, exceptions, infra (k8s/host), LLM/AI observability |
| Alertas | 5 tipos: métrica, log, trace, exception, **anomalia** · severidade (warning/critical) · labels · **routing policies** · **janelas de manutenção** · REST API + **Terraform provider** |
| Anomalia | Decomposição sazonal: `moving_avg(passado) + avg(estação atual) − mean(estações passadas)`; score = `|real − previsto| / desvio_padrão`; dispara se score > z-threshold (2.0–4.0) |
| Notificação | Slack, PagerDuty, Opsgenie, MS Teams, Email, Webhook, Incident.io, Rootly, Zenduty (~9 canais) |
| Dashboards | Customizáveis via **Query Builder** visual, PromQL ou ClickHouse SQL |
| Deploy | Cloud, Docker, Kubernetes, self-hosted; pricing usage-based |

---

## 3. Oportunidades priorizadas

Legenda de esforço: **S** (dias) · **M** (1–2 semanas) · **L** (semanas). Tier conforme `CLAUDE.md` §7.

### 🟢 P1 — Alto valor, gancho já existe na base

#### P1.1 — Alertas por anomalia (z-score sazonal) · Tier T2/T3 · Esforço M
- **No SigNoz:** prevê o valor esperado por decomposição sazonal (hora/dia/semana) e dispara quando o valor real desvia N desvios-padrão do previsto. Parâmetros: métrica, janela de avaliação (5min–1dia), sazonalidade, z-threshold, condição (acima/abaixo), frequência, lógica de ocorrência ("ao menos uma vez" / "sempre").
- **Encaixe no SuperKuma:** hoje o alerta é binário (UP/DOWN) + no máximo threshold de tempo de resposta. A **EPIC-M já produz histórico de métricas multi-ano** (`stat_*`, `stat_monthly`, `uptime-calculator.js`). Um detector que lê essa série e alerta em "tempo de resposta fora do baseline sazonal" é uma feature genuinamente nova para o mundo Uptime Kuma e altamente diferenciadora.
- **Como começar (MVP enxuto):** média móvel + banda de ±Nσ sobre a série de `ping` já persistida, sem sazonalidade; sazonalidade hora/dia numa segunda fase. Evita ClickHouse — roda sobre o que já está no SQLite/MariaDB.
- **Dependências:** EPIC-M (M1 concluída). Decisão de schema (novo tipo de condição de alerta) → provável T3.

#### P1.2 — Severidade + roteamento + labels de alerta · Tier T2/T3 · Esforço M
- **No SigNoz:** cada alerta tem severidade (`warning`/`critical`) + labels; *routing policies* mandam para canais diferentes conforme label/severidade.
- **Encaixe no SuperKuma:** o modelo atual anexa notificações ao monitor sem severidade nem roteamento. Adicionar (a) **severidade por monitor/condição**, (b) **tags/labels** (já há tags de monitor), e (c) **regra de roteamento** "label/severidade → canal" transforma ~90 providers num sistema de escalonamento de verdade. Sinergia forte com a **feature Multi-tenant/Teams** (roteamento por team).
- **Dependências:** toca schema de notificação → T3. Combina bem com o RBAC (P3 do multi-tenant).

#### P1.3 — Threshold com "for duration" / debounce · Tier T2 · Esforço S
- **No SigNoz:** avalia condição sobre uma janela e só dispara se sustentada ("every time" no período), evitando alarme por spike isolado.
- **Encaixe no SuperKuma:** o `server/monitor-types/prometheus.js` **já existe** e compara PromQL contra threshold, mas dispara na hora. Adicionar "condição precisa se manter por X checagens/minutos antes de virar DOWN" reduz ruído e é uma mudança pequena, localizada e testável (T2). Aplicável também a outros tipos com valor numérico.
- **Dependências:** nenhuma bloqueante. Melhor candidato para uma primeira entrega rápida.

### 🟡 P2 — Valor claro, esforço maior ou depende de roadmap

#### P2.1 — SLO / error-budget no relatório de SLA · Tier T2 · Esforço M
- **No SigNoz:** enquadra confiabilidade como SLO com *error budget* (orçamento de erro) e burn-rate, não só "% de uptime".
- **Encaixe no SuperKuma:** a **EPIC-M / M2 já mira "relatório de SLA por cliente"**. Emprestar o enquadramento de SLO (alvo %, orçamento consumido, orçamento restante, burn-rate) deixa o relatório muito mais rico que um número plano de uptime. Feeds diretos: join `stat_* → monitor → remote_instance` já desenhado na F0.
- **Dependências:** M2 (bloqueada por F3 da federação).

#### P2.2 — Janelas de manutenção "estilo SigNoz" · Tier T2 · Esforço S/M
- **No SigNoz:** *planned maintenance windows* silenciam alertas durante downtime programado, com recorrência.
- **Encaixe no SuperKuma:** o Uptime Kuma já tem manutenção; vale **auditar a paridade** e, se faltar, adicionar recorrência/escopo por team e supressão de notificação (não só de UI). Verificar antes de implementar — pode já estar 80% coberto.
- **Dependências:** confirmar estado atual da feature de manutenção no fork.

#### P2.3 — Dashboards customizáveis (multi-monitor) · Tier T2 · Esforço L
- **No SigNoz:** dashboards montados por Query Builder visual, múltiplos painéis/visualizações.
- **Encaixe no SuperKuma:** hoje há status pages + gráfico por monitor. Um dashboard que combina séries de vários monitores (uptime/latência) com escolha de visualização seria um avanço de UI e casa com o histórico de longo prazo (EPIC-M). Escopo grande, front-heavy — fatiar bem.
- **Dependências:** EPIC-M para dados; boa candidata a worktree isolada.

### 🔵 P3 — Ambicioso / ponte de paradigma (avaliar depois)

#### P3.1 — Receptor OTLP como *tipo de monitor push* · Tier T3 · Esforço L
> Desenho detalhado: [ADR-0015](adr/0015-otlp-telemetry-receiver.md).
- **No SigNoz:** ingestão nativa via OpenTelemetry (OTLP).
- **Encaixe no SuperKuma:** o SuperKuma já tem monitor **push** (agentes fazem POST de heartbeat) e a **federação Master-Agent**. Um receptor OTLP/metrics *leve* deixaria o SuperKuma consumir métricas que coletores OTel externos já produzem, virando heartbeat/threshold — mesma lógica do `prometheus.js`, porém push. **Ressalva honesta:** só métricas; traces/logs em escala exigiriam ClickHouse e estão **fora de escopo**.
- **Dependências:** decisão de arquitetura de ingestão → T3.

#### P3.2 — Monitores/alertas como código (REST API + Terraform) · Tier T3 · Esforço M/L
- **No SigNoz:** REST API para regras + provider Terraform (observability-as-code).
- **Encaixe no SuperKuma:** já existe sistema de API key. Uma API REST documentada para CRUD de monitor + um provider Terraform pequeno seria um diferencial forte para a direção **multi-tenant/federação** (gerenciar N instâncias de clientes por código). Alinha com o objetivo Master-Agent.
- **Dependências:** estabilidade da API multi-tenant.

---

## 4. O que NÃO faz sentido portar (para gerenciar expectativa)

| Feature SigNoz | Por que não | 
| --- | --- |
| Tracing distribuído / flamegraph / APM / service map | Exige instrumentação da app + storage colunar; foge do escopo black-box do SuperKuma. |
| Gestão de logs em escala | Precisa de ClickHouse; modelo de dados incompatível com redbean/Knex. |
| LLM/AI observability | Fora do domínio de disponibilidade. |
| Trocar storage para ClickHouse | Non-goal explícito; SuperKuma é SQLite/MariaDB/MySQL/Postgres via Knex. |
| Reuso direto de código Go/React do SigNoz | Linguagens e arquiteturas diferentes — no máximo referência conceitual. |

---

## 5. Onde o SuperKuma já está à frente (não copiar, capitalizar)

- **Largura de canais de notificação:** ~90 providers (`server/notification-providers/`) vs ~9 do SigNoz. O SuperKuma é *muito* mais rico aqui — o trabalho é **roteamento/severidade** (P1.2), não mais canais.
- **Simplicidade self-hosted:** roda em SQLite sem dependência de ClickHouse/OTel-collector — barreira de entrada muito menor.
- **Diversidade de tipos de monitor black-box:** DNS, TCP, gRPC, MQTT, RabbitMQ, SNMP, Steam, bancos (mssql/mysql/postgres/mongo/oracle/redis), browser real, etc. — cobertura de *synthetic checks* que o SigNoz não tem.
- **Federação Master-Agent + multi-tenant** em curso — direção que o SigNoz endereça só via Cloud/BYOC.

---

## 6. Recomendação

Sequência sugerida, do menor risco ao maior:

1. **P1.3 (debounce/for-duration)** — entrega rápida (T2, esforço S), estende `prometheus.js`, ganho imediato de redução de ruído. Bom "primeiro passo" para validar apetite.
2. **P1.1 (anomalia z-score)** — a aposta diferenciadora; MVP sem sazonalidade sobre `stat_*`, evoluindo para sazonal. Depende de decisão T3 de schema de condição.
3. **P1.2 (severidade + roteamento)** — casa com o multi-tenant já em execução; planejar junto do RBAC.
4. **P2.1 (SLO/error-budget)** — incorporar ao desenho do relatório de SLA (M2) antes de codar M2.

Tudo isso respeita a política de tiers do `CLAUDE.md`: T2 executa sob rede de testes; itens que tocam schema/auth/arquitetura (P1.1 condição nova, P1.2 schema de notificação, P3.x) **param e pedem "Go" humano**.

**Próximo passo concreto sugerido:** transformar P1.3 e P1.1 em ADRs/PRDs (via skill `/grill-with-docs` ou `/to-prd`) para amarrar o desenho antes de qualquer código.
