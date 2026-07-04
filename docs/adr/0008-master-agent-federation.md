# ADR-0008: Arquitetura Master-Agent (Federação de instâncias)

- **Status:** Accepted (planejado — execução tier-gated por fase, T3)
- **Data:** 2026-07-03
- **Relacionado:** [PRD Master-Agent](../prd/master-agent.md) · [ADR-0004 (Socket.io)](0004-socketio-primary-transport.md) · [ADR-0007 (segredos)](0007-defer-secret-encryption.md)

## Contexto

Gerenciamos monitoramento de múltiplos clientes, cada um rodando sua própria instância isolada do SuperKuma na infra local. Não há comunicação entre instâncias nem visão central — cada uma precisa ser acessada individualmente. Requisito decisivo: quando um serviço de um cliente cai, a notificação deve chegar **imediatamente** a uma instância central nossa.

O SuperKuma já possui a peça fundamental: o endpoint `/api/push/:pushToken` (`server/routers/api-router.js:47`) é um pipeline completo de ingestão de heartbeat externo (determineStatus → UptimeCalculator → notificação → store → emit). E o `socket.io-client` já é dependência (usado hoje só no frontend).

## Decisão

Adotar um modelo **Master-Agent (federação)** dentro do próprio SuperKuma, com as seguintes decisões:

1. **Setting `federation.role`**: `standalone` (default, comportamento atual) · `agent` · `master`.
2. **Monitor remoto = linha na tabela `monitor` com `remote_instance_id`** (NULL = local), alimentado externamente como um monitor `push`. Isso **reusa todo o pipeline downstream** (heartbeat, UptimeCalculator, status page, notificação, Prometheus) sem reescrita.
3. **Push, não Pull** (o requisito de notificação imediata elimina polling).
4. **Transporte faseado**: MVP sobre REST push generalizado → v2 sobre **conexão Socket.io persistente** (`socket.io-client` no servidor do agente), que também serve de **keepalive do agente**.
5. **Master híbrido**: a instância Master também roda seus próprios monitores locais além de agregar os agentes. A UI distingue local de remoto pelo label da instância.
6. **Notificação configurável (`master` | `agent` | `both`)** por-monitor/por-instância — o padrão para monitores remotos é decidido na config da instância.
7. **Detecção "agente caiu" ≠ "serviço caiu"**: a conexão socket.io viva (v2) ou um heartbeat de instância periódico (MVP) é o sinal de vida do agente; seu silêncio marca a instância como stale e notifica.
8. **Isolamento de código**: toda a lógica nova vive em `server/federation/` + um novo model + uma migration, minimizando divergência com o upstream.

## Consequências

- (+) Reuso máximo: o pipeline de heartbeat/uptime/notificação/status-page funciona para monitores remotos sem alteração.
- (+) MVP entregável rápido (generalização do `/api/push`), valor incremental.
- (+) Visão unificada de todos os clientes num painel.
- (−) Nova superfície de autenticação (Agent→Master) — **reforça o caso do ADR-0007**, pois o Master passará a armazenar tokens de agentes.
- (−) Cresce o volume de dados no Master (N clientes × M monitores) — recomendável MariaDB no Master e retenção agressiva.
- (−) Notificação configurável "both" adiciona complexidade de política vs. um simples "master-only".
- (−) Feature grande e específica do fork → merge com upstream mais difícil (aceitável: fork privado, ver política em `CLAUDE.md`).

## Alternativas consideradas

- **Push monitors manuais** (configurar cada monitor local do agente com uma push-URL apontando pro Master): funciona hoje, mas não escala (token por-monitor, sem `instance_id`, sem agregação nativa) — vira o *MVP*, não a solução final.
- **Pull/polling** (Master consulta agentes): rejeitado — não é tempo real e o SuperKuma não expõe API REST rica de status.
- **Ferramenta externa de agregação** (Grafana/Prometheus federando os `/metrics`): perde a UX nativa do SuperKuma (status pages, HeartbeatBar, incidentes) e não atende "notificação imediata via a própria ferramenta".
