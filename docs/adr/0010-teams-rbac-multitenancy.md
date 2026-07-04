# ADR-0010 — Teams + RBAC Granular (Multi-Tenancy) para o fork Uptime Kuma

**Status:** PROPOSTA FINAL (Tier-3 — requer "Go" humano explícito antes de qualquer código)
**Data:** 2026-07-04
**Autor:** Lead Architect (síntese de 3 propostas + 3 juízes + 2 red-teams, com correções verificadas no código)
**Governança:** §7 CLAUDE.md · ORCHESTRATOR-ROADMAP.md · rodar em git worktree isolada

---

## 1. Contexto e decisão

O produto passa de single-user para **multi-tenant com Teams** + **RBAC granular** (papéis customizáveis, permissões finas por tipo de recurso). Usuários são criados **somente por admin** (sem auto-registro).

A espinha dorsal é um **esqueleto aditivo com flag de dark-launch** (`rbacEnforced`) sobre um **modelo de eixo único de propriedade**: `team_id` é a autoridade de autorização/consulta; `user_id` **permanece** (sem rename), mas deixa de ser a autoridade. Enxerta-se hardening de sessão/isolamento: `token_version`, `audit_log`, `must_change_password`, restrição de `disableAuth`, e o fechamento explícito dos leak-paths.

**Esta versão FINAL corrige oito falhas estruturais** apontadas pelo red-team, todas verificadas no código-fonte. As correções mudam invariantes centrais — leia §1.2 antes do resto.

### 1.1 Decisões-chave

| #   | Decisão                                                                                                                                                                                    | Justificativa                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **MANTER `user_id`, ADD `team_id` nullable**. NÃO adicionar `created_by` como coluna nova nas tabelas de recurso — reusar `user_id` como principal de auditoria (ver R2).                  | redbean grava por nome de propriedade 1:1; zero precedente de rename; coluna-sombra `created_by` duplicaria semântica e quebra API keys (R2). |
| D2  | `team_id` **nullable no DB**; NOT NULL garantido no bean-save hook + integrity check.                                                                                                      | SQLite não faz ALTER→NOT NULL in-place na tabela `monitor` (60 colunas).                                                                      |
| D3  | `onDelete` de `team_id` = **RESTRICT** + tela superadmin de re-home.                                                                                                                       | CASCADE apaga monitores+histórico; SET NULL cria órfãos invisíveis.                                                                           |
| D4  | Flag `rbacEnforced` (dark-launch), caminho flag-ON usa eixo único.                                                                                                                         | Flag-OFF byte-idêntico = contrato de regressão testável sobre baseline ~14%.                                                                  |
| D5  | JWT: `token_version` + `exp` + claim `h` mantido; **claims ausentes tratados como versão 0** (R6).                                                                                         | `token_version` dá revogação por admin; grandfather evita logout de frota inteira no upgrade.                                                 |
| D6  | **UM papel por (user, team) na v1** (`UNIQUE(team_id,user_id)`).                                                                                                                           | Simplifica `can()`/UI. TRAVAR antes de P0 (multi-papel exige 2ª migração).                                                                    |
| D7  | Adiar `resource_acl`/`parent_team_id`/nested teams.                                                                                                                                        | Superfície de autz sem UI = risco de rot.                                                                                                     |
| D8  | **status_page** é team-scoped com flag `is_public`; **`group` NÃO recebe `team_id` nem `is_public`** — herda tenancy do `status_page` pai e reusa a coluna `public` existente (R1, R-med). | `group` não tem `user_id` (verificado knex_init_db.js:26-34) e já tem `public`; escopar `group` independente do pai cria split-brain.         |
| D9  | `/metrics` Prometheus: **gate superadmin-only** até redesenho por-team.                                                                                                                    | Singletons globais module-level; sem seam por-request.                                                                                        |

### 1.2 Correções do red-team incorporadas (blockers/high — todas obrigatórias)

Verificadas contra o código atual. Cada uma altera o design; não são caveats.

