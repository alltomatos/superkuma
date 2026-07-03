# ADR-0004: Socket.io como transporte primário; REST para o público

- **Status:** Accepted (documenta o existente)
- **Data:** 2026-07-03

## Contexto

O dashboard precisa de atualização em tempo real (heartbeats, status, uptime) para muitos monitores simultâneos. Já as páginas públicas e badges precisam ser cacheáveis e acessíveis sem sessão.

## Decisão

A área autenticada (dashboard, CRUD, settings) trafega por **Socket.io** — eventos como `heartbeat`, `monitorList`, `avgPing`, `uptime`. O que é público (status pages, badges, push, métricas Prometheus) usa **REST** em `server/routers/`. Autorização de socket via `checkLogin(socket)`.

## Consequências

- (+) Tempo real eficiente; UX reativa sem polling.
- (+) Superfície pública cacheável e isolada da sessão.
- (−) Handlers de socket embutidos em `server/server.js` (monólito, GAP-003) além de `server/socket-handlers/`.
- (−) Sem validação de schema nos payloads de socket (parsing manual, GAP-004).

## Alternativas consideradas

- REST + polling para tudo: pior latência e carga.
- SSE: unidirecional, insuficiente para o CRUD interativo.
