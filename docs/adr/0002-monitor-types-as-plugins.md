# ADR-0002: Tipos de monitor como plugins (strategy)

- **Status:** Accepted (documenta o existente)
- **Data:** 2026-07-03

## Contexto

Existem 24+ formas de verificar um alvo (http, ping, dns, tcp, postgres, mqtt, grpc, redis, mongodb, snmp, gamedig, globalping, …) e a lista cresce a cada release. Concentrar tudo num só lugar seria insustentável.

## Decisão

Cada tipo é uma classe em `server/monitor-types/` que estende `MonitorType` e implementa `async check(monitor, heartbeat, server)`. Os tipos são registrados em `UptimeKumaServer.monitorTypeList` no boot. Adicionar um tipo = adicionar um arquivo + registrar.

## Consequências

- (+) Extensível e isolado — um dos pontos mais fortes da arquitetura.
- (+) Testável por tipo (ver `test/backend-test/monitors/`).
- (−) **Duplicação**: cada tipo repete tratamento de erro e atribuição de `heartbeat.status`; a base class não implementa o fluxo comum erro→DOWN.
- (−) Lógica de check de HTTP ainda vive **inline em `monitor.js`** (não migrada para um plugin) — dívida a resolver (GAP-003).

## Alternativas consideradas

- `switch(type)` gigante em `monitor.js`: rejeitado por acoplamento.