| Ref     | Correção incorporada                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Onde            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **R1**  | `group` **removido** do backfill genérico `SET ... = user_id` e do add de `team_id`/`is_public`. `group` não tem coluna `user_id` (verificado): o UPDATE genérico **aborta a transação inteira** em qualquer install com status-page group. `group` herda tenancy do `status_page` pai.                                                                                                                                                                                                        | §2.4, §5        |
| **R2**  | api_key usa **`user_id`** como principal (verificado: api_key.user_id NOT NULL CASCADE, knex_init_db.js). NÃO introduzir `created_by`-sombra. `buildActor({userId: key.user_id}, key.team_id)`. Sem isto, `key.created_by` fica NULL → toda key legada retorna 403 no flip. Legacy keys forçadas a papel **viewer** do Default Team; **actor de API key NUNCA faz short-circuit em is_superadmin do dono** (cap no `role_id`).                                                                 | §2.3, §5, §8.4  |
| **R3**  | **`team_id` NUNCA é atribuído de payload de cliente em nenhum bean.** redbean freeze-mode `store()` grava o property-bag inteiro (verificado redbean-node.js) → a "invariante anti-escalação" NÃO é garantida pelo gate `can()` sozinha. Regra de código hard: `team_id` setado só server-side de `actor.activeTeamId` no create; no edit, re-afirmar `bean.team_id` ao valor carregado do DB antes de `store()`; excluir `team_id` do allowlist de field-copy; bean-save hook pina `team_id`. | §4.3            |
| **R4**  | **Inventário de gates re-derivado por "toca um recurso", não por "já filtra user_id".** Adicionados ~15+ handlers antes omitidos: `clearEvents`/`clearHeartbeats` (server.js:959/978), `getMonitorBeats` (:334), TODOS os handlers de status-page (saveStatusPage/deleteStatusPage/getStatusPage/\*Incident), monitor_tag writes (:587/615/643), tags globais (:516/537/568), join-writes de maintenance (:77/109/176/200).                                                                    | §3, §4.2        |
| **R5**  | **Validação de FK cross-resource** como requisito de 1ª classe: notificationIDList/proxyId/docker_host/remote_browser/parent aceitos do cliente no monitor add/edit devem passar por `can(actor,'<res>:read',{id})` antes de persistir; `updateMonitorNotification` filtra a lista às notifications do team do actor.                                                                                                                                                                          | §4.4            |
| **R6**  | **Grandfather de claims JWT:** `(decoded.tv ?? 0) !== user.token_version` e política explícita de `exp` ausente. Sem isto, `undefined !== 0` desloga a frota inteira no primeiro reconnect pós-deploy.                                                                                                                                                                                                                                                                                         | §8.1            |
| **R7**  | **Federação:** `findOrCreateMirroredMonitor` seta `bean.team_id = remoteInstance.team_id` (verificado :79 hoje seta só `user_id`). bean-save NOT-NULL hook cobre o path do federation-router. `/api/push` e `/api/federation/heartbeat` emit sites adicionados explicitamente ao inventário atômico de room-refactor (verificado: :127/:129 emitem em `monitor.user_id`).                                                                                                                      | §5, §8.5, §9-P4 |
| **R8**  | **`isMonitorPublic` exige match de team:** um monitor é "público" só via grupo público **do team dono do monitor**. Fecha a cadeia badge-leak (anexar monitor de outro team a status page pública própria → `/api/badge` vaza). Landa na MESMA fase do gate de status-page.                                                                                                                                                                                                                    | §8.5            |
| **R9**  | **onDelete de `user_id` neutralizado** em api_key e remote_instance (hoje CASCADE): deletar um user destrói recursos do team. Trocar para SET NULL exige FK-alter → **rebuild de tabela sob PRAGMA foreign_keys=OFF no SQLite**. Isto CONTRADIZ a promessa "sem rebuild": ver R9-decisão em §5 e Decisão aberta.                                                                                                                                                                               | §5, §12         |
| **R10** | **Ordem explícita de createTable e seed** para paridade cross-engine FK (o window FK-OFF do SQLite mascara ordering bugs que quebram em Postgres/MySQL). Índices tratados como custo separado do column-add (não "instantâneo"); evitar índice duplicado do auto-`_id`-index do redbean.                                                                                                                                                                                                       | §5              |
| **R11** | **Tag tenancy** decidida (era D-decision faltante): `tag` recebe `team_id` (9ª tabela de recurso), `tag:manage` escopado por-team; monitor_tag writes exigem `monitor:update` no team do monitor.                                                                                                                                                                                                                                                                                              | §2.3, §3, §12   |
| **R12** | **disableAuth auto-login determinístico:** `R.findOne("user", " is_superadmin = 1 ORDER BY id ASC ")` (verificado: findOne com clause vazia = `.first()` sem ORDER BY = row plan-dependent). Check single-user roda ANTES do findOne.                                                                                                                                                                                                                                                          | §6              |

---

## 2. Modelo de dados (DDL sketch)

Convenção verificada de `2026-07-03-0000-create-remote-instance.js`: `.integer().unsigned().references("id").inTable(...).onDelete(...).onUpdate("CASCADE")`, sem SQL por-engine. IDs capturados em runtime.

### 2.1 Tabelas novas

```
team
  id INTEGER PK · name VARCHAR(255) NOT NULL · slug VARCHAR(100) UNIQUE NOT NULL (imutável)
  is_system BOOLEAN NOT NULL DEFAULT 0 · active BOOLEAN NOT NULL DEFAULT 1
  created_by INTEGER NULL FK user(id) ON DELETE SET NULL · created_date DATETIME DEFAULT now

team_user                                       -- membership: fonte única de verdade
  id PK · team_id INTEGER NOT NULL FK team(id) ON DELETE CASCADE
  user_id INTEGER NOT NULL FK user(id) ON DELETE CASCADE
  role_id INTEGER NOT NULL FK role(id) ON DELETE RESTRICT
  created_date DATETIME DEFAULT now · UNIQUE(team_id,user_id)          -- 1 papel/team v1 (D6)

role
  id PK · name VARCHAR(100) NOT NULL · slug VARCHAR(100) NOT NULL
  team_id INTEGER NULL FK team(id) ON DELETE CASCADE   -- NULL = template global built-in
  is_system BOOLEAN NOT NULL DEFAULT 0 · is_superadmin BOOLEAN NOT NULL DEFAULT 0
  description VARCHAR(255) · created_date DATETIME DEFAULT now · UNIQUE(team_id,slug)

permission                                      -- catálogo canônico, seed idempotente de code
  id PK · action VARCHAR(100) UNIQUE NOT NULL   -- "monitor:read"
  resource_type VARCHAR(50) NOT NULL · verb VARCHAR(50) NOT NULL
  is_team_scoped BOOLEAN NOT NULL DEFAULT 1 · description VARCHAR(255)

role_permission                                 -- coração normalizado (sem JSON blob)
  role_id FK role(id) ON DELETE CASCADE · permission_id FK permission(id) ON DELETE CASCADE
  PRIMARY KEY(role_id,permission_id)

audit_log
  id PK · actor_user_id INTEGER NULL FK user(id) ON DELETE SET NULL · team_id INTEGER NULL
  action VARCHAR(100) NOT NULL · target_type VARCHAR(50) · target_id INTEGER
  ip VARCHAR(64) · created_date DATETIME DEFAULT now · INDEX(created_date) · INDEX(actor_user_id)
```

