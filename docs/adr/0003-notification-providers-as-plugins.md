# ADR-0003: Provedores de notificação como plugins

- **Status:** Accepted (documenta o existente)
- **Data:** 2026-07-03

## Contexto

O produto integra 90+ canais de notificação (Discord, Slack, Teams, Telegram, e-mail, SMS, PagerDuty, Gotify, ntfy, …). Cada um tem API e payload próprios.

## Decisão

Cada canal é uma classe em `server/notification-providers/` que estende `NotificationProvider` e implementa `async send(notification, msg, monitorJSON, heartbeatJSON)`. A base class oferece utilitários comuns (`renderTemplate` via LiquidJS, `throwGeneralAxiosError`, `extractAddress`). Registro central em `server/notification.js`.

## Consequências

- (+) Escalável e uniforme; templates customizáveis por canal (LiquidJS).
- (+) Cada provider é auto-contido e revisável isoladamente.
- (−) Todos os 90+ providers são importados no **boot** (eager) — custo de startup/memória (GAP-005).
- (−) Credenciais dos canais ficam em texto plano no DB — ver [ADR-0007](0007-defer-secret-encryption.md).

## Alternativas consideradas

- Webhook genérico só: insuficiente para a UX rica de cada canal.
