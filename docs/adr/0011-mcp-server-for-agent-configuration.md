# ADR-0011: Servidor MCP para configuração por agentes de IA

- **Status:** Accepted
- **Data:** 2026-07-05

## Contexto

Queremos permitir que um agente de IA configure o SuperKuma — adicionar/editar monitores, notificações, tags, status pages e janelas de manutenção — via [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

Restrições do que já existe:

- Toda a superfície de configuração já é exposta como handlers **Socket.io** (`add`, `editMonitor`, `addNotification`, `saveStatusPage`, `addMaintenance`, …), cada um protegido por `checkLogin(socket)` + RBAC `requireResource` (ADR-0004, ADR-0010).
- A REST pública (`server/routers/`) só cobre badges, push, status-page e `/metrics` — **não há CRUD REST** de monitores/notificações/etc.
- A autenticação do dashboard é `login`/`loginByToken` (usuário+senha → JWT). Já existe uma infraestrutura de **API keys** (`api_key`, `verifyAPIKey`, `buildActorForApiKey`), mas usada apenas para o basic-auth do `/metrics`.

## Decisão

O servidor MCP é um **cliente Socket.io** independente em `server/mcp/`, que autentica em uma instância SuperKuma em execução e aciona os handlers de socket já existentes. Ele **não adiciona nenhuma superfície de autorização própria**: herda `checkLogin` + RBAC de cada handler.

- **Autenticação headless:** adicionamos o evento de socket `loginByApiKey`, que reutiliza `verifyAPIKey` (agora exportado de `server/auth.js`) e escopa a sessão via `buildActorForApiKey` (least-privilege; nunca herda o superadmin do dono — ADR-0010 R2). O agente guarda um token de API key (`uk<id>_<secret>`), nunca uma senha; a key é revogável e expirável.
- **Transporte:** stdio (o host do agente sobe o MCP como processo filho) **e HTTP remoto** — a própria instância expõe um endpoint `/mcp` (Streamable HTTP, router Express montado em `server/server.js`), desligado por padrão via `SUPERKUMA_MCP_HTTP_ENABLED`. O endpoint HTTP autentica por `Authorization: Bearer <api-key>` e abre uma sessão Socket.io loopback (`loginByApiKey`) por conexão, reusando os mesmos tools. Consome-se via `mcp-remote` (o diálogo de conector nativo do Claude usa OAuth, não header — fora do escopo por ora).
- **SDK:** `@modelcontextprotocol/sdk` (dual CJS/ESM); `zod` define os schemas de entrada (dupla função: schema MCP + validação em runtime). `socket.io-client` e `zod` já eram dependências.
- **Segurança por padrão:** read-only por padrão; escrita exige `SUPERKUMA_ALLOW_MUTATIONS=true`; delete exige `SUPERKUMA_ALLOW_DELETE=true` **e** `confirm:true` por chamada.
- **Complemento mínimo:** adicionamos o evento `getStatusPageList` (read-only), pois as status pages eram a única área sem evento de refresh de lista sob demanda, diferente de `getMonitorList`/`getMaintenanceList`.

## Consequências

- (+) Blast radius mínimo: `server/server.js`/`monitor.js` praticamente intocados; nenhuma mudança de schema de DB.
- (+) Reaproveita toda a autorização e a validação (`Monitor.validate`, providers de notificação) do servidor.
- (+) Token revogável/expirável e escopado por RBAC — mais seguro que senha em texto plano.
- (+) Pacote autocontido (`server/mcp/`), fácil de evoluir por fase (monitores → notificações/tags → status pages/manutenção).
- (−) `loginByApiKey` é um **novo caminho de autenticação** (Tier T3): tocou o modelo de auth e exigiu "Go" humano.
- (−) O cliente MCP depende do servidor estar no ar e acessível via Socket.io (`ws(s)://`/`http(s)://`).
- (−) `list_notifications`/`list_status_pages` refletem o estado do cache (login + mutações da própria sessão + refresh sob demanda quando há evento), não um snapshot transacional multi-cliente.
- (−) O endpoint HTTP `/mcp` é uma superfície externa capaz de mutação, protegida só pela API key no header — por isso vem **desligada por padrão** e deve ficar atrás de TLS + proxy confiável. Cada sessão abre uma conexão Socket.io loopback (indireto, mas reusa 100% do código dos tools).

## Alternativas consideradas

- **Nova API REST autenticada para o MCP:** exigiria escrever uma superfície pública inteira (auth + CRUD) = grande blast radius e Tier T3 de API pública. Rejeitada.
- **Embutir o transporte MCP dentro de `server/server.js`:** cresceria o monólito (contra a regra do CLAUDE.md) e acoplaria o ciclo de vida do MCP ao boot do servidor. Rejeitada.
- **Autenticar com usuário+senha de um usuário de serviço:** funciona sem mudança de backend, mas o agente passaria a guardar uma senha em texto plano, sem revogação/expiração por credencial. Preterida em favor da API key.