### 2.2 ALTER — `user`

```
ADD is_superadmin        BOOLEAN NOT NULL DEFAULT 0   -- flag global cross-team
ADD token_version        INTEGER NOT NULL DEFAULT 0   -- bump = invalida TODOS os JWT do user (D5)
ADD must_change_password BOOLEAN NOT NULL DEFAULT 0
```

Cada ALTER emite DEFAULT literal ao nível do DB (`.notNullable().defaultTo(0)`) para popular rows existentes em Postgres/MySQL na mesma instrução (R-high).

### 2.3 ALTER — tabelas de recurso (9 tabelas, R11)

`monitor, maintenance, notification, proxy, docker_host, api_key, remote_browser, remote_instance, tag`

```
ADD team_id INTEGER NULL FK team(id) ON DELETE RESTRICT       -- eixo de autz/query (D3)
INDEX(team_id)                                                 -- custo separado do add (R10)
```

- **NÃO adicionar `created_by`.** `user_id` permanece e serve de auditoria (R2/D1). Onde `user_id` não existe (notification/proxy/docker_host não têm FK mas têm coluna; remote_browser tem coluna), o backfill checa existência por-tabela (R1).
- `api_key` adicionalmente: `ADD role_id INTEGER NULL FK role(id)` (scoping §8.4).
- **R9:** api_key.user_id e remote_instance.user_id trocam onDelete CASCADE→SET NULL (ver §5 e Decisão aberta).

### 2.4 ALTER — `status_page` (só; `group` NÃO — R1/D8)

```
status_page  ADD team_id   INTEGER NULL FK team(id) ON DELETE RESTRICT
             ADD is_public BOOLEAN NOT NULL DEFAULT 1   -- status_page não tem coluna public hoje
```

- **`group`:** sem `team_id`, sem `is_public`. Tenancy derivada transitivamente do `status_page_id` pai. Reusa a coluna `public` já existente (knex_init_db.js:30). O backfill NUNCA toca `group.user_id` (não existe).

---

## 3. Vocabulário de permissões

Seed idempotente de `server/permissions/catalog.js` (upsert por `action` no boot). Rows, não ENUM.

**Team-scoped (`is_team_scoped=true`):**

```
monitor:read monitor:create monitor:update monitor:delete monitor:manage_state
maintenance:read maintenance:create maintenance:update maintenance:delete
notification:read notification:manage · proxy:read proxy:manage
docker_host:read docker_host:manage · remote_browser:read remote_browser:manage
remote_instance:read remote_instance:manage · status_page:read status_page:manage
api_key:read api_key:manage · tag:read tag:manage           -- (R11: tag team-scoped)
settings:read settings:manage · team:read team:manage team:member_manage
```

**Global (`is_team_scoped=false`):** `user:manage · team:create · role:manage · audit:read`

**Built-in (role.team_id NULL, is_system=1):** `superadmin` (is_superadmin=1, bypass), `owner`, `admin`, `editor`, `viewer`.

Permissões efetivas num team = UNIÃO de `role_permission` do `role_id` em `team_user`. `is_superadmin` short-circuit allow-all. Deny-by-default.

---

## 4. Helper central de autorização

`server/security/authz.js` — ponto único. `buildActor(principal, activeTeamId) → Actor{userId, isSuperadmin, activeTeamId, memberships:Map<teamId,{roleId,permissions:Set}>}`. `can(actor, action, resource)`, `require(actor, action, resource)` (lança), `scopeFilter(actor) → {clause, params}`.

**Ordem em `can()`:** (a) `actor.isSuperadmin` → allow; (b) ação global → checa em qualquer membership; (c) resolve `resource.teamId` via **loader tipado** (`resourceType → SELECT team_id FROM <t> WHERE id=?`), nega se sem membership, senão `permissions.has(action)`.

**Invariante anti-escalação:** `resource.teamId` sempre carregado pelo loader a partir do `id`; `require()` NÃO aceita teamId do cliente. **(R3: isto protege LEITURA; a proteção de ESCRITA é a regra §4.3 — o gate sozinho não basta em freeze-mode.)**

**Flag-OFF:** `can()`→true, `scopeFilter()`→`user_id = ?` (byte-idêntico).

### 4.1 checkOwner + gates de propriedade

`checkOwner(userID, monitorID)` (server.js:1121) reescrito mantendo assinatura (callers :1210/:1243 intactos). Corpo: flag-ON → `require(ctx,"monitor:manage_state",{type:"monitor",id})`; flag-OFF → legado.

Cada predicado `WHERE id=? AND user_id=?` (monitor.js:1725/1736; docker.js:25/51; proxy.js:24/71; notification.js:251/284; remote-browser.js:11/31/56; maintenance:146/235; api-key:81; remote-instance:94; monitor-socket:298/421) → `require(ctx,"<res>:<verb>",{type,id})` + write defensivo `WHERE id=? AND team_id=?`.

### 4.2 Gates OMITIDOS pelo plano anterior — agora incluídos (R4, verificados)

Estes NÃO tinham predicado `user_id` hoje (leak por omissão), logo o plano antigo os deixava intocados:

