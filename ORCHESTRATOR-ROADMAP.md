# ORCHESTRATOR ROADMAP — Uptime Kuma (fork alltomatos)

> Direção estratégica e Epics. Consultado por qualquer skill de planejamento.
> Fork privado — **sem PR para o upstream `louislam/uptime-kuma`**. Respeitar a política anti-AI-slop de `CLAUDE.md`/`AGENTS.md`: mudanças grandes exigem revisão humana + teste manual antes de qualquer push.

**Atualizado em:** 2026-07-03
**Baseline:** v2.4.0 · ~63,7k LOC · 193 arq. backend · 185 frontend

---

## Norte

Padronizar e endurecer o fork sem quebrar comportamento, priorizando **segurança de segredos** e **quebra de monólitos** para testabilidade, com execução **tier-gated** (aprovação por item nos T3).

---

## Epics (derivadas dos GAPs da Fase 3)

### EPIC-1 — Segurança de segredos e sessão (P1 · T3 · 🔴 bloqueante)
Cifrar credenciais at rest (monitor/notificação/JWT secret), mascarar em respostas de API, e dar expiração/invalidação aos tokens JWT.
- Depende de decisão humana (mudança de schema + migration + auth).

### EPIC-2 — Quebra de monólitos (P2 · T2 · 🟡) — ✅ CONCLUÍDA (2026-07-03)
Objetivo: reduzir arquivos gigantes por **extração mecânica pura** (mover código + re-export, SEM mudança de comportamento). Rede de segurança = suíte existente + `npm run lint`. Refactor pesado → **worktree dedicada**.

DAG executada, ordenada por risco (menor → maior) — todas verificadas por agente independente com mutation-check:

| ID | Alvo | Antes → Depois | Status |
|---|---|---|---|
| TASK-100 | `util-server.js` | 1066 → 24 (7 submódulos + barrel) | ✅ commit fd6778ca |
| TASK-140 | `uptime-calculator.js` | 891 → 804 (time-bucket.js, stat-bean-repository.js) | ✅ commit 9c4c117d |
| TASK-130 | `database.js` | 1018 → 928 (paths.js, legacy-patches.js, dialect.js) | ✅ commit 2e875cab |
| TASK-110 | `server.js` | 2018 → 1324 (monitor-socket-handler.js, 721 LOC) | ✅ commit 05f93195 |
| TASK-105 | rede de caracterização | +19 testes backend (monitor.js) +3 E2E (EditMonitor.vue) | ✅ commits 65ac2586 + 6928ba3a |
| TASK-120 | `monitor.js` | 2069 → 1805 (extrai http/keyword/json-query → `monitor-types/http.js`, 278 LOC, ADR-0002) | ✅ commit d35248a0 |
| TASK-150 | `EditMonitor.vue` | 4356 → 4016 (HttpOptionsFields/TcpPortFields/PushUrlField.vue — só seções com E2E real) | ✅ commit d58c7832 |

**Fora de escopo desta rodada** (não atacados — candidatos a uma EPIC-2b futura, menor prioridade): `src/mixins/socket.js` (894, dividir em composables) e `StatusPage.vue`/`Details.vue`/`HeartbeatBar.vue`/`MonitorList.vue` (extrair seções). `ping`/`push`/`docker`/`radius`/`kafka-producer` também continuam inline em `monitor.js` (só http/keyword/json-query foi extraído, por escopo deliberadamente restrito).

**Achado durante TASK-120** (mutation-check independente, não é regressão desta refatoração): a suíte E2E não cobre `maxRedirects` nem inversão de keyword-match no monitor HTTP — registrado como GAP-009.

### EPIC-3 — Camada de validação de entrada (P2 · T2 · 🟡) — ✅ CONCLUÍDA (2026-07-03, escopo parcial deliberado)
Introduzir validação de payloads de socket/HTTP (zod) para eliminar parsing manual disperso.
- **Fase 1** (baixo risco, mecânico): `zod` instalado + `server/validation.js` (helper compartilhado) + `api-key` (keyID), tags de monitor (tagID/monitorID/value), `chart` (period), slug de status-page (7 rotas). commit `67d7e6d7`.
- **Fase 2** (médio risco, objetos pequenos): `proxy` (protocol lido de `Proxy.SUPPORTED_PROXY_PROTOCOLS`, não hardcoded), `docker` (socket|tcp, schema mais leve pro botão "Test"), `remote-browser` (url — confirmado que `z.string().url()` aceita `ws://`, não só http/https), `cloudflared` (token). commit `76717066`.
- **Fora de escopo, deliberado:** `monitor.add`/`editMonitor` (união discriminada de 24+ tipos, 40+ campos) e `status-page` `saveStatusPage`/`postIncident` — os itens de maior severidade no mapa de risco, mas também os mais complexos; validar mal ali arrisca rejeitar configs legítimas de tipos obscuros. Candidatos a uma **EPIC-3b** futura, com mais tempo dedicado ao mapeamento por tipo de monitor.
- Nota de precisão: os handlers desta rodada já usavam queries parametrizadas — o ganho é defesa em profundidade (rejeição precoce e clara), não correção de uma injeção de SQL ativa.
- Verificação: cada fase testou tanto **rejeição** (payload malformado) quanto **aceitação** (payload realista extraído dos componentes Vue reais) — para não deixar passar nem uma validação fraca demais nem uma rígida demais.

