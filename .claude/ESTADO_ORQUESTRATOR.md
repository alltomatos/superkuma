# ESTADO_ORCHESTRATOR

> Cérebro da sessão do Orchestrator. Persiste progresso entre interações.
> **Regra**: ler ao iniciar, escrever ao fim de cada fase.

---

## Sessão

- **iniciado_em**: `2026-07-03`
- **fase_atual**: `Fase 4` (Fragmentação/Delegação — tier-gated)
- **repositorio**: `alltomatos/uptime-kuma` (fork privado, sem PR upstream)
- **branch**: `chore/orchestrator-standardization`

---

## GAPs Identificados (Fase 3)

| # | ID | Dimensão | Sev | Descritivo | Tier | Status |
|---|----|----------|-----|------------|------|--------|
| 1 | `GAP-001` | Segurança | P1 | Segredos em texto plano at rest (creds de monitor/notificação, JWT secret) | T3 | 🔵 deferred → ADR-0007 |
| 2 | `GAP-002` | Segurança | P1 | JWT sem expiração; troca de senha não invalida tokens | T3 | 🔴 open |
| 3 | `GAP-003` | Arquitetura | P2 | Monólitos god-object (monitor.js 2069, server.js 2018, EditMonitor.vue 4356, util-server.js 1066…) | T2 | 🟡 queued |
| 4 | `GAP-004` | Arquitetura | P2 | Sem camada de validação de entrada (parsing manual em sockets/routers) | T2 | 🟡 queued |
| 5 | `GAP-005` | Performance | P3 | Import eager de 24 monitor-types + 96 providers; tabelas `stat_*` sem model | T2 | 🟡 queued |
| 6 | `GAP-006` | Testes | P4 | Cobertura ~14%; `monitor.js` e models sem teste unitário direto | T2 | 🟡 queued |
| 7 | `GAP-007` | Higiene | P4 | Backend sem tipos (só JSDoc); 108 patches SQL legados; CLAUDE/AGENTS haviam sido esvaziados | T1 | 🟢 partial |
| 8 | `GAP-008` | Segurança | P1-low | timing-enum no login; `verifyAPIKey` sem `user_id`; `setup` sem rate-limit | T2 | 🟡 queued |

---

## Tarefas (Fase 4 — Fila DAG)

### Concluídas (governança — T1, aditivo)

```yaml
- id: TASK-000
  desc: "Restaurar política anti-AI-slop esvaziada (CLAUDE.md/AGENTS.md)"
  gap_ref: GAP-007
  status: done
  concluido_em: "2026-07-03"

- id: TASK-001
  desc: "Criar branch chore/orchestrator-standardization"
  status: done
  concluido_em: "2026-07-03"

- id: TASK-002
  desc: "Provisionar .claude/config.json + .claude/context7.json"
  status: done
  concluido_em: "2026-07-03"

- id: TASK-003
  desc: "Provisionar docs/agents/ (domain, issue-tracker, triage-labels)"
  skill: /setup-skills
  status: done
  concluido_em: "2026-07-03"

- id: TASK-004
  desc: "Criar ORCHESTRATOR-ROADMAP.md + ESTADO_ORQUESTRATOR.md"
  status: done
  concluido_em: "2026-07-03"

- id: TASK-010
  desc: "Baseline: lint + tsc + test-backend"
  gap_ref: GAP-006
  status: done
  concluido_em: "2026-07-03"

- id: TASK-050
  desc: "Documentação de domínio: CONTEXT.md + docs/adr/ (7 ADRs fundacionais + template)"
  skill: /grill-with-docs
  status: done
  concluido_em: "2026-07-03"
```

### Baseline (TASK-010 — 2026-07-03)

| Comando | Resultado | Nota |
|---|---|---|
| `npm run lint:js` | ✅ PASS (exit 0) | 0 errors, 72 warnings (selectors CSS não-usados, JSDoc) |
| `npm run tsc` | ❌ FAIL (exit 2) | **Toolchain**, não código: `typescript ~4.4.4` não parseia `.d.ts` do `@types/node@22`. Não está no pipeline `npm test`. Pré-existente → GAP-007. |
| `test-backend` (subset s/ Docker, 23 arq.) | ✅ PASS **166/166** | Docker daemon down → 8 arquivos com testcontainers pulados (DB monitors + migration + snmp) |

> Rede de segurança verde estabelecida para os testes unitários puros. Para rodar os 8 de container, subir o Docker Desktop.

### Pendentes (código — AGUARDANDO "GO" por item)

```yaml
- id: TASK-020
  desc: "EPIC-4: testes unitários para monitor.js (serialização toJSON, determineStatus)"
  skill: /tdd
  gap_ref: GAP-006
  depends_on: [TASK-010]
  status: ready   # destravada — baseline verde

- id: TASK-030
  desc: "EPIC-3: introduzir validação (zod) em socket-handlers e routers"
  skill: /improve-codebase-architecture
  gap_ref: GAP-004
  depends_on: [TASK-010]
  status: ready   # destravada — baseline verde

- id: TASK-040
  desc: "EPIC-2: extrair lógica de check por protocolo de monitor.js para monitor-types/"
  skill: /improve-codebase-architecture
  gap_ref: GAP-003
  depends_on: [TASK-020]
  status: blocked   # worktree dedicada (refactor pesado)

- id: TASK-090
  desc: "EPIC-1: cifrar segredos at rest + migration + mascaramento API"
  gap_ref: GAP-001
  depends_on: [TASK-010]
  status: deferred   # decisão registrada em docs/adr/0007-defer-secret-encryption.md — reavaliar se multi-tenant/compliance
```

---

## Log de Ações Auto-Aplicáveis (Tier T1)

| # | Data | GAP | Ação | Resultado |
|---|------|-----|------|-----------|
| 1 | 2026-07-03 | GAP-007 | Restaurar CLAUDE.md/AGENTS.md ao commit | 2370 bytes cada, `git status` limpo nesses arquivos |
| 2 | 2026-07-03 | — | Provisionar governança (.claude/, docs/agents/, roadmap) | Aditivo, sem tocar em código-fonte |

---

## Pendências / Notas

- `package-lock.json` tem alteração local não relacionada (remoção de campos `libc` em deps opcionais do rollup) — provável artefato de `npm install`. Não revertido; decidir se restaura.
- Próximo "Go" recomendado: **TASK-010** (baseline verde de lint/tsc/testes) antes de qualquer refactor.
