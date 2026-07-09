# ADR-0001: Persistência híbrida — redbean-node (runtime) + Knex (migrations)

- **Status:** Accepted (documenta o existente)
- **Data:** 2026-07-03

## Contexto

O app precisa suportar múltiplos engines (MariaDB, SQLite, MySQL, Postgres) com schema evoluindo ao longo de 50+ migrations. Duas necessidades distintas: consultas de runtime simples/ágeis e evolução de schema versionada e reprodutível.

> **Atualização (2026-07-09):** o `compose.yaml` público (deploy novo via Docker Compose) passou a provisionar MariaDB por padrão, com auto-configuração via `SUPERKUMA_DB_*` env vars — o wizard de escolha de banco é pulado inteiramente nesse caminho. SQLite continua um engine plenamente suportado (instâncias existentes não são afetadas; ainda é a opção recomendada para standalone pequeno via `npm run setup` ou `docker run` manual, pelo wizard).

## Decisão

Nós usamos **redbean-node** como ORM de runtime (`R.find`, `R.dispense`, `R.exec`, `BeanModel`) e **Knex** exclusivamente para migrations (`db/knex_migrations/`). Patches SQL legados (`db/old_migrations/`) são **deprecados** — toda nova mudança de schema é uma migration Knex.

## Consequências

- (+) Consultas de runtime enxutas; migrations versionadas e multi-dialeto.
- (+) `server/database.js` centraliza conexão, pooling e patch por dialeto.
- (−) Duas mentais de acesso a dados no mesmo repo (RedBean vs Knex).
- (−) Modelos são "thin beans": sem camada de validação — validação vaza para routers/handlers (ver GAP-004).
- (−) Tabelas `stat_*` não têm BeanModel (acesso via `R.dispense` cru) — ver [ADR-0005](0005-in-memory-uptime-aggregation.md).

## Alternativas consideradas

- ORM único (Knex query builder em tudo): mais verboso no runtime.
- TypeORM/Prisma: migração custosa e peso adicional para o escopo self-hosted.
