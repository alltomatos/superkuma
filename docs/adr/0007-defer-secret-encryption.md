# ADR-0007: Adiar cifragem de segredos at rest

- **Status:** Accepted (deferred) — reavaliar (ver gatilho abaixo)
- **Data:** 2026-07-03

## Contexto

A auditoria (GAP-001) identificou que credenciais de monitor (`basic_auth_pass`, `bearer_token`, `oauth_client_secret`, connection strings de DB), tokens de notificação e o **JWT secret** são gravados em **texto plano** no banco. É um trade-off histórico e conhecido do SuperKuma. Cifrar exige mudança de schema, migration de dados existentes, gestão de chave fora do DB e mascaramento nas respostas de API (tarefa T3, bloqueante).

## Decisão

Nós **NÃO** vamos cifrar segredos at rest **por enquanto**. O foco atual é documentação de domínio (CONTEXT.md, ADRs) e a rede de testes, não mudanças de schema/auth. A tarefa fica registrada como `TASK-090` em `.claude/ESTADO_ORQUESTRATOR.md` com status **deferred**.

## Consequências

- (+) Evita mudança T3 arriscada agora; mantém compatibilidade e o momentum de padronização/docs.
- (−) O risco de GAP-001 permanece: vazamento de DB/backup expõe todas as credenciais monitoradas.
- **Mitigação enquanto adiado:** deploy single-user/confiável; proteger o arquivo de banco e backups; segmentação de rede; não usar em cenário multi-tenant/compartilhado.

## Gatilho de reavaliação

Reabrir esta decisão (e retomar `TASK-090`) se: (a) o deploy virar multi-tenant/compartilhado, (b) houver requisito de compliance, ou (c) o banco/backup passar a residir em ambiente menos confiável.

## Alternativas consideradas

- Cifrar agora (AES-256-GCM + chave em env/HSM + migration): correto a médio prazo, mas fora do escopo atual — adiado, não descartado.