- **Monitor heartbeat:** `clearEvents` (server.js:959), `clearHeartbeats` (:978) — **destroem** dados; `getMonitorBeats` (monitor-socket:334) — **lê** histórico de outro team. → `require monitor:manage_state`/`monitor:read`.
- **Status-page (TODOS checkLogin-only):** `saveStatusPage` (:292), `deleteStatusPage` (:482), `getStatusPage` (:268), `postIncident` (:34) e demais \*Incident. Resolvem por slug, zero owner-check. → resolver a page, `require status_page:manage|read` com teamId da row.
- **Tags:** `addTag`/`editTag`/`deleteTag` (monitor-socket:516/537/568) e `addMonitorTag`/`editMonitorTag`/`deleteMonitorTag` (:587/615/643). → `require tag:manage` no team; monitor_tag exige `monitor:update` no team do monitorID.
- **Maintenance join-writes/reads:** `addMonitorMaintenance` (:77), `addMaintenanceStatusPage` (:109), `getMonitorMaintenance` (:176), `getMaintenanceStatusPage` (:200). → `require maintenance:update|read` na maintenanceID + membership de cada id ligado.

**CI sweep (regra durável):** falha se um `socket.on` que **referencia um \*ID do cliente OU escreve um recurso** não tiver `require()`. Não é "lacks user_id" — é "touches a resource".

### 4.3 Regra hard de escrita de `team_id` (R3)

redbean roda em freeze-mode; `R.store(bean)` grava o property-bag inteiro. Logo:

1. `team_id` **nunca** copiado de payload de cliente.
2. No **create**: `bean.team_id = actor.activeTeamId` (server-side).
3. No **edit**: antes de `store()`, `bean.team_id = <valor carregado do DB>` (re-afirmação); `team_id` fora do allowlist de field-copy.
4. **bean-save hook** (`beforeUpdate`/`beforeStore`) pina `team_id` ao valor da row — cobre inclusive o path do federation-router (R7).

### 4.4 Validação FK cross-resource (R5)

No monitor add/edit, todo id aceito do cliente passa por `can(actor,'<res>:read',{id})` antes de persistir: `notificationIDList`, `proxyId`, `docker_host`, `remote_browser`, `parent`. `updateMonitorNotification` (server.js:1101) filtra `notificationIDList` às notifications do team do actor. Sem isto, um user anexa proxy/notification de outro team ao próprio monitor (exfiltração/enumeração).

### 4.5 List queries + rooms

`getMonitorJSONList` e `sendXList` trocam por `scopeFilter(actor)`. **Além disso (R-med):** auditar TODO `R.getAll/getRow/findOne` que retorna recurso ou filho (heartbeat, monitor_group, monitor_maintenance) — `getMonitorBeats`, join-reads de maintenance — e rotear por `scopeFilter`/`require` no id-pai. Rooms migram `io.to(userID)`→`io.to("team:"+teamId)` por ÚLTIMO (P4), atômico com TODOS emit sites incluindo `/api/push` (:127/:129), federation receptor (:175/:177), cloudflared (:49-51). Flag-OFF mantém `io.to(userID)`.

---

## 5. Migração e backfill

**Uma migração Knex idempotente**, cross-DB, guardada por `hasTable`/`hasColumn`.

**Ordem explícita (R10) — createTable:** `permission → role → team → role_permission → team_user → audit_log`. **Seed:** `permission rows → role rows → role_permission → Default Team → team_user`. Não confiar no window FK-OFF do SQLite para mascarar ordering (quebra em Postgres/MySQL).

1. createTable na ordem acima.
2. ALTER `user` add 3 colunas com DEFAULT literal.
3. ALTER 9 tabelas de recurso + status_page: add `team_id` nullable + `INDEX(team_id)`; api_key add `role_id`. **`group` NÃO alterado.** **Índice tratado como custo (R10):** em installs grandes, `CREATE INDEX` na `monitor` faz full-scan/lock — considerar CONCURRENTLY (Postgres)/online DDL, ou índice pós-migração fora da transação bloqueante. Garantir que não colide com o auto-`_id`-index do redbean (índice duplicado).
4. Seed catálogo + built-ins + grants.
5. **Data step (knex.transaction):**
   - INSERT Default Team (`is_system=1, slug='default'`), **id capturado em runtime**.
   - `UPDATE <resource> SET team_id=<defaultId> WHERE team_id IS NULL` — por-tabela, cobre rows com `user_id` já NULL (monitor/maintenance são SET NULL FK).
   - **`group`:** `UPDATE group SET <nada de user_id>` — group não recebe team_id; herda do pai. **NÃO** executar `SET created_by=user_id` em group (coluna inexistente = aborta transação — R1).
   - **NÃO** criar coluna `created_by`; `user_id` já é a auditoria (R2).
   - INSERT `team_user(defaultTeam, cada user, owner_role)`.
   - `UPDATE user SET is_superadmin=1 WHERE id=(SELECT MIN(id) FROM user)` — determinístico.
   - **api_key legacy (R2):** `UPDATE api_key SET role_id=<viewer_role_default_team>` — toda key legada cai em viewer até re-scoping explícito; nunca herda superadmin do dono.
   - **R9 (FK-alter):** trocar api_key.user_id / remote_instance.user_id de CASCADE→SET NULL. No SQLite exige rebuild da tabela sob `PRAGMA foreign_keys=OFF` (database.js:426). **Esta é a única exceção à promessa "sem rebuild"** e é a menos arriscada (api_key/remote_instance têm poucas colunas, ao contrário de monitor). Alternativa se o dono recusar: manter CASCADE e proibir delete de user na UI, deletando por transferência de recursos primeiro (ver Decisão aberta).
   - INSERT setting `rbacEnforced=false`.
6. `team_id` NOT NULL **não** no DDL (D2) — garantido no write-path + check periódico `team_id IS NULL`.

