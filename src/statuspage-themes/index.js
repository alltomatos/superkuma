/**
 * Bundled status-page themes.
 *
 * Each theme is just a preset of values for the semantic CSS variable
 * contract StatusPageThemeCustomizer.vue exposes as structured controls (see
 * build-css.js). Themes never hardcode SuperKuma's internal class names, so
 * they keep working across upgrades even if internal markup changes --
 * unlike hand-written CSS that targets `.shadow-box`/`.item` etc, which
 * breaks the moment those rename.
 *
 * Picking a theme just loads its `vars` into the customizer's controls --
 * from there it's no different from a manually-tweaked look, and the user
 * can keep adjusting sliders/pickers on top of it.
 *
 * To add a theme: append an entry here with a `vars` object using only keys
 * from DEFAULT_VARS (see build-css.js). `id` must be unique.
 */

export const statusPageThemes = [
    {
        id: "compact",
        name: "Alta Densidade",
        description: "Menos espaço em branco, fonte menor -- cabe muito mais monitores na tela sem rolar.",
        swatch: ["#5cdd8b", "#dc3545", "#0d1117"],
        vars: {
            gap: "0.5rem",
            cardPadding: "4px 8px",
            cardRadius: "6px",
            fontSizeBase: "0.85rem",
        },
    },
    {
        id: "noc-dark",
        name: "NOC Escuro",
        description: "Fundo escuro fixo e cores de status bem saturadas -- feito para telão de sala de operação.",
        swatch: ["#22c55e", "#ef4444", "#0a0e14"],
        vars: {
            bg: "#0a0e14",
            textColor: "#e6edf3",
            cardPadding: "10px 14px",
            cardRadius: "8px",
            cardShadow: "none",
            fontSizeBase: "1.05rem",
            colorUp: "#22c55e",
            colorDown: "#ef4444",
            colorPending: "#f59e0b",
            colorMaintenance: "#3b82f6",
        },
    },
    {
        id: "tv-wall",
        name: "Painel de TV",
        description:
            "Fonte grande, bastante espaçamento e colunas -- pensado para ser lido de longe, num monitor na parede.",
        swatch: ["#5cdd8b", "#dc3545", "#f8f9fa"],
        vars: {
            gap: "2rem",
            cardPadding: "16px 20px",
            cardRadius: "14px",
            fontSizeBase: "1.3rem",
            columns: "2",
        },
    },
    {
        id: "minimal",
        name: "Minimalista",
        description: "Sem sombra, bordas finas, paleta neutra -- para embutir a página dentro de outro site.",
        swatch: ["#111827", "#6b7280", "#f3f4f6"],
        vars: {
            gap: "0.75rem",
            cardPadding: "8px 12px",
            cardRadius: "2px",
            cardShadow: "none",
            colorUp: "#111827",
            colorDown: "#6b7280",
        },
    },
];

/**
 * Look up a bundled theme by id.
 * @param {string} id Theme id
 * @returns {object|undefined} The theme, if found
 */
export function findStatusPageTheme(id) {
    return statusPageThemes.find((t) => t.id === id);
}
