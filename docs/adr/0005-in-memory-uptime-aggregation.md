# ADR-0005: Agregação de uptime em memória com persistência periódica

- **Status:** Accepted (documenta o existente)
- **Data:** 2026-07-03

## Contexto

Calcular uptime (24h/30d/1a) e ping médio a cada leitura direto da tabela de heartbeats seria caro (varredura de muitas linhas por monitor a cada request).

## Decisão

`server/uptime-calculator.js` mantém, por monitor, **janelas móveis em memória** em três granularidades (minutely=24h, hourly=30d, daily=365d) e persiste os agregados nas tabelas `stat_minutely` / `stat_hourly` / `stat_daily`. Um job (`server/jobs/`) limpa dados antigos.

## Consequências

- (+) Leituras de uptime O(1) a partir dos buckets; escrita em lote.
- (−) Tabelas `stat_*` **não têm BeanModel** — acesso via `R.dispense` cru; campo `extras` (JSON) fracamente tipado (GAP-005).
- (−) Estado em memória + persistência acoplados no mesmo arquivo de 891 linhas (candidato a extração).

## Alternativas consideradas

- TSDB dedicado (InfluxDB/Prometheus): peso operacional demais para self-hosted single-binary.
- Agregar on-read via SQL: custo por request inaceitável.