**down():** dropa só o que up() adicionou; `user_id` intocado exceto a reversão do FK-alter R9 (que re-exige rebuild no SQLite). **down() só é seguro com downgrade simultâneo do binário** (R-high): leituras de colunas novas (token_version, socket.actor) NPE sob skew schema/código. Todos os reads de coluna nova ficam atrás de existence-check ou da flag `rbacEnforced` para degradar graciosamente. Validado SQLite/MariaDB/MySQL/Postgres via testcontainers **com FKs ON** — especialmente join tables de PK composta.

---

## 6. Bootstrap / first-run

`Setup.vue → "setup" → server.js:710`, guard `count==0` (:716) mantido. Na MESMA transação: 1º user `is_superadmin=1`; seeds de papéis/catálogo; Default Team se ausente; `team_user(defaultTeam, user, superadmin_role)`. Installs existentes convergem via backfill (MIN(id)=superadmin).

- **Sem auto-registro:** só handler admin-only `addUser` guardado por `require(ctx,"user:manage")`, senha temp com `must_change_password=1` (bloqueia ações até rotacionar, checado em afterLogin).
- **Rate-limit** no `setup` (reusa loginRateLimiter — GAP-008).
- **disableAuth/autoLogin (R12):** o check single-user (`count==1`) roda ANTES do findOne; o auto-login usa `R.findOne("user", " is_superadmin = 1 ORDER BY id ASC ")` (determinístico; findOne com clause vazia = `.first()` sem ORDER BY = row arbitrária em Postgres). Multi-user recusa disableAuth (breaking change documentado, atrás de config + startup warning).

---

## 7. Frontend

### 7.1 Telas

1. **Manage Users** (`user:manage`): criar (username+senha temp), desativar, reset senha, force-logout (bump token_version), toggle superadmin (doubleCheckPassword + audit).
2. **Manage Teams** (`team:create`/`team:manage`): criar/renomear/desativar; delete bloqueado com recursos (RESTRICT) → tela de re-home.
3. **Team Members** (`team:member_manage`): add/remove + dropdown de papel (`assignTeamRole`).
4. **Roles & Permissions** (`role:manage`): matriz checkboxes (catálogo × papel) → `role_permission`; built-ins read-only.
5. **Team Switcher** no nav (se >1 team): seta `activeTeamId` → rejoina rooms + reenvia listas.
6. **API Keys** (estendida): subset de permissões ≤ criador via `role_id`.
7. **Audit Log viewer** (`audit:read`).
8. **Force-Change-Password** gate quando `must_change_password=1`.
9. Tabs de `Settings.vue` (:86-125), rotas filho `/settings` (router.js:87-138), Manage top-level (:149) permission-gated.

### 7.2 Renderização role-gated

Mixin `src/mixins/permissions.js` (root, junto de socket.js) expõe `$root.can(action)` lendo `permissions` do payload `info`. `v-if="$root.can('monitor:create')"`; route guards `meta.permission` em `beforeEach`. **Gating é UX-only** — server-side é a fronteira. Flag-OFF concede set completo (UI byte-idêntica).

---

## 8. Segurança

### 8.1 JWT + sessão (GAP-002, R6)

`createJWT` (user.js:41) inclui `exp` (default 8h, configurável), `iat`, `sub=user.id`, `tv=token_version`, mantendo `h=shake256(password)`. `loginByToken` (server.js:412) rejeita se `exp` passou OU **`(decoded.tv ?? 0) !== user.token_version`** (grandfather: tokens pré-upgrade sem `tv` = versão 0, evita logout de frota — R6). `exp` ausente: decidir explicitamente grandfather (aceitar) vs forçar re-login; padrão = aceitar por uma janela de graça e re-emitir com exp no próximo refresh. Bump `token_version` em: troca de senha (:747), troca de papel, force-logout. **Permissões NÃO vão no JWT** — resolvidas por conexão (loginByToken re-consulta o user).

### 8.2 Payload `info` (buildActor unificado)

`buildActor()` produz `socket.actor`/`req.actor` E o payload `info` da MESMA query. `sendInfo` (client.js:145-163, hoje só version/timezone) estende:

```json
{ "currentUser": {"id","username","isSuperadmin","mustChangePassword"},
  "teams": [{"id","name","slug","role","permissions":["monitor:read", ...]}],
  "activeTeamId": <id> }
```

Troca de membership/papel do socket conectado → re-emite `info` (live). `socket.js` (:122) armazena; `$root.can()` lê daí.

### 8.4 API-key scoping (GAP-008, R2)

`verifyAPIKey` (auth.js:41-63) hoje **descarta o bean** (verificado :50-62) → passa a **retornar o bean**. `attachActor` monta `req.actor` com **`userId = key.user_id`** (não created_by — R2), `team_id`, `role_id` da key. **A key é capada ao `role_id`; o actor de API key NUNCA faz short-circuit em `is_superadmin` do dono** (R2 — senão re-concede superadmin a keys de um dono superadmin). Re-limitada às permissões do dono no momento do uso (demote do dono → cap imediato), MAS sempre ≤ `role_id` da key e sem superadmin. Timing enum GAP-008: `login()` roda bcrypt contra hash dummy quando user não existe.

### 8.5 Isolamento de tenant — leak-paths

