<template>
    <div class="theme-customizer">
        <!-- Presets -->
        <div class="theme-grid">
            <div
                v-for="theme in themes"
                :key="theme.id"
                class="theme-card"
                :class="{ active: activeId === theme.id }"
                data-testid="theme-card"
                @click="applyPreset(theme)"
            >
                <div class="swatch">
                    <span v-for="(color, i) in theme.swatch" :key="i" :style="{ backgroundColor: color }"></span>
                </div>
                <div class="theme-name">{{ theme.name }}</div>
                <div class="theme-description">{{ theme.description }}</div>
            </div>
        </div>

        <!-- Structured controls -->
        <div class="customize-controls mt-3">
            <div class="my-2">
                <label class="form-label small" for="tc-density">{{ $t("Density") }}</label>
                <select id="tc-density" v-model="density" class="form-select form-select-sm" data-testid="tc-density">
                    <option value="comfortable">{{ $t("Comfortable") }}</option>
                    <option value="compact">{{ $t("Compact") }}</option>
                    <option value="dense">{{ $t("Dense") }}</option>
                </select>
            </div>

            <div class="my-2">
                <label class="form-label small" for="tc-columns">{{ $t("Columns") }}</label>
                <input
                    id="tc-columns"
                    v-model.number="vars.columns"
                    type="number"
                    min="1"
                    max="4"
                    class="form-control form-control-sm"
                    data-testid="tc-columns"
                    @input="emitChange"
                />
            </div>

            <div class="row my-2">
                <div class="col-6">
                    <label class="form-label small" for="tc-color-up">{{ $t("Up Color") }}</label>
                    <input
                        id="tc-color-up"
                        v-model="vars.colorUp"
                        type="color"
                        class="form-control form-control-color form-control-sm"
                        data-testid="tc-color-up"
                        @input="emitChange"
                    />
                </div>
                <div class="col-6">
                    <label class="form-label small" for="tc-color-down">{{ $t("Down Color") }}</label>
                    <input
                        id="tc-color-down"
                        v-model="vars.colorDown"
                        type="color"
                        class="form-control form-control-color form-control-sm"
                        data-testid="tc-color-down"
                        @input="emitChange"
                    />
                </div>
            </div>

            <div class="row my-2">
                <div class="col-6">
                    <label class="form-label small" for="tc-color-pending">{{ $t("Pending Color") }}</label>
                    <input
                        id="tc-color-pending"
                        v-model="vars.colorPending"
                        type="color"
                        class="form-control form-control-color form-control-sm"
                        data-testid="tc-color-pending"
                        @input="emitChange"
                    />
                </div>
                <div class="col-6">
                    <label class="form-label small" for="tc-color-maintenance">{{ $t("Maintenance Color") }}</label>
                    <input
                        id="tc-color-maintenance"
                        v-model="vars.colorMaintenance"
                        type="color"
                        class="form-control form-control-color form-control-sm"
                        data-testid="tc-color-maintenance"
                        @input="emitChange"
                    />
                </div>
            </div>

            <div class="my-2">
                <label class="form-label small" for="tc-radius">
                    {{ $t("Card Corner Radius") }} ({{ radiusPx }}px)
                </label>
                <input
                    id="tc-radius"
                    v-model.number="radiusPx"
                    type="range"
                    min="0"
                    max="24"
                    class="form-range"
                    data-testid="tc-radius"
                    @input="onRadiusInput"
                />
            </div>

            <div class="my-2 form-check form-switch">
                <input
                    id="tc-shadow"
                    v-model="shadowEnabled"
                    class="form-check-input"
                    type="checkbox"
                    data-testid="tc-shadow"
                    @change="onShadowToggle"
                />
                <label class="form-check-label small" for="tc-shadow">{{ $t("Card Shadow") }}</label>
            </div>

            <div class="my-2">
                <label class="form-label small" for="tc-font-size">
                    {{ $t("Base Font Size") }} ({{ fontSizeRem }}rem)
                </label>
                <input
                    id="tc-font-size"
                    v-model.number="fontSizeRem"
                    type="range"
                    min="0.7"
                    max="1.6"
                    step="0.05"
                    class="form-range"
                    data-testid="tc-font-size"
                    @input="onFontSizeInput"
                />
            </div>
        </div>
    </div>
