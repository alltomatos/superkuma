# ESTADO_ORCHESTRATOR

> Cérebro da sessão do Orchestrator. Persiste progresso entre interações.
> **Regra**: ler ao iniciar, escrever ao fim de cada fase.

---

## Sessão

- **iniciado_em**: `2026-07-03`
- **fase_atual**: `Fase 4` (Fragmentação/Delegação — tier-gated)
- **repositorio**: `alltomatos/uptime-kuma` (fork privado, sem PR upstream)
- **branch**: `chore/rebrand-superkuma` (criada a partir de `develop`; `chore/orchestrator-standardization` foi integrada na `develop` e seu PR fechado — ver seção "Rebrand SuperKuma")

---

## GAPs Identificados (Fase 3)

| # | ID | Dimensão | Sev | Descritivo | Tier | Status |
|---|----|----------|-----|------------|------|--------|
| 1 | `GAP-001` | Segurança | P1 | Segredos em texto plano at rest (creds de monitor/notificação, JWT secret) | T3 | 🔵 deferred → ADR-0007 |
| 2 | `GAP-002` | Segurança | P1 | JWT sem expiração; troca de senha não invalida tokens | T3 | 🔴 open |
| 3 | `GAP-003` | Arquitetura | P2 | Monólitos god-object (monitor.js 2069, server.js 2018, EditMonitor.vue 4356, util-server.js 1066…) | T2 | 🟡 queued |
| 4 | `GAP-004` | Arquitetura | P2 | Sem camada de validação de entrada (parsing manual em sockets/routers) | T2 | 🟢 avançado (TASK-030: zod em api-key/tags/chart/slug/proxy/docker/remote-browser/cloudflared). Monitor add/editMonitor e status-page save/incident ficam para EPIC-3b (fora de escopo, maior risco) |
| 5 | `GAP-005` | Performance | P3 | Import eager de 24 monitor-types + 96 providers; tabelas `stat_*` sem model | T2 | 🟡 queued |
| 6 | `GAP-006` | Testes | P4 | Cobertura ~14%; `monitor.js` e models sem teste unitário direto | T2 | 🟢 avançado (TASK-020/105: +19 model +10 http +64 submódulos +3 e2e) |
| 7 | `GAP-007` | Higiene | P4 | Backend sem tipos (só JSDoc); 108 patches SQL legados; CLAUDE/AGENTS haviam sido esvaziados | T1 | 🟢 partial |
| 8 | `GAP-008` | Segurança | P1-low | timing-enum no login; `verifyAPIKey` sem `user_id`; `setup` sem rate-limit | T2 | 🟡 queued |
| 9 | `GAP-009` | Testes | P4 | E2E não cobre `maxRedirects` nem inversão de keyword-match no monitor HTTP | T2 | ✅ closed — `test-http.js` (10 testes), 2 mutation-checks independentes confirmaram detecção real. commit 57fcff7a |
| 10 | `GAP-010` | Testes | P4 | Teste "partial config" do `agent-forwarder.js` só afirma "nenhum monitor criado", não "nenhuma chamada de rede feita" — mutation independente do verificador provou que o código real está correto, mas o teste não afirma isso diretamente (a request malformada é rejeitada 401 rio abaixo, mascarando o gap) | T1 | 🟡 queued |
| 11 | `GAP-011` | Robustez | P4 | Schema zod de `federation-router.js`: campo `msg` é `.optional().default("")` sem `.nullable()` — se `bean.msg` for `null` (não `undefined`) num tipo de monitor, aquele heartbeat específico é descartado silenciosamente (rejeitado 400, logado, sem crash) | T2 | 🟡 queued |

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
  depends_on: [TASK-100, TASK-110, TASK-120]
  status: done   # +74 testes novos (10 http.js fechando GAP-009, 31 tls, 20 misc, 13 database submodules). Suíte não-Docker: 185->259. 2 mutation-checks independentes por etapa. commits 57fcff7a + 8ac0ea1e
  concluido_em: "2026-07-03"

