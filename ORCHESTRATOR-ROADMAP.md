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

### EPIC-2 — Quebra de monólitos (P2 · T2 · 🟡)
Extrair responsabilidades de `monitor.js` (2069), `server.js` (2018), `EditMonitor.vue` (4356), `util-server.js` (1066), `database.js` (1018), mixin `socket.js` (894). Objetivo: SRP + testabilidade, sem mudança de comportamento.

### EPIC-3 — Camada de validação de entrada (P2 · T2 · 🟡)
Introduzir validação de payloads de socket/HTTP (ex: zod) para eliminar parsing manual disperso.

### EPIC-4 — Robustez de testes (P4 · T2 · 🟡)
Cobrir o núcleo hoje sem testes diretos (`monitor.js`, models), elevar baseline via `/tdd`.

### EPIC-5 — Higiene e performance (P3/P4 · T1-T2 · 🟢)
Lazy-load de monitor-types/providers, model para tabelas `stat_*`, limpeza de patches SQL legados, tipagem progressiva.

---

## Ordem sugerida

1. **Governança** (esta sessão — concluída) → baseline de padrão.
2. **EPIC-4 / EPIC-5 (itens T1-T2)** → ganhos seguros, criam rede de testes.
3. **EPIC-2 / EPIC-3** → refactor sob rede de testes.
4. **EPIC-1** → só com "Go" explícito (T3), em worktree dedicada, com migration reversível.

> Nenhuma delegação de código ocorre sem o item correspondente aprovado aqui e registrado em `.claude/ESTADO_ORQUESTRATOR.md`.
