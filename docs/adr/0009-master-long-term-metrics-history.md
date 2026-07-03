# ADR-0009: Histórico de métricas de longo prazo no Master (SLA multi-cliente)

- **Status:** Accepted (planejado — execução tier-gated, T3 no schema)
- **Data:** 2026-07-03
- **Relacionado:** [ADR-0008 (Master-Agent)](0008-master-agent-federation.md) · [ADR-0005 (agregação em memória)](0005-in-memory-uptime-aggregation.md) · [PRD](../prd/master-agent.md) · fecha parte do GAP-005

## Contexto

O Master (ver ADR-0008) agrega **dezenas de clientes** e precisa de **histórico longo de uptime/latência por cliente** para relatórios de SLA (contratos costumam exigir vários anos). Hoje o Uptime Kuma:

- Guarda **heartbeats brutos** (`heartbeat`) com retenção curta, limpos por [`server/jobs/clear-old-data.js`](../../server/jobs/clear-old-data.js).
- Compacta em 3 tiers via [`uptime-calculator.js`](../../server/uptime-calculator.js): `stat_minutely` (24h), `stat_hourly` (30d), `stat_daily` (365d).

Limites para o caso Master: `stat_daily` só cobre 365 dias, e o volume de dezenas de agentes pressiona o SQLite. As tabelas `stat_*` também não têm model (GAP-005), o que dificulta construir relatórios/arquival de forma sustentável.

Decisão do usuário: foco em **histórico de métricas** (não log de eventos), escala **média**, desenhar **antes** da fundação de schema.

## Decisão

1. **MariaDB no Master** (não SQLite) — já suportado pelo Uptime Kuma; adequado a dezenas de agentes com escrita concorrente e histórico longo.
2. **Retenção em camadas configurável**, separando dados frios dos operacionais: `heartbeat` (curto) < `stat_minutely` < `stat_hourly` < `stat_daily` < `stat_monthly` (longo). Cada tier com sua própria política.
3. **Novo tier `stat_monthly`** estendendo o `UptimeCalculator` — ~12 linhas/ano/monitor (custo desprezível), retenção longa (ex.: 5 anos) para SLA multi-ano barato.
4. **Models para as tabelas `stat_*`** (fecha GAP-005) — pré-requisito para relatórios e arquival sustentáveis, em vez de `R.dispense` cru.
5. **Relatório de SLA por cliente reusa a F0**: como monitores remotos são linhas `monitor` com `remote_instance_id` e os `stat_*` são chaveados por `monitor_id`, o relatório por instância é um join `stat_* → monitor → remote_instance`. **Nenhuma FK nova** necessária — a fundação da F0 já habilita isso.
6. **Separação física de arquivo (A2) como evolução opcional**: se o volume um dia exigir, mover `stat_daily`/`stat_monthly` frios para um schema/DB de arquivo. Forward-compatible; **não** implementado agora (o `database.js` é single-connection; multi-conexão seria mais ops do que valor na escala média).

## Consequências

- (+) Histórico multi-ano barato (tier mensal) e relatório de SLA por cliente.
- (+) Fecha GAP-005 (models de `stat_*`), beneficiando também o modo standalone.
- (+) Reusa a fundação da F0 sem schema extra para a consulta por cliente.
- (−) **MariaDB vira requisito recomendado no Master** (SQLite fica só para standalone pequeno).
- (−) Novo tier de agregação toca o `uptime-calculator.js` — arquivo já refatorado nesta sessão e com teste (`test-uptime-calculator.js`, 18 casos), o que reduz o risco.
- (−) Retenção em camadas adiciona configs e lógica no job de limpeza.

## Alternativas consideradas

- **Só estender a retenção do `stat_daily`** (sem tier mensal): mais simples, mas `daily × anos` cresce mais que o mensal; aceitável como MVP, porém o tier mensal é bem mais enxuto para o longo prazo.
- **TSDB dedicado (InfluxDB/Timescale/VictoriaMetrics)**: melhor para escala grande (centenas+), mas overkill para média e exige reescrita grande (o redbean é relacional). Descartado agora.
- **Segunda conexão de DB de arquivo (A2b)**: separação física real, mas o `database.js` single-connection tornaria isso custoso; adiado como evolução (ponto 6).
