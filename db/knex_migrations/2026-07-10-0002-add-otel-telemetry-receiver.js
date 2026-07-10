/**
 * Migration: OTLP telemetry receiver foundation (ADR-0015, TASK-A2-2).
 *
 * Additive and dark by construction. `team.otel_ingest_token` starts NULL on
 * every team (no ingest endpoint is reachable for a team until an admin
 * generates one), and no monitor has `type = "otel"` on an existing install,
 * so the new /v1/metrics receiver has nothing to authenticate or route to
 * until a human deliberately opts in. Reuses the existing generic
 * jsonPath/jsonPathOperator/expectedValue columns for the threshold
 * condition (same calling convention as monitor-types/prometheus.js) instead
 * of inventing otel-specific condition columns -- "núcleo de avaliação
 * compartilhado" per the ADR.
 */

/**
 * Apply team.otel_ingest_token and the monitor.otel_* selector columns.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("team", "otel_ingest_token"))) {
        await knex.schema.alterTable("team", (table) => {
            table
                .string("otel_ingest_token", 64)
                .nullable()
                .unique()
                .comment("Bearer token for POST /v1/metrics (ADR-0015) -- NULL = ingest disabled for this team");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "otel_metric_name"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("otel_metric_name", 255)
                .nullable()
                .comment("type=otel selector: OTLP metric name to match, e.g. http.server.request.duration");
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "otel_attribute_matchers"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .text("otel_attribute_matchers")
                .nullable()
                .comment('type=otel selector: JSON object of attribute key:value matchers, e.g. {"service":"payments"}');
        });
    }

    if (!(await knex.schema.hasColumn("monitor", "otel_aggregation"))) {
        await knex.schema.alterTable("monitor", (table) => {
            table
                .string("otel_aggregation", 20)
                .notNullable()
                .defaultTo("last")
                .comment("type=otel: last|avg|max|sum -- how to combine multiple matched datapoints in one ingest batch");
        });
    }
};

/**
 * Revert: drop the otel_ingest_token and otel_* selector columns.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasColumn("monitor", "otel_aggregation")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("otel_aggregation");
        });
    }

    if (await knex.schema.hasColumn("monitor", "otel_attribute_matchers")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("otel_attribute_matchers");
        });
    }

    if (await knex.schema.hasColumn("monitor", "otel_metric_name")) {
        await knex.schema.alterTable("monitor", (table) => {
            table.dropColumn("otel_metric_name");
        });
    }

    if (await knex.schema.hasColumn("team", "otel_ingest_token")) {
        await knex.schema.alterTable("team", (table) => {
            table.dropColumn("otel_ingest_token");
        });
    }
};