1. Lists → `scopeFilter` `team_id IN (...)`; TODO `R.*` ad-hoc auditado (R-med).
2. Gates (§4.1+§4.2) → `require` + `WHERE id=? AND team_id=?`.
3. Rooms `io.to(userID)`→`io.to("team:"+id)`.
4. `/api/push/:token` — público, confia SÓ no monitor que o token resolve; emit resolve team da row → `io.to("team:"+monitor.team_id)` (R7, verificado :127/:129 emitem em user_id hoje). Teste com monitor push no fixture 2-teams.
5. `/api/badge/:id` — **`isMonitorPublic` (api-router.js:626) exige team_id do monitor == team_id do status_page** (R8). Fecha a cadeia: anexar monitor de outro team a status page pública própria não torna o monitor público. Landa na MESMA fase do gate de status-page.
6. `/metrics` — singletons globais (prometheus.js:5-10) via `prometheusAPIMetrics()` (server.js:356). **Gate superadmin-only** + documentado como não-isolado (D9) até registry por-team.
7. **Federação (R7):** `remote_instance` ganha `team_id`; `findOrCreateMirroredMonitor` seta **`bean.team_id = remoteInstance.team_id`** (verificado :79 hoje seta só user_id → sem isto todo monitor espelhado nasce team_id=NULL = órfão invisível criado a cada agente). bean-save hook cobre este path. `findOrCreate` chaveia em `(remote_instance_id, agent_monitor_id)` com `remote_instance_id` do token VERIFICADO. Cap de monitores-por-instância. Teste de federação cross-tenant em P4.
8. `status_page` — `is_public` = "público dentro do status page do team dono"; `group` herda tenancy do pai.
9. Superadmin = única identidade cross-tenant, explícita e audit-logada.

### 8.6 Outros

`audit_log` write-only em ação privilegiada. Mutações privilegiadas exigem `doubleCheckPassword`. Guard contra remover último superadmin. CI sweep (§4.2) é a defesa durável contra gate esquecido.

---

## 9. Roadmap faseado

| Fase | Título                                                                                | Tier | Go?     |
| ---- | ------------------------------------------------------------------------------------- | ---- | ------- |
| P0   | ADR + catálogo + authz.js (unit-tested, sem schema/behavior)                          | T2   | —       |
| P1   | Migração schema + backfill (dark) — inclui R1/R2/R9/R10/R11                           | T3   | **SIM** |
| P2   | buildActor login/HTTP + JWT hardening (R6) + info payload (flag-OFF)                  | T3   | **SIM** |
| P3   | Enforcement: checkOwner + gates re-derivados (R4) + FK-validation (R5) + list scoping | T3   | **SIM** |
| P4   | HTTP/API/federação (R7) + isMonitorPublic (R8) + team rooms + flip                    | T3   | **SIM** |
| P5   | Frontend admin + role-gated UI                                                        | T2   | —       |
| P6   | Hardening/cleanup: constant-time login, /metrics gate, integrity check, E2E negativos | T2   | —       |

**R8 (isMonitorPublic) e o gate de status-page landam na MESMA fase (P4/P3-status)** — não deferir. **R5 (FK-validation) é parte de P3, não opcional.**

---

## 10. Riscos residuais e mitigações

Ver `topRisks`. Mitigação transversal: **testes negativos cross-tenant** (viewer-não-muta; team-A-não-lê/escreve team-B via socket/HTTP/push/federação/badge/tag/maintenance-join) como **gate de merge obrigatório**; TDD do authz.js e de cada leak-path antes de fiar handlers; migração validada em 4 engines com FKs ON via testcontainers.

## 11. Caveats (medium/low do red-team, não-bloqueantes)

- **Índice em tabela grande** (R-med): `CREATE INDEX` na `monitor`/`heartbeat` não é instantâneo; usar online DDL / índice pós-migração. Já em §5.
- **Skew schema/código no down()** (R-high, tratado como caveat operacional): down() só seguro com downgrade de binário simultâneo; reads de coluna nova atrás de existence-check.
- **`group.public` vs `is_public`** (R-med): resolvido não adicionando `is_public` a group (§2.4).
- **JWT refresh UX:** bump de token_version em troca de papel desloga mid-session; avaliar bump só em revogação/demote (não em qualquer edição de papel) — ver Decisão aberta.

## 12. Decisões abertas — ver campo dedicado.

---

## Anexo A — Roadmap faseado (estruturado)

