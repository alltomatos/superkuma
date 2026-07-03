# ADR-0006: Estado do frontend via mixins globais (sem Vuex/Pinia)

- **Status:** Accepted (documenta o existente) — sob revisão
- **Data:** 2026-07-03

## Contexto

O SPA Vue 3 precisa de estado global (lista de monitores, heartbeats, sessão, listas de notificação/proxy/etc.) compartilhado entre muitas telas, alimentado por Socket.io.

## Decisão

O estado global vive em **mixins globais** (`src/mixins/`), principalmente `socket.js` (~894 linhas), que concentra conexão, auth, fetch, estado e computed. Não há Vuex nem Pinia.

## Consequências

- (+) Simples de plugar; sem dependência de store adicional.
- (−) `socket.js` é um **god-mixin**: mistura conexão, auth, dados e UI — difícil de testar e navegar (GAP-003).
- (−) Sem árvore reativa explícita nem devtools de store.
- ➜ **Sob revisão**: migração incremental para Pinia (ou stores por composição) é candidata futura; registrar novo ADR se decidida.

## Alternativas consideradas

- Pinia: melhor testabilidade, mas exige refactor amplo — adiado.
