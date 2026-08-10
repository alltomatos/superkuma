# ADR-0018: MCP — o papel da API key é o único controle de escrita/delete (fim dos gates por env var)

- **Status:** Accepted
- **Data:** 2026-08-10
- **Supera parcialmente:** [ADR-0011](0011-mcp-server-for-agent-configuration.md) (mantém tudo, exceto a decisão de "segurança por padrão" via `SUPERKUMA_ALLOW_MUTATIONS`/`SUPERKUMA_ALLOW_DELETE`)

## Contexto

A ADR-0011 introduziu duas env vars como gate adicional sobre as ferramentas MCP de escrita/delete: `SUPERKUMA_ALLOW_MUTATIONS=true` para expor `create_*`/`update_*`/`pause_*`/`resume_*`/`post_*`/`test_*`, e `SUPERKUMA_ALLOW_DELETE=true` (mais `confirm:true` por chamada) para expor `delete_*`. A ideia era um circuito-breaker do operador do servidor, independente do papel da API key.

Na prática esse duplo gate:

- Duplica uma decisão que já existe: o papel da API key (Owner/Admin/Editor/Viewer, ADR-0010) já decide exatamente isso — um Viewer nunca tem `monitor:create`/`monitor:delete` no catálogo de permissões, RBAC real, testado (`server/permissions/catalog.js`), aplicado por `requireResource` em cada handler de socket.
- Cria uma segunda fonte de verdade pra manter sincronizada com a primeira, sem ganho real de segurança: quem administra o deploy já escolhe o papel da key no momento da criação (_Settings → API Keys → Add API Key_) — a env var de servidor não impede nada que o papel da key já não impeça, só adiciona um passo de configuração fácil de esquecer (e de "esquecer" na direção errada: setar `true` "só pra testar" e nunca desligar).
- Gerou confusão real em campo: uma key criada com papel Editor, `SUPERKUMA_ALLOW_MUTATIONS=true` no servidor, e a chamada ainda falhando por outro motivo (ex: RBAC de fato negando por um motivo diferente) exige debugar duas camadas de autorização em vez de uma.

## Decisão

As ferramentas MCP de escrita/delete deixam de ser gateadas por `SUPERKUMA_ALLOW_MUTATIONS`/`SUPERKUMA_ALLOW_DELETE`. **As 39 ferramentas são sempre registradas**; o que uma chamada específica pode de fato fazer é decidido inteiramente pelo RBAC por trás de cada handler de socket (`checkLogin` + `requireResource`), exatamente como já era pra qualquer usuário do dashboard — o MCP nunca teve superfície de autorização própria (ADR-0011 já estabelecia isso; esta ADR só remove a camada extra que contradizia esse princípio).

- `server/mcp/tools/helpers.js`: `registerTool` não recebe mais `config.allowMutations`/`config.allowDelete` como condição de registro.
- `server/mcp/config.js`: `loadGates()`/`loadConfig()` não leem mais `SUPERKUMA_ALLOW_MUTATIONS`/`SUPERKUMA_ALLOW_DELETE`.
- `server/routers/mcp-router.js`: o endpoint HTTP `/mcp` para de repassar esses campos pro config de sessão.
- `get_info` deixa de reportar `mutationsEnabled`/`deleteEnabled` (que refletiam a env var) e passa a reportar `permissions.canCreateMonitors`/`canUpdateMonitors`/`canDeleteMonitors` (derivados das permissões reais do papel ativo) — informação que efetivamente responde "o que essa key pode fazer", ao contrário do campo antigo.
- **`confirm: true` por chamada continua obrigatório** em todo `delete_*`, independente do papel — não é um gate de autorização (quem pode) mas uma rede de segurança mecânica contra uma invocação acidental (não confundir os dois).
- `SUPERKUMA_MCP_HTTP_ENABLED` **não muda** — continua controlando se o endpoint `/mcp` é servido ou não; isso é uma decisão diferente ("expor a superfície") da que esta ADR trata ("o que a superfície permite uma vez exposta").

## Consequências

- (+) Uma única fonte de verdade sobre "o que esta key pode fazer": o papel dela. Elimina uma classe inteira de bug de configuração (env var dessincronizada do papel real).
- (+) `get_info` agora responde a pergunta certa ("o que EU posso fazer com esta key", derivado do RBAC real) em vez de uma pergunta proxy ("o servidor está em modo permissivo").
- (+) Menos superfície de configuração pra documentar/lembrar ao subir uma instância nova.
- (−) Quem administra o servidor perde o circuito-breaker global independente do papel da key — pra restringir o que **qualquer** agente pode fazer numa instância inteira, a única alavanca agora é não emitir keys com papel Editor/Admin/Owner pra automação, e revogar/expirar as que existem (_Settings → API Keys_). Não há mais um "modo leitura forçada" cego a papéis.
- (−) Uma key Editor/Owner/Admin vazada volta a ser, sozinha, um credencial completo de escrita/delete contra o RBAC dela — sem a segunda camada que a ADR-0011 adicionava. Mitigação: tratar toda key acima de Viewer como segredo de produção (rotação, escopo mínimo, nunca commitada), igual a qualquer outra credencial de escrita do sistema.

## Alternativas consideradas

- **Manter as duas env vars, só documentar melhor o duplo gate:** não resolve a duplicação de fonte de verdade nem a confusão de debug; só adia o problema. Rejeitada.
- **Mover o circuito-breaker pra nível de Team (ex: "esta team não aceita mutação via MCP")em vez de servidor inteiro:** mais preciso, mas exige schema novo e RBAC novo (Tier T3 maior) pra resolver um problema que o papel de key já resolve na prática. Fora de escopo por ora — revisitar se surgir demanda real por um breaker por-team.