| Fase | Título                                                                          | Tier | Precisa "Go"? | Entregável                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | ADR + permission catalog + central authz.js (sem schema, sem behavior change)   | T2   | —             | Este ADR FINAL aprovado; server/permissions/catalog.js (vocabulario com tag:read/tag:manage team-scoped) + server/security/authz.js com buildActor/can/require/scopeFilter, unit-tested contra fixtures. Nao fiado em handler. Baseline verde.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P1   | Migracao de schema + backfill (dark-launch) — com correcoes R1/R2/R9/R10/R11    | T3   | **SIM**       | 1 migracao Knex idempotente ordem-explicita (permission->role->team->role_permission->team_user->audit_log). Cria tabelas; altera user (3 cols DEFAULT literal) + 9 tabelas de recurso (inclui tag, R11) + status_page (team_id+is_public); api_key.role_id. group NAO alterado (herda do status_page pai, R1). NAO adiciona created_by (reusa user_id, R2). Backfill por-tabela checando existencia de coluna (group sem user_id nao aborta, R1). api_key legacy forcada a viewer (R2). FK-alter api_key/remote_instance user_id CASCADE->SET NULL (R9, unico rebuild SQLite, ou decisao alternativa do dono). Default Team runtime-id + memberships + MIN(id)=superadmin. Indice tratado como custo (R10). rbacEnforced=false. Validado 4 engines FKs-ON via testcontainers. Zero runtime le tabelas novas. |
| P2   | buildActor login/HTTP + JWT hardening (R6) + info payload (flag-OFF)            | T3   | **SIM**       | buildActor popula socket.actor em afterLogin e req.actor nos middlewares; verifyAPIKey RETORNA o bean, actor de key usa key.user_id capado ao role_id SEM superadmin do dono (R2); sendInfo emite currentUser/teams/permissions; JWT ganha exp+iat+sub+tv, loginByToken grandfather (decoded.tv ?? 0) (R6) evitando logout de frota; disableAuth auto-login determinístico is_superadmin ORDER BY id (R12). Nenhum require() enforça. Regressao single-user identica (flag-OFF set completo).                                                                                                                                                                                                                                                                                                                 |
| P3   | Enforcement socket: gates RE-DERIVADOS (R4) + FK-validation (R5) + list scoping | T3   | **SIM**       | checkOwner reescrito; predicados AND user*id=? viram require()+WHERE team_id=?; ALEM disso os ~15 handlers antes omitidos (R4): clearEvents/clearHeartbeats/getMonitorBeats, TODOS status-page (save/delete/get/\_Incident), monitor_tag writes, tags globais, maintenance join writes/reads. FK cross-resource validada (R5): notificationIDList/proxyId/docker_host/remote_browser/parent passam por can(:read); updateMonitorNotification filtra ao team. Regra hard §4.3: team_id nunca de payload, re-afirmado no store (freeze-mode, R3). getMonitorJSONList/sendXList + R.* ad-hoc usam scopeFilter. CI sweep FALHA se socket.on que TOCA recurso (nao 'lacks user_id') sem require(). Flag-OFF byte-identico.                                                                                         |
| P4   | HTTP/API/federacao (R7) + isMonitorPublic (R8) + team rooms + flip              | T3   | **SIM**       | attachActor middleware; /metrics superadmin-only; isMonitorPublic exige team match monitor==status_page (R8, fecha badge-leak, MESMA fase do gate status-page); /push confia so no token e emite io.to('team:'+monitor.team_id) (R7); federacao: findOrCreateMirroredMonitor seta bean.team_id=remoteInstance.team_id (R7), bean-save hook cobre o path, cap monitores/instancia; io.to(userID)->team rooms ATOMICO com TODOS emit sites (inclui /api/push :127/:129, federation receptor :175/:177, cloudflared :49-51). Fixture E2E 2-teams cobre monitor push E federado. Flip rbacEnforced=true (reversivel) + last-superadmin guard + doubleCheckPassword. Testes por leak-path como gate.                                                                                                               |
| P5   | Frontend admin + role-gated UI                                                  | T2   | —             | Handlers socket + telas Vue Manage Users/Teams/Members/Roles/Audit; src/mixins/permissions.js com $root.can; tabs Settings + nav filtrados; router meta.permission guards; team switcher; force-change-password gate. Backend ja enforça, UI e UX.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P6   | Hardening + cleanup                                                             | T2   | —             | constant-time login (bcrypt dummy), setup rate-limit, disableAuth->single-user warning, audit_log em todas privilegiadas, integrity check team_id IS NULL periodico, re-emit info on role change, deprecar caminhos user_id-only pos-flip, suite E2E negativa cross-tenant (secure-e2e) incluindo tag/maintenance-join/badge/push/federacao.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Anexo B — Decisões que o dono precisa travar

1. D6 (TRAVAR ANTES DE P0): 1 papel por (user,team) na v1 vs multi-papel desde o inicio? Sintese assume 1 papel (UNIQUE(team_id,user_id)); mudar depois exige 2a migracao. Confirmar.
2. D8/R1 (TRAVAR ANTES DE P1): status_page e team-scoped com is_public (default 1). Confirmado que 'group' NAO recebe team_id proprio e herda tenancy do status_page pai (group nao tem user_id no schema e ja tem coluna 'public' — verificado). Confirmar que status pages deixam de ser globais.
3. R9 (TRAVAR ANTES DE P1 — impacta a promessa 'sem rebuild'): api_key.user_id e remote_instance.user_id sao onDelete CASCADE hoje (verificado). Enquanto assim, deletar um user DESTROI keys/agentes do team ('user_id audit-only' e falso). Fix = trocar para SET NULL, o que no SQLite exige rebuild dessas 2 tabelas (pequenas). Aprovar o rebuild dessas 2 tabelas? OU manter CASCADE e proibir delete-de-user na UI (exigindo transferir recursos antes)?
4. R2 (confirmar semantica): api keys legadas caem para papel viewer do Default Team no flip (nunca herdam superadmin do dono; actor de key ignora is_superadmin do dono e e capado ao role_id). Aprovar este downgrade forcado + re-scoping manual, ou preferem herdar o papel do dono no momento do backfill?
5. D9: /metrics (Prometheus) usa singletons globais sem seam por-request -> leak cross-tenant nao fechavel sem redesenho. Aceitar gate superadmin-only ate redesenho por-team, OU priorizar registry por-team ja em P4?
6. R11 (confirmar): tags recebem team_id (9a tabela de recurso) e tag:manage e escopado por-team; monitor_tag writes exigem monitor:update no team do monitor. Confirmar, ou preferem tags como vocabulario global superadmin-managed?
7. Superadmin: flag global unico (escolhido) vs papel num team 'system'? Confirmar que 'org-admin' team-scoped NAO e necessario na v1.
8. JWT exp (default 8h) + estrategia: re-login silencioso no socket vs refresh token. Confirmar 8h + re-login silencioso. E: bump de token_version em QUALQUER edicao de papel (desloga mid-session) ou SO em revogacao/demote?
9. disableAuth restrito a single-user e BREAKING CHANGE para deployments multi-user que dependem de disableAuth. Aprovar (atras de config + startup warning)?
10. Delete de team: RESTRICT (bloqueia com recursos + tela re-home) confirmado, ou soft-delete/archive?
11. API keys emissiveis com papel MENOR que o criador (least-privilege) ou capado AO do criador? Sintese permite <= criador, sempre sem superadmin.

