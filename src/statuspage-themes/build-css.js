/**
 * Semantic CSS variable contract for status-page theming.
 *
 * Every key here maps to a `--sk-*` custom property read by StatusPage.vue's
 * unscoped default block and consumed throughout its scoped styles /
 * PublicGroupList.vue. Bundled themes (see index.js) and the customizer's
 * structured controls (StatusPageThemeCustomizer.vue) both only ever
 * express themselves as a subset of these keys -- never SuperKuma's internal
 * class names -- so a look keeps working across markup refactors.
 *
 * DEFAULT_VARS mirrors the literal defaults declared in StatusPage.vue's
 * unscoped <style> block; keep the two in sync if you add a variable.
 */
export const DEFAULT_VARS = {
    gap: "1.5rem",
    cardPadding: "10px",
    cardRadius: "10px",
    cardShadow: "0 15px 70px rgba(0, 0, 0, 0.1)",
    bg: "transparent",
    textColor: "inherit",
    fontSizeBase: "1rem",
    columns: "1",
    colorUp: null, // theme's $primary -- left unset (null) so the SCSS default keeps applying
    colorDown: null, // $danger
    colorPending: null, // $warning
    colorMaintenance: null, // $maintenance
};

const CSS_VAR_NAMES = {
    gap: "--sk-gap",
    cardPadding: "--sk-card-padding",
    cardRadius: "--sk-card-radius",
    cardShadow: "--sk-card-shadow",
    bg: "--sk-bg",
    textColor: "--sk-text-color",
    fontSizeBase: "--sk-font-size-base",
    columns: "--sk-columns",
    colorUp: "--sk-color-up",
    colorDown: "--sk-color-down",
    colorPending: "--sk-color-pending",
    colorMaintenance: "--sk-color-maintenance",
};

export const MARKER_START_PREFIX = "/* superkuma-theme:start:";
export const MARKER_END = "/* superkuma-theme:end */";

/**
 * Build the self-contained comment marker for a given theme/customization id.
 * @param {string} id Theme id, or "custom" for a manually-tweaked look
 * @returns {string} A single-line CSS comment
 */
export function markerStart(id) {
    return `${MARKER_START_PREFIX}${id} */`;
}

/**
 * Render a vars object (only the keys that differ from DEFAULT_VARS need to
 * be present) into a `.status-page-root { --sk-x: v; ... }` CSS block.
 * @param {object} vars Partial map of DEFAULT_VARS keys to values
 * @returns {string} A CSS ruleset
 */
export function buildStatusPageThemeCss(vars) {
    const lines = Object.keys(CSS_VAR_NAMES)
        .filter((key) => vars[key] !== undefined && vars[key] !== null && vars[key] !== "")
        .map((key) => `    ${CSS_VAR_NAMES[key]}: ${vars[key]};`);

    return `.status-page-root {\n${lines.join("\n")}\n}`;
}

/**
 * Wrap a generated CSS block in the marker comments used to find/replace it
 * inside a status page's customCSS field.
 * @param {string} id Theme id, or "custom"
 * @param {object} vars Vars to render
 * @returns {string} The full marker-delimited block
 */
export function buildMarkedThemeBlock(id, vars) {
    return `${markerStart(id)}\n${buildStatusPageThemeCss(vars)}\n${MARKER_END}`;
}

/**
 * Replace any previously-applied bundled-theme/customizer block in a
 * customCSS string with a new one, preserving any other hand-written CSS
 * around it (appends if none exists yet).
 * @param {string} currentCss The status page's current customCSS
 * @param {string} id Theme id, or "custom"
 * @param {object} vars Vars to render
 * @returns {string} The updated customCSS
 */
export function applyThemeBlock(currentCss, id, vars) {
    const block = buildMarkedThemeBlock(id, vars);
    const current = currentCss || "";
    const startIdx = current.indexOf(MARKER_START_PREFIX);
    const endIdx = current.indexOf(MARKER_END);

    if (startIdx !== -1 && endIdx !== -1) {
        return current.slice(0, startIdx) + block + current.slice(endIdx + MARKER_END.length);
    }
    if (current.trim() === "") {
        return block;
    }
    return `${current.trimEnd()}\n\n${block}`;
}

/**
 * Parse the vars currently embedded in a customCSS string's marker block,
 * if any -- used to pre-fill the customizer's controls when it opens.
 * @param {string} currentCss The status page's current customCSS
 * @returns {{ id: string, vars: object }|null} The parsed id + vars, or null
 */
export function readThemeBlock(currentCss) {
    const current = currentCss || "";
    const startIdx = current.indexOf(MARKER_START_PREFIX);
    const endIdx = current.indexOf(MARKER_END);
    if (startIdx === -1 || endIdx === -1) {
        return null;
    }

    const idMatch = current.slice(startIdx).match(/^\/\* superkuma-theme:start:(.+?) \*\//);
    const id = idMatch ? idMatch[1] : "custom";

    const block = current.slice(startIdx, endIdx);
    const vars = {};
    for (const [key, cssVar] of Object.entries(CSS_VAR_NAMES)) {
        const re = new RegExp(`${cssVar.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}:\\s*([^;]+);`);
        const match = block.match(re);
        if (match) {
            vars[key] = match[1].trim();
        }
    }
    return { id, vars };
}
