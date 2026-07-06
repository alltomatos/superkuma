/**
 * Bundled status-page themes.
 *
 * Each theme only sets CSS custom properties on `.status-page-root` (the
 * semantic contract StatusPage.vue exposes -- see its <style> block) plus,
 * occasionally, a couple of structural tweaks. Themes never hardcode
 * SuperKuma's internal class names directly, so they keep working across
 * upgrades even if internal markup changes -- unlike hand-written CSS that
 * targets `.shadow-box`/`.item` etc, which breaks the moment those rename.
 *
 * "Use this theme" writes `css` into the status page's existing customCSS
 * field (see ThemeGallery.vue) -- there is no separate schema/column for
 * this, so it works with the status page save flow as-is and the user can
 * still hand-edit the result afterwards.
 *
 * To add a theme: append an entry here. `id` must be unique and stable
 * (used as the marker in the generated CSS, see ThemeGallery.vue).
 */

export const statusPageThemes = [
    {
        id: "compact",
        name: "Alta Densidade",
        description: "Menos espaço em branco, fonte menor -- cabe muito mais monitores na tela sem rolar.",
        swatch: ["#5cdd8b", "#dc3545", "#0d1117"],
        css: `.status-page-root {
    --sk-gap: 0.5rem;
    --sk-card-padding: 4px 8px;
    --sk-card-radius: 6px;
    --sk-font-size-base: 0.85rem;
}`,
    },
    {
        id: "noc-dark",
        name: "NOC Escuro",
        description: "Fundo escuro fixo e cores de status bem saturadas -- feito para telão de sala de operação.",
        swatch: ["#22c55e", "#ef4444", "#0a0e14"],
        css: `.status-page-root {
    --sk-bg: #0a0e14;
    --sk-text-color: #e6edf3;
    --sk-card-padding: 10px 14px;
    --sk-card-radius: 8px;
    --sk-card-shadow: none;
    --sk-font-size-base: 1.05rem;
    --sk-color-up: #22c55e;
    --sk-color-down: #ef4444;
    --sk-color-pending: #f59e0b;
    --sk-color-maintenance: #3b82f6;
}`,
    },
    {
        id: "tv-wall",
        name: "Painel de TV",
        description: "Fonte grande e bastante espaçamento -- pensado para ser lido de longe, num monitor na parede.",
        swatch: ["#5cdd8b", "#dc3545", "#f8f9fa"],
        css: `.status-page-root {
    --sk-gap: 2rem;
    --sk-card-padding: 16px 20px;
    --sk-card-radius: 14px;
    --sk-font-size-base: 1.3rem;
}`,
    },
    {
        id: "minimal",
        name: "Minimalista",
        description: "Sem sombra, bordas finas, paleta neutra -- para embutir a página dentro de outro site.",
        swatch: ["#111827", "#6b7280", "#f3f4f6"],
        css: `.status-page-root {
    --sk-gap: 0.75rem;
    --sk-card-padding: 8px 12px;
    --sk-card-radius: 2px;
    --sk-card-shadow: none;
    --sk-color-up: #111827;
    --sk-color-down: #6b7280;
}`,
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
