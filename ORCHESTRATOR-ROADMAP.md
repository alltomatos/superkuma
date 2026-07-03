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

### EPIC-3 — Camada de validação de entrada (P2 · T2 · 🟡)
Introduzir validação de payloads de socket/HTTP (ex: zod) para eliminar parsing manual disperso.

### EPIC-4 — Robustez de testes (P4 · T2 · 🟡) — ✅ CONCLUÍDA (2026-07-03)
Cobrir o núcleo hoje sem testes diretos (`monitor.js`, models), elevar baseline via `/tdd`.
- +74 testes: `test-http.js` (10, fecha GAP-009: maxRedirects + keyword-inversion), `test-util-server-tls.js` (31), `test-util-server-misc.js` (20), `test-database-submodules.js` (13).
- Suíte não-Docker: **185 → 259 testes**, todos verdes. commits `57fcff7a` + `8ac0ea1e`.

### EPIC-5 — Higiene e performance (P3/P4 · T1-T2 · 🟢)
Lazy-load de monitor-types/providers, model para tabelas `stat_*`, limpeza de patches SQL legados, tipagem progressiva.

---

## Ordem sugerida (atualizada 2026-07-03)

1. ✅ **Governança + documentação de domínio** (CONTEXT.md, ADRs) — concluída.
2. ✅ **EPIC-2 — quebra de monólitos** — concluída.
3. ✅ **EPIC-4 — testes** do que foi extraído — concluída.
4. ▶️ **EPIC-3 — validação** (zod) sobre a estrutura já limpa — próxima.
5. **EPIC-1 — cifragem de segredos**: adiada por [ADR-0007](docs/adr/0007-defer-secret-encryption.md).

> Refactor sem testes novos (decisão do usuário) → a salvaguarda é: **extração mecânica pura + suíte existente + lint + build como gate**, em worktree isolada. Os alvos 🔴 sem rede (`monitor.js`, `EditMonitor.vue`) exigem decisão explícita de salvaguarda antes de executar.
