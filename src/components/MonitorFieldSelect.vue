<template>
    <div class="my-3">
        <label :for="id" class="form-label">{{ label }}</label>
        <select
            :id="id"
            v-model="model"
            class="form-select"
            :class="{ 'is-invalid': invalid }"
            :required="required"
            :disabled="disabled"
            :data-testid="dataTestid"
        >
            <slot />
        </select>
        <div v-if="invalid" class="invalid-feedback">
            <slot name="error" />
        </div>
        <div class="form-text">
            <slot name="help" />
        </div>
    </div>
</template>

<script>
/**
 * Generic labeled <select> field for monitor edit forms.
 * Wraps the Bootstrap `form-label` + `form-select` + `form-text` markup
 * used throughout EditMonitor.vue. Options are provided via the default
 * slot so callers keep full control over `<option>`/`<optgroup>` markup.
 */
export default {
    name: "MonitorFieldSelect",

    props: {
        /**
         * The value bound via v-model.
         */
        modelValue: {
            type: [ String, Number ],
            default: "",
        },
        /**
         * The `id`/`for` used to associate the <label> with the <select>.
         */
        id: {
            type: String,
            required: true,
        },
        /**
         * The label text shown above the select. Callers are responsible
         * for translating it (e.g. via $t()) before passing it in.
         */
        label: {
            type: String,
            required: true,
        },
        /**
         * Whether the field is required for form submission.
         */
        required: {
            type: Boolean,
            default: false,
        },
        /**
         * Whether the field is disabled.
         */
        disabled: {
            type: Boolean,
            default: false,
        },
        /**
         * Value forwarded to the `data-testid` attribute, used by e2e tests.
         */
        dataTestid: {
            type: String,
            default: undefined,
        },
        /**
         * Whether the field should be rendered in its invalid (Bootstrap
         * `is-invalid`) state. When true, the `error` slot is rendered
         * inside the Bootstrap `invalid-feedback` block.
         */
        invalid: {
            type: Boolean,
            default: false,
        },
    },

    emits: [ "update:modelValue" ],

    computed: {
        /**
         * Two-way binding proxy that relays changes to the parent via
         * `update:modelValue`.
         */
        model: {
            get() {
                return this.modelValue;
            },
            set(value) {
                this.$emit("update:modelValue", value);
            },
        },
    },
};
</script>
