/**
 * Migration: Grafana-style dashboard builder (ADR-0017), evolving the ADR-0016
 * team dashboards.
 *
 * Purely ADDITIVE over ADR-0016 -- no table rename, so existing dashboards and
 * widgets survive untouched:
 *
 * `dashboard` gains:
 *   - `slug`   : the public URL key (`/dashboard/<slug>`), globally unique like
 *                `status_page.slug`. Backfilled for existing rows from the title
 *                plus the id suffix (titles are only unique per team, the id makes
 *                it globally unique). Left nullable at the DB level -- the app
 *                (createDashboard) always assigns one; the UNIQUE index below only
 *                constrains the non-null values.
 *   - `published`        : the public/internal toggle (ADR-0017 D3). Defaults to
 *                          false -- a dashboard is never public until explicitly
 *                          published.
 *   - `description` / `refresh_interval` / `theme` : parity with `status_page`.
 *
 * `dashboard_widget` gains grid geometry so a panel is POSITIONED (Grafana-style
 * drag-and-drop grid) instead of only ordered:
 *   - `pos_x` / `pos_y` / `width` / `height` : 12-column grid units.
 *   - `title`       : optional per-panel title.
 *   - `config_json` : per-panel options (unit, thresholds, colors, min/max; and,
 *                     in ADR-0017 Phase 2, the direct query).
 * The `kind` column is unchanged (varchar(20), app-level enum) -- Phase 1 just
 * widens the accepted values (+ trend / pie / speedometer / stat), no schema
 * change. `monitor_id` stays NOT NULL in Phase 1 (every panel references a
 * monitor); making it nullable is deferred to the Phase 2 migration to avoid a
 * risky SQLite table rebuild now.
 *
 * Existing widgets are backfilled with a stacked layout (pos_y from sort_order)
 * so they don't overlap when first rendered on the grid.
 *
 * Idempotent: guarded by `hasColumn`, so a re-run is a no-op. Reversible: `down`
 * drops exactly the columns/index this migration added.
 */

/**
 * Slugify a dashboard title into the `[a-z0-9-]+` charset used by the public
 * route (same shape as `status_page` slugs).
 * @param {string} title The dashboard title.
 * @returns {string} A slug fragment (never empty).
 */
function slugifyTitle(title) {
    const base = String(title || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    return base || "dashboard";
}

/**
 * Apply the Grafana-style dashboard columns.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("dashboard", "slug"))) {
        await knex.schema.alterTable("dashboard", (table) => {
            table.string("slug", 255).nullable();
            table.boolean("published").notNullable().defaultTo(false);
            table.text("description").nullable();
            table.integer("refresh_interval").notNullable().defaultTo(300);
            table.string("theme", 30).notNullable().defaultTo("auto");
        });

        // Backfill a globally-unique slug for every existing dashboard before
        // the UNIQUE index is created (title is only unique per team, so the id
        // suffix guarantees global uniqueness).
        const dashboards = await knex("dashboard").select("id", "title");
        for (const row of dashboards) {
            await knex("dashboard")
                .where("id", row.id)
                .update({ slug: `${slugifyTitle(row.title)}-${row.id}` });
        }

        await knex.schema.alterTable("dashboard", (table) => {
            table.unique(["slug"], "dashboard_slug_unique");
        });
    }

    if (!(await knex.schema.hasColumn("dashboard_widget", "pos_x"))) {
        await knex.schema.alterTable("dashboard_widget", (table) => {
            table.integer("pos_x").notNullable().defaultTo(0);
            table.integer("pos_y").notNullable().defaultTo(0);
            table.integer("width").notNullable().defaultTo(4);
            table.integer("height").notNullable().defaultTo(4);
            table.string("title", 255).nullable();
            table.text("config_json").nullable();
        });

        // Stack existing widgets vertically by their old sort_order so they do
        // not all overlap at (0,0) when the grid first renders.
        const widgets = await knex("dashboard_widget").select("id", "sort_order");
        for (const w of widgets) {
            await knex("dashboard_widget")
                .where("id", w.id)
                .update({ pos_y: (w.sort_order || 0) * 4 });
        }
    }
};

/**
 * Revert: drop exactly the columns/index this migration added.
 * @param {object} knex A Knex instance.
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    if (await knex.schema.hasColumn("dashboard", "slug")) {
        await knex.schema.alterTable("dashboard", (table) => {
            table.dropUnique(["slug"], "dashboard_slug_unique");
        });
        await knex.schema.alterTable("dashboard", (table) => {
            table.dropColumn("slug");
            table.dropColumn("published");
            table.dropColumn("description");
            table.dropColumn("refresh_interval");
            table.dropColumn("theme");
        });
    }

    if (await knex.schema.hasColumn("dashboard_widget", "pos_x")) {
        await knex.schema.alterTable("dashboard_widget", (table) => {
            table.dropColumn("pos_x");
            table.dropColumn("pos_y");
            table.dropColumn("width");
            table.dropColumn("height");
            table.dropColumn("title");
            table.dropColumn("config_json");
        });
    }
};