- id: TASK-030
  desc: "EPIC-3: introduzir validação (zod). Fase 1: api-key/tags/chart/slug. Fase 2: proxy/docker/remote-browser/cloudflared. FORA DE ESCOPO deliberado: monitor add/editMonitor (union discriminada 24+ tipos) e status-page save/incident — maior complexidade/risco, adiados p/ EPIC-3b"
  skill: /improve-codebase-architecture
  gap_ref: GAP-004
  depends_on: [TASK-110]
  status: done   # zod ^4.4.3 + server/validation.js. Fase 1: keyID/tagID/monitorID/period/slug (commit 67d7e6d7). Fase 2: proxy(protocol via SUPPORTED_PROXY_PROTOCOLS)/docker(socket|tcp)/remote-browser(url aceita ws://)/cloudflared(token) (commit 76717066). 259/259 backend + 26/26 e2e + testes de rejeição E aceitação por fase. package-lock.json finalmente limpo (diff antigo absorvido pelo npm install).
  concluido_em: "2026-07-03"

- id: TASK-090
  desc: "EPIC-1: cifrar segredos at rest + migration + mascaramento API"
  gap_ref: GAP-001
  depends_on: [TASK-010]
  status: deferred   # decisão registrada em docs/adr/0007-defer-secret-encryption.md — reavaliar se multi-tenant/compliance

# Feature: Master-Agent (Federação) — T3, design em ADR-0008 + docs/prd/master-agent.md
# Decisões do usuário: transporte faseado REST->socket.io; notificação configurável; Master híbrido.

- id: TASK-F0
  desc: "F0 Fundação: migration remote_instance + monitor.remote_instance_id + model remote_instance.js + setting federation.role"
  ref: ADR-0008
  risco: T3
  depends_on: []
  status: done   # remote_instance table + monitor.remote_instance_id (ON DELETE SET NULL). server/federation/constants.js (FEDERATION_ROLES, ainda não wired). Zero wiring confirmado via grep. commit 9641dbc3
  concluido_em: "2026-07-03"

- id: TASK-F1
  desc: "F1 Receptor Master (MVP): registro de remote_instance + endpoint /api/federation/heartbeat + espelhamento idempotente de monitores (type=push). Inclui migration adicional monitor.remote_monitor_id (gap achado no design da F1)"
  ref: ADR-0008
  risco: T2
  depends_on: [TASK-F0]
  status: done   # verifyRemoteInstanceToken (espelha verifyAPIKey) + POST /api/federation/heartbeat + upsert idempotente (3 heartbeats -> 1 monitor, confirmado manualmente 2x). 9 testes novos. server.js só +2 linhas aditivas. commit 2e99ae72
  concluido_em: "2026-07-03"

- id: TASK-F2
  desc: "F2 Forwarder Agent (MVP): server/federation/agent-forwarder.js resiliente (no-op se não configurado, timeout limitado, nunca propaga erro) + 1 hook em monitor.js pós R.store(bean). Reusa settings genéricos existentes (Settings.get), sem novo socket handler"
  ref: ADR-0008
  risco: T2
  depends_on: [TASK-F1]
  status: done   # monitor.js: só 5 inserções (1 require + 1 chamada). Resiliência cronometrada empiricamente pelo verificador (10017ms contra endereço black-holed, bate com timeout de 10000ms). 7 testes novos (286/286 total), 26/26 e2e. commit 5d6cdecb
  concluido_em: "2026-07-03"

- id: TASK-F3
  desc: "F3 UI unificada. Fase 1: Monitor.toJSON() expõe remoteInstanceId. Fase 2: Federation.vue (lista/add/delete remote_instance, molde APIKeys.vue) + config do Agent (reusa setSettings genérico, merge por-chave confirmado no código, sem clobber) + badge no MonitorListItem (lookup local, sem N+1)"
  ref: ADR-0008
  risco: T2
  depends_on: [TASK-F2]
  status: done   # Fase 1: commit 314a71fd. Fase 2: agente escritor NÃO commitou sozinho (parou dizendo "vou aguardar notificação de outra tarefa") -- verificador seguiu e validou o working tree mesmo assim, encontrei e commitei eu mesmo (f16b2828) após checagem própria. 29/29 e2e, lint 0 err.
  concluido_em: "2026-07-04"

- id: TASK-F4
  desc: "F4 Federação Socket.io (v2): server/federation/agent-client.js persistente + keepalive + detecção 'agente caiu'"
  ref: ADR-0008
  risco: T3
  depends_on: [TASK-F2]
  status: blocked

- id: TASK-F5
  desc: "F5 Robustez: buffering offline, versionamento de protocolo, notificação configurável (master/agent/both), sync rename/delete"
  ref: ADR-0008
  risco: T2
  depends_on: [TASK-F3, TASK-F4]
  status: blocked

