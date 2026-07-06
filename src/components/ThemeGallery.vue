<template>
    <div class="theme-gallery">
        <div class="theme-grid">
            <div
                v-for="theme in themes"
                :key="theme.id"
                class="theme-card"
                :class="{ active: activeThemeId === theme.id }"
                data-testid="theme-card"
                @click="apply(theme)"
            >
                <div class="swatch">
                    <span v-for="(color, i) in theme.swatch" :key="i" :style="{ backgroundColor: color }"></span>
                </div>
                <div class="theme-name">{{ theme.name }}</div>
                <div class="theme-description">{{ theme.description }}</div>
            </div>
        </div>
    </div>
</template>

<script>
import { statusPageThemes } from "../statuspage-themes";

const MARKER_START_PREFIX = "/* superkuma-theme:start:";
const MARKER_END = "/* superkuma-theme:end */";

/**
 * Build the self-contained comment marker for a given theme id.
 * @param {string} id Theme id
 * @returns {string} A single-line CSS comment
 */
function markerStart(id) {
    return `${MARKER_START_PREFIX}${id} */`;
}

export default {
    props: {
        /** The status page's current customCSS string (v-model) */
        modelValue: {
            type: String,
            default: "",
        },
    },
    emits: ["update:modelValue"],
    data() {
        return {
            themes: statusPageThemes,
        };
    },
    computed: {
        /**
         * Id of the theme currently embedded in modelValue, if any.
         * @returns {string|null} The active theme id, or null
         */
        activeThemeId() {
            const css = this.modelValue || "";
            const match = this.themes.find((t) => css.includes(markerStart(t.id)));
            return match ? match.id : null;
        },
    },
    methods: {
        /**
         * Apply a bundled theme by writing its CSS into customCSS, replacing
         * any previously-applied bundled theme block but preserving any other
         * hand-written CSS around it.
         * @param {object} theme Theme to apply
         * @returns {void}
         */
        apply(theme) {
            const block = `${markerStart(theme.id)}\n${theme.css}\n${MARKER_END}`;
            const current = this.modelValue || "";
            const startIdx = current.indexOf(MARKER_START_PREFIX);
            const endIdx = current.indexOf(MARKER_END);

            let next;
            if (startIdx !== -1 && endIdx !== -1) {
                next = current.slice(0, startIdx) + block + current.slice(endIdx + MARKER_END.length);
            } else if (current.trim() === "") {
                next = block;
            } else {
                next = `${current.trimEnd()}\n\n${block}`;
            }

            this.$emit("update:modelValue", next);
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars";

.theme-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
}

.theme-card {
    cursor: pointer;
    border: 2px solid transparent;
    border-radius: 8px;
    padding: 8px;
    background-color: rgba(0, 0, 0, 0.03);
    transition: border-color 0.15s;

    &:hover {
        border-color: $secondary-text;
    }

    &.active {
        border-color: $primary;
    }
}

.swatch {
    display: flex;
    height: 18px;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 6px;

    span {
        flex: 1;
    }
}

.theme-name {
    font-weight: bold;
    font-size: 0.9em;
}

.theme-description {
    font-size: 0.75em;
    color: $secondary-text;
}
</style>