</template>

<script>
import { statusPageThemes } from "../statuspage-themes";
import { DEFAULT_VARS, applyThemeBlock, readThemeBlock } from "../statuspage-themes/build-css";

// Concrete colors to show in the pickers when nothing has been customized
// yet -- mirrors $primary/$danger/$warning/$maintenance from assets/vars.scss.
const FALLBACK_COLORS = {
    colorUp: "#5cdd8b",
    colorDown: "#dc3545",
    colorPending: "#f8a306",
    colorMaintenance: "#1747f5",
};

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
        const parsed = readThemeBlock(this.modelValue);
        const vars = { ...DEFAULT_VARS, ...FALLBACK_COLORS, ...(parsed ? parsed.vars : {}) };
        return {
            themes: statusPageThemes,
            activeId: parsed ? parsed.id : null,
            vars,
            radiusPx: parseInt(vars.cardRadius, 10) || 10,
            shadowEnabled: vars.cardShadow !== "none",
            fontSizeRem: parseFloat(vars.fontSizeBase) || 1,
        };
    },
    computed: {
        density: {
            get() {
                if (this.vars.gap === "0.5rem") {
                    return "compact";
                }
                if (this.vars.gap === "0.25rem") {
                    return "dense";
                }
                return "comfortable";
            },
            set(value) {
                const presets = {
                    comfortable: { gap: "1.5rem", cardPadding: "10px", fontSizeBase: "1rem" },
                    compact: { gap: "0.5rem", cardPadding: "4px 8px", fontSizeBase: "0.85rem" },
                    dense: { gap: "0.25rem", cardPadding: "2px 6px", fontSizeBase: "0.75rem" },
                };
                Object.assign(this.vars, presets[value]);
                this.fontSizeRem = parseFloat(this.vars.fontSizeBase);
                this.emitChange();
            },
        },
    },
    methods: {
        /**
         * Load a bundled theme's vars into the controls, replacing any
         * previous customization (presets are complete states, not deltas).
         * @param {object} theme Theme to apply
         * @returns {void}
         */
        applyPreset(theme) {
            this.vars = { ...DEFAULT_VARS, ...FALLBACK_COLORS, ...theme.vars };
            this.radiusPx = parseInt(this.vars.cardRadius, 10) || 10;
            this.shadowEnabled = this.vars.cardShadow !== "none";
            this.fontSizeRem = parseFloat(this.vars.fontSizeBase);
            this.activeId = theme.id;
            this.emitChange();
        },

        /**
         * Sync the radius slider (px) into vars.cardRadius (with unit).
         * @returns {void}
         */
        onRadiusInput() {
            this.vars.cardRadius = `${this.radiusPx}px`;
            this.emitChange();
        },

        /**
         * Sync the shadow toggle into vars.cardShadow.
         * @returns {void}
         */
        onShadowToggle() {
            this.vars.cardShadow = this.shadowEnabled ? "0 15px 70px rgba(0, 0, 0, 0.1)" : "none";
            this.emitChange();
        },

        /**
         * Sync the font-size slider (rem) into vars.fontSizeBase.
         * @returns {void}
         */
        onFontSizeInput() {
            this.vars.fontSizeBase = `${this.fontSizeRem}rem`;
            this.emitChange();
        },

        /**
         * Regenerate the marker-delimited CSS block from the current vars
         * and emit the updated customCSS.
         * @returns {void}
         */
        emitChange() {
            this.activeId = this.activeId && this.themeMatchesVars(this.activeId) ? this.activeId : "custom";
            const next = applyThemeBlock(this.modelValue, this.activeId, this.vars);
            this.$emit("update:modelValue", next);
        },

        /**
         * Whether the current vars still match a given bundled theme exactly
         * (used to keep its card highlighted after re-applying, and to fall
         * back to "custom" once the user diverges from it).
         * @param {string} id Theme id to check against
         * @returns {boolean} Whether vars still match
         */
        themeMatchesVars(id) {
            const theme = this.themes.find((t) => t.id === id);
            if (!theme) {
                return false;
            }
            return Object.entries(theme.vars).every(([key, value]) => this.vars[key] === value);
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

.customize-controls {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 10px;
}

.form-control-color {
    width: 100%;
    height: 2rem;
}
</style>