# Trilha: Histórico de métricas de longo prazo — ADR-0009 (usuário: métricas, escala média, design-first)
# Fundação executa F0 + M0 JUNTAS (uma migration por concern, mesma fatia). MariaDB recomendado no Master.

- id: TASK-M0
  desc: "M0 Fundação métricas: models para stat_* (fecha GAP-005) + tabela stat_monthly + settings de retenção em camadas"
  ref: ADR-0009
  risco: T3
  depends_on: []
  status: done   # tabela stat_monthly (schema final de stat_hourly replicado) + models StatMinutely/Hourly/Daily/Monthly. uptime-calculator.js NÃO tocado (zero wiring). commit 9641dbc3
  concluido_em: "2026-07-03"

- id: TASK-M1
  desc: "M1: UptimeCalculator grava/rola tier mensal (bucket calendar-aware, NÃO intervalo fixo); clear-old-data.js honra retenção em camadas. Rede: test-uptime-calculator.js (18 casos + novos)"
  ref: ADR-0009
  risco: T2
  depends_on: [TASK-M0]
  status: done   # monthlyKey() calendar-aware (dayjs startOf("month")) confirmado por script Python independente fora do toolchain. Persist em stat_monthly + retenção keepMonthlyStatsPeriodDays (default 1825d). Read-side (getDataArray "month") deliberadamente adiado p/ M2. 18->21 testes uptime-calculator + 2 novos clear-old-data. commit 18b63a41

- id: TASK-M2
  desc: "M2: UI de relatório de SLA por remote_instance, exportável"
  ref: ADR-0009
  risco: T2
  depends_on: [TASK-M1, TASK-F3]
  status: blocked
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
| 12 | 2026-07-03 | ADR-0008 | TASK-F1: registro remote_instance + POST /api/federation/heartbeat + upsert idempotente (type=push) | Sobreviveu a interferência de agente zumbi (ver seção "Incidente" acima). 9 testes, 2 mutation-checks independentes. commit 2e99ae72 |
| 13 | 2026-07-03 | ADR-0009 | TASK-M1: tier stat_monthly (bucket calendar-aware) + retenção em camadas | Truncagem de mês verificada por script Python fora do toolchain. 279/279 backend final. commit 18b63a41 |
| 14 | 2026-07-03 | ADR-0008 | TASK-F2: agent-forwarder.js resiliente + 1 hook em monitor.js (5 inserções) | Verificador cronometrou empiricamente o timeout (10017ms vs 10000ms configurado) contra endereço black-holed. 286/286 backend + 26/26 e2e. Achou GAP-010/011 (menores, não bloqueantes). commit 5d6cdecb |
| 12 | 2026-07-03 | GAP-009 | TASK-020 fase 1: `test-http.js` (10 testes) fecha GAP-009 | maxRedirects + keyword-inversion cobertos, 2 mutation-checks independentes confirmaram detecção. commit 57fcff7a |
| 13 | 2026-07-03 | GAP-006 | TASK-020 fase 2: 64 testes novos p/ submódulos util-server(tls,misc)/database sem cobertura direta | Suíte não-Docker 194→259. mutation-check independente (checkStatusCode) confirmou. commit 8ac0ea1e |
| 14 | 2026-07-03 | GAP-004 | TASK-030 fase 1: zod + validação keyID/tagID/monitorID/period/slug | Testes de rejeição (payload malformado) e aceitação (payload real da UI) independentes. commit 67d7e6d7 |
| 15 | 2026-07-03 | GAP-004 | TASK-030 fase 2: validação proxy/docker/remote-browser/cloudflared | Verificador confirmou schemas contra fonte real (SUPPORTED_PROXY_PROTOCOLS, dialogs Vue) e que url aceita ws:// (não quebra remote-browser real). commit 76717066 |
| 16 | 2026-07-03 | ADR-0008/0009 | TASK-F0+M0: fundação schema Master-Agent (remote_instance, ON DELETE SET NULL) + histórico de métricas (stat_monthly) | Primeira mudança real de schema da sessão. 2 tentativas de delegação falharam (agente só relatou "vou aguardar" sem executar); executado diretamente. Achado e corrigido: toJSON() usava convenção underscore de tag.js (retornava undefined nesta versão do redbean-node) — trocado p/ convenção sem underscore de api_key.js/monitor.js. 265/265 backend + 26/26 e2e + zero-wiring grep vazio. Ambiente teve bastante flakiness de processo/porta (limpo com PowerShell). commit 9641dbc3 |

---

## Incidente: interferência entre agentes concorrentes na mesma working tree

