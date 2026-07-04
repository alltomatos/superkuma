# Regras de Desenvolvimento — alltomatos/superkuma

> Fork privado do Uptime Kuma, renomeado para SuperKuma. Este arquivo define como humanos e agentes de código trabalham neste repo.
> Governança do orchestrator: [`ORCHESTRATOR-ROADMAP.md`](ORCHESTRATOR-ROADMAP.md) · [`.claude/ESTADO_ORQUESTRATOR.md`](.claude/ESTADO_ORQUESTRATOR.md) · [`docs/agents/`](docs/agents).

---

## 1. Projeto

SuperKuma — ferramenta self-hosted de monitoramento. Stack:

- **Frontend:** Vue 3 + Vite (estado via mixins globais em `src/mixins/`, sem Vuex/Pinia).
- **Backend:** Node.js (>= 20.4) + Express + Socket.io.
- **Persistência:** redbean-node (ORM runtime) + Knex (migrations). Engines: SQLite (default), MariaDB, MySQL, Postgres.
- **Tempo real:** dashboard consome eventos Socket.io; páginas públicas/badges via REST.

### Mapa de arquitetura

| Área                | Caminho                                        | Nota                                                        |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| Bootstrap backend   | `server/server.js`                             | monólito (2k linhas) — evitar crescer                       |
| Modelo de monitor   | `server/model/monitor.js`                      | god-object (2k) — extrair ao mexer                          |
| Tipos de monitor    | `server/monitor-types/`                        | **padrão de plugin** — 1 tipo por arquivo                   |
| Notificações        | `server/notification-providers/`               | **padrão de plugin** — 1 provider por arquivo               |
| Handlers socket     | `server/socket-handlers/`                      | protegidos por `checkLogin(socket)`                         |
| Rotas HTTP públicas | `server/routers/`                              | badges, push, status-page                                   |
| Agregação de uptime | `server/uptime-calculator.js`                  | janelas em memória + persistência `stat_*`                  |
| Migrations          | `db/knex_migrations/`                          | Knex é o caminho oficial (patches SQL legados = deprecados) |
| Frontend            | `src/pages/`, `src/components/`, `src/mixins/` | `EditMonitor.vue` é o maior (4k)                            |

---

## 2. Política do fork

- **Fork privado.** Nenhum PR gerado por agente vai para o upstream `louislam/uptime-kuma`.
- **Revisão obrigatória.** Toda mudança de código é entendida, revisada e **testada manualmente** antes de qualquer `push`. Não submeter código gerado + descrição de LLM sem revisar.
- **Nunca** trabalhar direto no `master`: sempre branch. **Nunca** `git push --force` nem `git reset --hard` sem pedido explícito.

---

## 3. Comandos

```bash
npm run dev            # frontend (3000) + backend (3001) em watch
npm run start-server-dev
npm run build          # build de produção (Vite)

npm run lint           # eslint (js/vue) + stylelint
npm run lint:js        # só eslint
npm run fmt            # prettier --write em tudo
npm run tsc            # typecheck do backend (só src/util.ts; ver §6)

npm run test-backend   # testes de backend (node --test) — alguns exigem Docker
npm run test-e2e       # Playwright
```

---

## 4. Estilo de código

Definido por `.prettierrc.js` e `.eslintrc.js` — **rode `npm run fmt` antes de commitar** (o CI também formata).

- Indentação: **4 espaços** (2 em `.yml`/`.md`), sem tabs, EOL **LF**.
- **Aspas duplas**, ponto-e-vírgula obrigatório, `printWidth` 120, `trailingComma` es5 (none em JSON).
- `no-var` (use `const`/`let`), `eqeqeq` smart, `yoda` (condições yoda), `curly` sempre, uma declaração de variável por vez (`one-var: never`), 1 statement por linha.
- **JSDoc obrigatório** em toda função/método (`require-jsdoc`): descreva `@param`, `@returns` e `@throws`.
- `no-throw-literal`: lance `Error`, não strings.
- Frontend: componentes Vue 3; nomes multi-palavra não são exigidos (`multi-word-component-names: off`).

---

## 5. Git & commits

- **Conventional Commits:** `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`…
- **Branch:** `tipo/descricao-curta` (ex: `refactor/split-monitor-check`).
- Commits pequenos e semânticos. Não misturar refactor com feature.
- Nenhum segredo/credencial em commits, fixtures ou testes.

---

## 6. Testes

- **Baseline verde antes de refatorar.** Rode os testes da área alterada + a suíte de backend.
- Mudou comportamento? **Tem que ter teste.** Feature nova → preferir TDD (red-green-refactor).
- Testes de banco (`server/monitor-types/` de DB, migration, snmp) usam **testcontainers → exigem Docker Desktop rodando**. Sem Docker, rode o subconjunto unitário puro.
- `npm run tsc` está **vermelho por toolchain** (typescript 4.4.4 × @types/node 22), não por código — por isso não está no pipeline `npm test`. Não trate como regressão. Fix opcional: `skipLibCheck: true` ou bump do typescript.

---

## 7. Política de mudanças por Tier (orchestrator)

| Tier   | O que é                                                        | Autonomia                                          |
| ------ | -------------------------------------------------------------- | -------------------------------------------------- |
| **T1** | lint, fmt, typo, docs simples                                  | executa direto, loga no estado                     |
| **T2** | testes, refactor localizado sem breaking change, ADRs          | executa em lote sob rede de testes, reporta no fim |
| **T3** | **schema de DB, autenticação, arquitetura macro, API pública** | **PARA e pede "Go" humano**                        |

Refactor pesado (>1 arquivo grande, mudança de esquema) → rodar em **git worktree isolada**. O estado da fila (DAG) vive em [`.claude/ESTADO_ORQUESTRATOR.md`](.claude/ESTADO_ORQUESTRATOR.md).

---

## 8. GAPs conhecidos (prioridade)

1. **P1 (T3):** segredos em texto plano at rest (creds de monitor/notificação, JWT secret); JWT sem expiração. Ver roadmap EPIC-1.
2. **P2:** monólitos god-object (`monitor.js`, `server.js`, `EditMonitor.vue`); sem camada de validação de entrada.
3. **P3/P4:** import eager de tipos/providers; cobertura de testes ~14%; backend sem tipos.

Detalhe completo em [`ORCHESTRATOR-ROADMAP.md`](ORCHESTRATOR-ROADMAP.md).
