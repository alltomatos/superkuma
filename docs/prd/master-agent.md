# PRD — SuperKuma Master-Agent (Federação)

- **Status:** Draft / aprovado para planejamento
- **Data:** 2026-07-03
- **Decisão de arquitetura:** [ADR-0008](../adr/0008-master-agent-federation.md)
- **Tier de risco:** T3 (schema + auth + protocolo) — execução aprovada por fase.

---

## 1. Problema

Um provedor gerencia monitoramento de **múltiplos clientes**, cada um rodando sua própria instância isolada do SuperKuma na infra local. Sem comunicação entre instâncias: cada uma é acessada individualmente → caos operacional e zero visibilidade central. Quando um serviço de um cliente cai, não há alerta centralizado imediato.

## 2. Objetivo

Uma instância **Master** (do provedor) que recebe, em tempo real, o status de N instâncias **Agent** (nos clientes), agrega tudo num painel único rotulado por instância de origem, e notifica imediatamente.

## 3. Personas

- **Provedor / gestor de monitoramento (MSP)**: opera o Master, quer visão única de todos os clientes e alerta central.
- **Cliente**: opera um Agent, continua com seu monitoramento local funcionando normalmente.

## 4. User stories

1. Como MSP, vejo num painel único o status de todos os clientes, cada monitor rotulado pela instância de origem.
2. Como MSP, sou notificado imediatamente quando um serviço de qualquer cliente cai.
3. Como MSP, sou avisado quando um **Agent inteiro** fica offline (distinto de "serviços do cliente caíram").
4. Como cliente, meu SuperKuma continua monitorando local em tempo real, e opcionalmente encaminha status ao Master com um `instance_id` único.
5. Como cliente, escolho se as notificações disparam localmente, só no Master, ou em ambos.
6. Como MSP, o Master também monitora meus próprios serviços locais, lado a lado com os agregados.

## 5. Escopo

**Dentro:**
- Papel de instância (`standalone`/`agent`/`master`).
- Registro de Agent no Master com `instance_id` + token.
- Encaminhamento de heartbeats Agent→Master (REST no MVP, Socket.io na v2).
- Monitores remotos espelhados no Master (`remote_instance_id`), reusando o pipeline existente.
- Painel unificado com label de instância + agrupamento/filtro.
- Política de notificação configurável (master/agent/both).
- Keepalive/detecção de Agent offline.

**Fora (por ora):**
- Controle remoto (Master editar/pausar monitores no Agent) — só leitura/agregação.
- Multi-tenancy com isolamento por-usuário no Master.
- Balanceamento/HA de múltiplos Masters.

## 6. Critérios de aceite (por fase — ver §7)

- Ponta-a-ponta: um Agent real encaminha heartbeats; o Master exibe o monitor rotulado e notifica na mudança de estado.
- Agent offline → Master marca a instância stale e notifica dentro de 1 intervalo de keepalive.
- Comportamento `standalone` (default) **inalterado** — nenhuma regressão nas suítes backend (259) e E2E (26).
- Payload malformado de agente é rejeitado com erro claro (reusar a camada zod do EPIC-3).

## 7. Rollout faseado (Epics)

| Epic | Entrega | Tier |
|---|---|---|
| **F0** Fundação | migration `remote_instance` + `monitor.remote_instance_id` + model + setting `federation.role` | T3 |
| **F1** Receptor (Master, MVP) | `/api/push` generalizado p/ `instance_id`+`agent_monitor_id`; espelha monitores | T2 |
| **F2** Forwarder (Agent, MVP) | hook no `beat()` + config master/token; ponta-a-ponta REST | T2 |
| **F3** UI unificada | badge de instância, agrupamento no dashboard, página de config | T2 |
| **F4** Federação Socket.io (v2) | `agent-client.js` persistente + keepalive + detecção "agente caiu" | T3 |
| **F5** Robustez | buffering offline, versionamento de protocolo, política de notificação configurável, sync rename/delete | T2 |

## 8. Métricas de sucesso

- Nº de instâncias agregadas num Master sem degradação perceptível.
- Latência mudança-de-estado no Agent → notificação no Master (alvo: < 5 s na v2).
- Zero regressão no modo `standalone`.

## 9. Riscos

Ver ADR-0008 §Consequências. Destaques: autenticação Agent→Master (liga ao ADR-0007), "agente caiu" vs "serviço caiu", escala de dados no Master, skew de versão.