Durante F0, duas tentativas via tool `Agent` (não-Workflow) pareceram falhar imediatamente ("vou aguardar", 1 tool call) — na realidade **continuaram rodando em background por 30-45min**, muito depois de eu ter seguido em frente e feito a F0 manualmente. Uma delas, ao "investigar mudanças inesperadas", **deletou/reverteu arquivos do F1 que o Workflow atual escrevia naquele momento** (server/auth.js, server/server.js, e 4 arquivos novos, incluindo um teste). O próprio agente executor do F1 **detectou a sabotagem, matou os processos interferentes, recriou tudo e rerodou o gate completo do zero** — nenhum dado foi perdido, confirmado por verificação independente minha depois. Ambos os agentes zumbis já reportaram conclusão terminal (não devem mais interferir).

**Lição:** o tool `Agent` (diferente do `Workflow`) não tem mecanismo de cancelamento visível uma vez disparado — se parecer ter "falhado" rápido demais, pode estar continuando em background por muito tempo, mutando a mesma working tree sem eu saber. Preferir `Workflow` para qualquer tarefa que escreva no repo quando há risco de concorrência.

## Incidente 2: agente do F3 não commitou + arquivo misterioso não solicitado

Durante o F3 (2026-07-04), o agente escritor do Stage 2 (frontend) rodou ~177min (181 tool calls) e **parou sem commitar**, dizendo apenas "vou aguardar notificação de outra tarefa" — mesmo padrão de trava do Incidente 1. O verificador seguinte, corretamente, investigou o working tree não commitado, validou o trabalho (`verified: true`) e sinalizou honestamente que nada tinha sido commitado.

**Mais grave:** junto aos arquivos legítimos do F3, apareceu `docs/adr/0010-teams-rbac-multitenancy.md` — um ADR **extenso e tecnicamente detalhado** (340 linhas, referencia linhas exatas de `knex_init_db.js`) sobre uma feature de **Teams + RBAC multi-tenancy** nunca pedida nesta sessão. O texto menciona "síntese de 3 propostas + 3 juízes + 2 red-teams" — um padrão de judge-panel. Origem desconhecida; não vim de nenhum `Agent`/`Workflow` que eu disparei. **Não commitado** — movido para o scratchpad da sessão (`0010-teams-rbac-multitenancy-MYSTERY.md`), preservado mas fora do repo, para o usuário decidir o que fazer.

**Ação tomada:** verifiquei pessoalmente o trabalho do F3 (lint, build, e2e 29/29, e a claim de segurança do `setSettings` lendo `server/settings.js` diretamente — confirmado merge por-chave, nunca replace) e commitei apenas os arquivos legítimos (`f16b2828`).

## Pendências / Notas

- `package-lock.json` tem alteração local não relacionada (remoção de campos `libc` em deps opcionais do rollup) — provável artefato de `npm install`. Não revertido; decidir se restaura.
- **Descoberta (2026-07-03):** `npm run build` funciona neste ambiente (gera `dist/`) e o E2E Playwright é **totalmente viável** — após `npx playwright install chromium` (browser estava desatualizado: 1228 instalado vs 1084 esperado pelo playwright 1.39), suíte completa rodou **23/23 em 2.1min**. Isso eleva a confiança na rede de segurança do frontend para além de "só teórica".
- `check()` HTTP **não existe como método isolado** em `monitor.js` — a lógica fica embutida numa closure `beat()` dentro de `start(io)` (confirma o gap do ADR-0002). Por isso a caracterização de monitor.js foca em `toJSON`/`toPublicJSON` (isoláveis) em vez de tentar unit-testar o check em si.

---

## Rebrand SuperKuma (2026-07-04+)

> Detalhes completos em memória: `uptime-kuma-superkuma-rebrand.md`. Branch: `chore/rebrand-superkuma` (criada a partir de `develop`, sequenciada ANTES de `chore/ci-develop-main` e `feature/rbac-multitenant` mergearem — essas duas rebasam por cima depois).
> PR #1 (`chore/orchestrator-standardization` → `master`) foi **fechado**: `develop` já continha 100% daquele trabalho na mesma ponta (`e467e5dd`).