## Anexo C — Riscos residuais (top)

1. Migracao/backfill errada = atribuicao cross-tenant silenciosa (pior falha). VERIFICADO E CORRIGIDO: o backfill generico 'SET created_by=user_id' abortava a transacao inteira em installs com status-page group (group NAO tem coluna user_id — verificado knex_init_db.js:26-34). Fix: backfill por-tabela com check de existencia; group herda do pai; created_by removido (reusa user_id, R1/R2). Mitigacao restante: idempotencia hasTable/hasColumn, Default Team id runtime, cobre rows user_id ja NULL, testcontainers 4 engines FKs-ON incluindo join tables PK composta.
2. Inventario de gates derivado de 'ja filtra user_id' era estruturalmente UNSOUND: perde TODOS os handlers que vazam hoje por omissao. VERIFICADO: status-page (todos checkLogin-only, sem coluna de dono), monitor_tag writes, maintenance join-writes/reads, clearEvents/clearHeartbeats/getMonitorBeats — ~15 handlers antes intocados que no flip-ON ficariam ABERTOS cross-tenant (ler/destruir dados de outro team). Fix R4: inventario re-derivado por 'toca um recurso'; CI sweep por client-\*ID/write, nao por user_id.
3. team_id de payload de cliente NAO e bloqueado pelo gate can() — redbean freeze-mode store() grava o property-bag inteiro (verificado). A 'invariante anti-escalacao' so protegia LEITURA. Fix R3: regra hard — team_id nunca de cliente, re-afirmado ao valor do DB antes do store, bean-save hook pina. Sem isto, um unico Object.assign(bean, payload) escala o recurso para outro team.
4. Federacao criava monitor espelhado com team_id=NULL a CADA agente (nao so na migracao): findOrCreateMirroredMonitor seta bean.user_id, nunca team_id (verificado :79) -> orfao cross-tenant-invisivel continuo + integrity check disparando a cada heartbeat. Fix R7: setar bean.team_id=remoteInstance.team_id, bean-save hook cobre o path, /api/push e federation emit sites (verificado :127/:129 em user_id) no inventario atomico de room-refactor.
5. Cadeia badge-leak: isMonitorPublic (api-router.js:626) retorna true se QUALQUER user poe o monitor em QUALQUER grupo publico; combinado com saveStatusPage sem owner-check, um user baixo-privilegio torna monitor privado de outro team publico e le uptime/ping/cert via /api/badge. Fix R8: isMonitorPublic exige team_id do monitor == team_id do status_page, MESMA fase do gate status-page.
6. JWT: tokens existentes nao tem claim tv; decoded.tv (undefined) !== 0 (default) = TRUE -> logout de frota inteira no 1o reconnect pos-deploy (dashboards de parede, disableAuth). Fix R6: (decoded.tv ?? 0) grandfather; politica explicita de exp ausente. API keys legadas: key.created_by NULL -> 403 em toda key no flip (verificado api_key usa user_id, nao created_by). Fix R2: usar key.user_id, key legada->viewer.
7. 'user_id audit-only' e FALSO enquanto api_key.user_id e remote_instance.user_id sao onDelete CASCADE (verificado): deletar um user destroi keys/agentes de federacao do team (para de forwardar heartbeats). Neutralizar exige FK-alter = rebuild de tabela no SQLite — a exata promessa 'sem rebuild' quebrada. Fix R9: rebuild das 2 tabelas pequenas (nao a monitor de 60 cols) OU proibir delete-de-user na UI. DECISAO DO DONO necessaria antes de P1.
8. Baseline ~14% sob mudanca Tier-3 de auth + room refactor toca sinal real-time central (heartbeats). Mitigacao: TDD do authz.js e de cada leak-path antes de fiar; room refactor por ULTIMO (P4) atomico com TODOS emit sites (push/federacao/cloudflared) atras da flag; testes negativos cross-tenant (viewer-nao-muta, team-A-nao-le/escreve-team-B via socket/HTTP/push/federacao/badge/tag/maintenance-join) como gate de merge; DB via testcontainers (Docker).

## Anexo D — Esforço estimado

Grande. 7 fases; 4 Tier-3 exigindo Go humano. Estimativa bruta 8-11 semanas de 1 dev senior (revisada PARA CIMA vs 6-9 sem por causa das correcoes verificadas do red-team, excl. revisao/Go). Dominada por: (1) migracao cross-DB validada em 4 engines FKs-ON incluindo o FK-alter/rebuild R9 e o backfill por-tabela R1 (~1.5-2 sem, gargalo Docker); (2) enforcement P3 AGORA com ~15 gates a mais (R4 — status-page, tags, maintenance-joins, heartbeat handlers), a validacao FK cross-resource (R5) e a regra hard de team_id em freeze-mode (R3) sobre baseline ~14% (~2.5-3 sem, pesado em testes); (3) room refactor atomico com push/federacao emit sites + E2E 2-teams cobrindo monitor push E federado (R7, ~1-1.5 sem, alto risco); (4) frontend admin (~1.5 sem). Hardening (audit_log, token_version, isMonitorPublic R8, /metrics gate, constant-time) ~1 sem. Risco de balloon concentrado em P1/P3/P4; P0/P5/P6 sao T2 paralelizaveis. TRAVAR D6, D8/R1, R9 e R2 antes de iniciar para nao incorrer 2a migracao nem retrabalho de FK.
