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
| 9 | `GAP-009` | Testes | P4 | E2E não cobre `maxRedirects` (segue redirect sem limite silenciosamente) nem inversão de keyword-match no monitor HTTP — achado por mutation-check independente durante TASK-120, não introduzido pelo refactor | T2 | 🟡 queued |

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
# EPIC-2 — quebra de monólitos (PRIORIDADE ATUAL: refactor antes de testes novos)
# Salvaguarda: extração mecânica pura + suíte existente + lint/build como gate, em worktree.

- id: TASK-100
  desc: "Split util-server.js (1066) -> server/util-server/ (7 submódulos) + barrel"
  gap_ref: GAP-003
  risco: BAIXO
  depends_on: []
  status: done   # 1066->24 LOC. Export idêntico, lint 0 err, testes verdes. commit fd6778ca
  concluido_em: "2026-07-03"

- id: TASK-140
  desc: "uptime-calculator.js (891): separar persistência da agregação"
  gap_ref: GAP-003
  risco: MEDIO
  depends_on: [TASK-100]
  status: done   # 891->804 (extração conservadora: time-bucket.js + stat-bean-repository.js). 18/18 testes, lint 0 err. commit 9c4c117d
  concluido_em: "2026-07-03"

- id: TASK-130
  desc: "database.js (1018): extraiu paths.js/legacy-patches.js/dialect.js"
  gap_ref: GAP-003
  risco: MEDIO
  depends_on: [TASK-100]
  status: done   # 1018->928. Verificado por agente independente: escopo ok, lint 0, test-domain 16/16 (via mock-testdb), smoke ok. commit 2e875cab
  concluido_em: "2026-07-03"

- id: TASK-110
  desc: "server.js (2018): extraiu monitor CRUD/tags -> socket-handlers/monitor-socket-handler.js"
  gap_ref: GAP-003
  risco: MEDIO
  depends_on: [TASK-100]
  status: done   # 2018->1324 (novo handler 721 LOC). Verificado por agente independente: 86/86 eventos socket idênticos, 33 checkLogin() preservados, 10 handlers pré-existentes intactos, boot smoke ok, lint 0. commit 05f93195
  concluido_em: "2026-07-03"

- id: TASK-105
  desc: "Rede primeiro: testes de caracterização para monitor.js (toJSON/toPublicJSON) e EditMonitor.vue (E2E por tipo), com mutation-check obrigatório"
  gap_ref: GAP-003
  depends_on: []
  status: done   # via Workflow wf_60700241-a4a. backend: 19 testes (commit 65ac2586). e2e: +3 tipos, 26/26 suite (commit 6928ba3a). Ambos com mutation-check independente do verificador (não só do executor) confirmando que os testes têm dentes.
  concluido_em: "2026-07-03"

- id: TASK-120
  desc: "monitor.js (2069): extrair check HTTP -> monitor-types/http.js (ADR-0002)"
  gap_ref: GAP-003
  risco: ALTO
  depends_on: [TASK-110, TASK-105]
  status: done   # 2069->1805 (novo http.js, 278 LOC). Verificado: quirks (tlsInfo sombreado, cache oauthAccessToken) preservados, dispatch unificado c/ os 24 tipos. 184/184 backend + 26/26 e2e + mutation-check (maxRedirects) independente. commit d35248a0
  concluido_em: "2026-07-03"

- id: TASK-150
  desc: "EditMonitor.vue (4356): subcomponentes por tipo de monitor"
  gap_ref: GAP-003
  risco: ALTO
  depends_on: [TASK-105, TASK-120]
  status: done   # 4356->4016. Extraiu HttpOptionsFields.vue(302)/TcpPortFields.vue(86)/PushUrlField.vue(70) — só as seções com cobertura E2E real (escopo disciplinado). 26/26 e2e + mutation-check independente. commit d58c7832
  concluido_em: "2026-07-03"

- id: TASK-160
  desc: "src/mixins/socket.js (894): dividir em composables"
  gap_ref: GAP-003
  risco: MEDIO
  depends_on: []
  status: blocked

- id: TASK-020
  desc: "EPIC-4: testes unitários para as unidades extraídas (monitor.js, util-server, etc.)"
  skill: /tdd
  gap_ref: GAP-006
  depends_on: [TASK-100, TASK-110, TASK-120]   # reordenado: testes DEPOIS do refactor (decisão do usuário)
  status: blocked

- id: TASK-030
  desc: "EPIC-3: introduzir validação (zod) em socket-handlers e routers"
  skill: /improve-codebase-architecture
  gap_ref: GAP-004
  depends_on: [TASK-110]
  status: blocked

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
| 3 | 2026-07-03 | GAP-003 | TASK-100: split util-server.js (1066→24) em 7 submódulos | Export idêntico, lint 0 err, testes verdes, commit fd6778ca |
| 4 | 2026-07-03 | GAP-003 | TASK-140: split uptime-calculator.js (891→804) | 18/18 testes, lint 0 err, commit 9c4c117d |
| 5 | 2026-07-03 | GAP-003 | TASK-130: split database.js (1018→928) via workflow c/ verificador adversarial | test-domain 16/16, lint 0 err, commit 2e875cab |
| 6 | 2026-07-03 | GAP-003 | TASK-110: split server.js (2018→1324) via workflow c/ verificador adversarial | 86/86 eventos socket + 33 checkLogin preservados, lint 0 err, commit 05f93195 |
| 7 | 2026-07-03 | — | Consolidação final EPIC-2 (fase segura): suíte completa 166/166, lint 0 err | Rede de segurança íntegra após 4 refactors sequenciais |
| 8 | 2026-07-03 | GAP-003 | TASK-105: 19 testes characterization backend (monitor.js) + 3 novos E2E (EditMonitor.vue) | Mutation-check independente do verificador confirmou detecção real de regressão em ambos. commits 65ac2586 + 6928ba3a |
| 9 | 2026-07-03 | GAP-003 | TASK-120: extrai http/keyword/json-query de monitor.js -> monitor-types/http.js (2069→1805) | Preserva quirk tlsInfo sombreado + cache oauthAccessToken. 184/184 backend + 26/26 e2e. commit d35248a0 |
| 10 | 2026-07-03 | GAP-003 | TASK-150: split EditMonitor.vue (4356→4016), 3 subcomponentes só nas seções com cobertura E2E real | 26/26 e2e, mutation-check independente (auth_user) confirmou detecção real. commit d58c7832 |
| 11 | 2026-07-03 | — | Fix cosmético: comentário desatualizado em http.js ("bean.ping"→"heartbeat.ping"), achado pelo verificador do TASK-120 | T1 trivial |

---

## Pendências / Notas

- `package-lock.json` tem alteração local não relacionada (remoção de campos `libc` em deps opcionais do rollup) — provável artefato de `npm install`. Não revertido; decidir se restaura.
- **Descoberta (2026-07-03):** `npm run build` funciona neste ambiente (gera `dist/`) e o E2E Playwright é **totalmente viável** — após `npx playwright install chromium` (browser estava desatualizado: 1228 instalado vs 1084 esperado pelo playwright 1.39), suíte completa rodou **23/23 em 2.1min**. Isso eleva a confiança na rede de segurança do frontend para além de "só teórica".
- `check()` HTTP **não existe como método isolado** em `monitor.js` — a lógica fica embutida numa closure `beat()` dentro de `start(io)` (confirma o gap do ADR-0002). Por isso a caracterização de monitor.js foca em `toJSON`/`toPublicJSON` (isoláveis) em vez de tentar unit-testar o check em si.