### EPIC-4 — Robustez de testes (P4 · T2 · 🟡) — ✅ CONCLUÍDA (2026-07-03)
Cobrir o núcleo hoje sem testes diretos (`monitor.js`, models), elevar baseline via `/tdd`.
- +74 testes: `test-http.js` (10, fecha GAP-009: maxRedirects + keyword-inversion), `test-util-server-tls.js` (31), `test-util-server-misc.js` (20), `test-database-submodules.js` (13).
- Suíte não-Docker: **185 → 259 testes**, todos verdes. commits `57fcff7a` + `8ac0ea1e`.

### EPIC-5 — Higiene e performance (P3/P4 · T1-T2 · 🟢)
Lazy-load de monitor-types/providers, model para tabelas `stat_*`, limpeza de patches SQL legados, tipagem progressiva.

---

## 🌐 Feature: Master-Agent (Federação) — em planejamento (T3)

> Design: [ADR-0008](docs/adr/0008-master-agent-federation.md) · [PRD](docs/prd/master-agent.md).
> Decisões do usuário (2026-07-03): transporte **faseado (REST MVP → Socket.io v2)**; notificação **configurável (master/agent/both)**; Master **híbrido** (agrega + monitora local).

Modelo Master-Agent para agregar N instâncias de clientes num painel central com notificação imediata. Insight central: monitor remoto = linha `monitor` com `remote_instance_id`, alimentado como `push` → reusa todo o pipeline existente.

| Epic | Entrega | Tier | Status |
|---|---|---|---|
| **F0** Fundação | migration `remote_instance` + `monitor.remote_instance_id` + model + setting `federation.role` | T3 | ✅ concluída — commit `9641dbc3` |
| **F1** Receptor Master (MVP) | registro `remote_instance` + `POST /api/federation/heartbeat` + espelhamento idempotente (`type=push`) | T2 | ✅ concluída — commit `2e99ae72` |
| **F2** Forwarder Agent (MVP) | `agent-forwarder.js` resiliente + hook mínimo (5 linhas) em `monitor.js` | T2 | ✅ concluída — commit `5d6cdecb` |
| **F3** UI unificada | badge de instância, agrupamento no dashboard, página de config | T2 | ▶️ destravada |
| **F4** Federação Socket.io (v2) | `agent-client.js` persistente + keepalive + detecção "agente caiu" | T3 | ⏸ bloqueada por F2 |
| **F5** Robustez | buffering offline, versionamento de protocolo, notificação configurável, sync rename/delete | T2 | ⏸ bloqueada por F3/F4 |

Salvaguarda transversal: o modo `standalone` (default) deve permanecer **sem regressão** — suítes backend (259) e E2E (26) como gate em toda fase.

### 📈 Trilha paralela: Histórico de métricas de longo prazo (EPIC-M)

> Design: [ADR-0009](docs/adr/0009-master-long-term-metrics-history.md). Decisões do usuário: foco em **histórico de métricas** (não event-log), escala **média**, **desenhar antes da fundação**.
> Objetivo: relatório de SLA por cliente com histórico multi-ano barato, reusando a fundação da F0 (join `stat_* → monitor → remote_instance`).

| Epic | Entrega | Tier | Status |
|---|---|---|---|
| **M0** Fundação métricas | models para `stat_*` (fecha GAP-005) + tabela `stat_monthly` + settings de retenção em camadas | T3 | ✅ concluída — commit `9641dbc3` |
| **M1** Agregação mensal + retenção | `UptimeCalculator` grava/rola o tier mensal; job de limpeza honra as camadas | T2 | ✅ concluída — commit `18b63a41` (read-side "month" adiado p/ M2) |
| **M2** Relatório de SLA por cliente | UI de relatório por `remote_instance`, exportável | T2 | ⏸ bloqueada por F3 |

**Sequenciamento acordado:** a **Fase Fundação** executa **F0 + M0 juntas** (uma migration por concern, landando na mesma fatia), pois tocamos o schema uma vez e M0 depende de MariaDB/estrutura que a F0 também assume. MariaDB passa a ser **recomendado no Master**.

---

## Ordem sugerida (atualizada 2026-07-03)

1. ✅ **Governança + documentação de domínio** (CONTEXT.md, ADRs) — concluída.
2. ✅ **EPIC-2 — quebra de monólitos** — concluída.
3. ✅ **EPIC-4 — testes** do que foi extraído — concluída.
4. ✅ **EPIC-3 — validação** (zod) — concluída (escopo parcial deliberado; ver EPIC-3b acima).
5. ⏸ **EPIC-1 — cifragem de segredos**: adiada por [ADR-0007](docs/adr/0007-defer-secret-encryption.md). É a única Epic do roadmap original que resta.

> Refactor sem testes novos (decisão do usuário) → a salvaguarda é: **extração mecânica pura + suíte existente + lint + build como gate**, em worktree isolada. Os alvos 🔴 sem rede (`monitor.js`, `EditMonitor.vue`) exigem decisão explícita de salvaguarda antes de executar.