### Decisões travadas
- Rename **completo**, incluindo breaking changes (env vars `UPTIME_KUMA_*` → `SUPERKUMA_*`).
- README: **remove** badges/links sem equivalente SuperKuma (Docker Hub pulls, OpenCollective, Weblate, demo, sponsors).
- Estágio `pr-test2` do Dockerfile: repointa pro `alltomatos/superkuma.git` (não remove).
- Tags Docker renomeadas pra `alltomatos/superkuma` mesmo sem o registro existir ainda.
- **Não tocar**: `LICENSE` (copyright "Louis Lam", pessoa física), `CNAME` (`git.kuma.pet`, domínio real), e-mail do `CODE_OF_CONDUCT.md`.
- i18n: renomeia só os **valores**, não as chaves `"Uptime Kuma"`/`"Uptime Kuma URL"` (evita rename sincronizado arriscado em 78 arquivos + call-sites).
- 3 guards `if: github.repository == 'louislam/uptime-kuma'` em `.github/workflows/*.yml` **deixados intactos** de propósito — mudar pro nome novo ligaria esses workflows de publish Docker de verdade, e eles falhariam (sem secrets/registro ainda).

### Tarefas (8 estágios — TASK-SK1..SK8)
```yaml
- id: TASK-SK1
  desc: "Env vars UPTIME_KUMA_* -> SUPERKUMA_* (31 vars, ~25 arquivos)"
  status: done   # 286/287 backend (1 flake de rede conhecido), 29/29 e2e, lint 0. commit aa7e335a

- id: TASK-SK2
  desc: "Identidade central: appName (recompilado via tsc), User-Agent, classe UptimeKumaServer->SuperKumaServer (~15 arquivos), VAPID, URLs GitHub"
  status: done   # 1a verificação veio verified=false (gap real: clientId Kafka). Corrigido + varredura própria achou mais 5 pontos (logs de startup, comentários JSDoc). commits ceb6655c + 97469dd1 (fix)

- id: TASK-SK3
  desc: "UI do frontend: Layout.vue, NotFound.vue, Setup.vue, SetupDatabase.vue, About.vue, StatusPage.vue (Powered by)"
  depends_on: [TASK-SK2]
  status: done   # 1a verificação veio verified=false: faltou index.html (title/meta) + public/manifest.json (PWA name), que eu nunca tinha atribuído a nenhum estágio no plano original (gap de planejamento, não do executor). Corrigido diretamente + confirmado no dist/. commits 7b952ccf + 9c6a5162 (fix)

- id: TASK-SK4
  desc: "~45 provedores de notificação (nomes/títulos padrão) + formulários Vue correspondentes"
  depends_on: [TASK-SK2]
  status: in_progress   # Workflow disparado

## Lição (2 gaps de planejamento seguidos: Kafka clientId no SK2, index.html/manifest.json no SK3)
Os dois gaps achados até agora eram itens que EU não tinha atribuído explicitamente a nenhum estágio no plano original — não foi o executor "esquecendo" algo que pedi, foi eu não pedindo. A partir do SK4, incluir uma varredura ampla final (não só nos arquivos nomeados) como parte do próprio gate de verificação de cada estágio, e considerar uma varredura de "sanity final" cross-stage antes de fechar o rebrand como um todo (antes do rename do repo no GitHub).

- id: TASK-SK5
  desc: "i18n: en.json (20 valores) + varredura case-insensitive nos outros 77 idiomas (só valores)"
  depends_on: [TASK-SK3]
  status: blocked

- id: TASK-SK6
  desc: "Docker/build/CI neste worktree: Dockerfiles (pr-test2 repointa), compose, scripts package.json, extra/release/*.mjs, .github/workflows (SEM tocar nos 3 guards de repository)"
  depends_on: [TASK-SK2]
  status: blocked

- id: TASK-SK7
  desc: "Docs de topo: README.md (remove badges/links sem equivalente), CONTRIBUTING.md, SECURITY.md. NÃO: LICENSE/CNAME/e-mail CODE_OF_CONDUCT. Feito diretamente pelo orquestrador, sem agente."
  depends_on: [TASK-SK3, TASK-SK4, TASK-SK6]
  status: blocked

- id: TASK-SK8
  desc: "Docs de governança próprios: CLAUDE.md, CONTEXT.md, ORCHESTRATOR-ROADMAP.md, ESTADO_ORQUESTRATOR.md, docs/adr/*, docs/prd/*. Feito diretamente, sem agente."
  depends_on: [TASK-SK7]
  status: blocked
```

### Passo final (após TASK-SK8)
Gate de verificação completo → `gh repo rename superkuma` → atualizar remotes nas outras 2 worktrees (`ci-setup`, `rbac`).
