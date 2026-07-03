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

### EPIC-2 — Quebra de monólitos (P2 · T2 · 🟡) — **PRIORIDADE ATUAL**
Objetivo: reduzir arquivos gigantes por **extração mecânica pura** (mover código + re-export, SEM mudança de comportamento). Rede de segurança = suíte existente + `npm run lint`. Refactor pesado → **worktree dedicada**.

DAG ordenada por risco (menor → maior):

| ID | Alvo (LOC) | Extração | Risco | Rede de segurança |
|---|---|---|---|---|
| TASK-100 | `util-server.js` (1066) | → `server/util-server/` (network, tls/crypto, format) + barrel | 🟢 BAIXO | 5 testes (rodam sem Docker) + lint |
| TASK-140 | `uptime-calculator.js` (891) | separar persistência da agregação | 🟡 MÉDIO | `test-uptime-calculator.js` (500 LOC) |
| TASK-130 | `database.js` (1018) | connection / migration / dialect | 🟡 MÉDIO | testes de migration (exigem Docker) |
| TASK-110 | `server.js` (2018) | mover socket handlers embutidos → `server/socket-handlers/` | 🟡 MÉDIO | boot + suíte |
| TASK-120 | `monitor.js` (2069) | extrair check HTTP → `monitor-types/http.js` (ADR-0002) | 🔴 ALTO | **sem rede direta** → decidir salvaguarda |
| TASK-160 | `src/mixins/socket.js` (894) | dividir em composables | 🟡 MÉDIO | build frontend |
| TASK-150 | `EditMonitor.vue` (4356) | subcomponentes por tipo de monitor | 🔴 ALTO | E2E `monitor-form.spec` (app rodando) |
| TASK-170 | `StatusPage/Details/HeartbeatBar/MonitorList` | extrair seções/lógica | 🟡 MÉDIO | E2E `status-page.spec` |

### EPIC-3 — Camada de validação de entrada (P2 · T2 · 🟡)
Introduzir validação de payloads de socket/HTTP (ex: zod) para eliminar parsing manual disperso.

### EPIC-4 — Robustez de testes (P4 · T2 · 🟡)
Cobrir o núcleo hoje sem testes diretos (`monitor.js`, models), elevar baseline via `/tdd`.

### EPIC-5 — Higiene e performance (P3/P4 · T1-T2 · 🟢)
Lazy-load de monitor-types/providers, model para tabelas `stat_*`, limpeza de patches SQL legados, tipagem progressiva.

---

## Ordem sugerida (atualizada 2026-07-03)

1. ✅ **Governança + documentação de domínio** (CONTEXT.md, ADRs) — concluída.
2. ▶️ **EPIC-2 — quebra de monólitos** (decisão do usuário: refactor ANTES de testes novos). Extração mecânica pura, ordenada por risco (ver tabela acima), da mais segura para a mais arriscada.
3. **EPIC-4 — testes** do que foi extraído (agora em unidades pequenas e testáveis).
4. **EPIC-3 — validação** (zod) sobre a estrutura já limpa.
5. **EPIC-1 — cifragem de segredos**: adiada por [ADR-0007](docs/adr/0007-defer-secret-encryption.md).

> Refactor sem testes novos (decisão do usuário) → a salvaguarda é: **extração mecânica pura + suíte existente + lint + build como gate**, em worktree isolada. Os alvos 🔴 sem rede (`monitor.js`, `EditMonitor.vue`) exigem decisão explícita de salvaguarda antes de executar.
