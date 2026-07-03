# Domain Docs

Como as skills de engenharia devem consumir a documentação de domínio deste repo ao explorar o codebase.

## Antes de explorar, leia

- **`CONTEXT.md`** na raiz (se existir) — glossário do domínio de monitoramento.
- **`docs/adr/`** — leia os ADRs que tocam a área em que você vai trabalhar.

Se algum desses arquivos não existir, **prossiga em silêncio**. Não sinalize a ausência nem sugira criá-los de antemão. A skill produtora (`/grill-with-docs`) os cria de forma preguiçosa, quando termos ou decisões forem de fato resolvidos.

## Vocabulário do domínio (Uptime Kuma)

Ao nomear um conceito de domínio (título de issue, proposta de refactor, hipótese, nome de teste), use o termo consistente com o código:

- **Monitor** — alvo monitorado (`server/model/monitor.js`, tipos em `server/monitor-types/`).
- **Heartbeat** — resultado de uma verificação (UP / DOWN / PENDING / MAINTENANCE).
- **Uptime Calculator** — agregador em memória de estatísticas (`server/uptime-calculator.js`).
- **Notification Provider** — canal de notificação (`server/notification-providers/`).
- **Status Page** — página pública de status (`server/model/status_page.js`).
- **Maintenance** — janela de manutenção agendada.

## Sinalize conflitos com ADR

Se sua saída contradiz um ADR existente, exponha isso explicitamente em vez de sobrescrever em silêncio:

> _Contradiz ADR-XXXX — mas vale reabrir porque…_
