<template>
    <div class="my-3">
        <label :for="id" class="form-label">
            {{ label }}
            <slot name="label-suffix" />
        </label>
        <input
            :id="id"
            v-model="model"
            :type="type"
            class="form-control"
            :class="{ 'is-invalid': invalid }"
            :required="required"
            :min="min"
            :max="max"
            :step="step"
            :disabled="disabled"
            :placeholder="placeholder"
            :data-testid="dataTestid"
            @focus="$emit('focus', $event)"
            @blur="$emit('blur', $event)"
        />
        <div v-if="invalid" class="invalid-feedback">
            <slot name="error" />
        </div>
        <div v-if="$slots.default" class="form-text">
            <slot />
        </div>
        <div v-if="$slots.warning" class="form-text">
            <slot name="warning" />
        </div>
    </div>
</template>

<script>
/**
 * Generic labeled text/number input field for monitor edit forms.
 * Wraps the Bootstrap `form-label` + `form-control` + `form-text` markup
 * used throughout EditMonitor.vue so field blocks do not have to repeat it
 * inline for every monitor type.
 */
export default {
    name: "MonitorFieldInput",

    props: {
        /**
         * The value bound via v-model.
         */
        modelValue: {
            type: [ String, Number ],
            default: "",
        },
        /**
         * The `id`/`for` used to associate the <label> with the <input>.
         */
        id: {
            type: String,
            required: true,
        },
        /**
         * The label text shown above the input. Callers are responsible for
         * translating it (e.g. via $t()) before passing it in.
         */
        label: {
            type: String,
            required: true,
        },
        /**
         * The HTML input type attribute.
         * @example "number"
         */
        type: {
            type: String,
            default: "text",
        },
        /**
         * Whether the field is required for form submission.
         */
        required: {
            type: Boolean,
            default: false,
        },
        /**
         * Minimum value, forwarded to the native input (numeric fields only).
         */
        min: {
            type: [ String, Number ],
            default: undefined,
        },
        /**
         * Maximum value, forwarded to the native input (numeric fields only).
         */
        max: {
            type: [ String, Number ],
            default: undefined,
        },
        /**
         * Step increment, forwarded to the native input (numeric fields only).
         */
        step: {
            type: [ String, Number ],
            default: undefined,
        },
        /**
         * Whether the field is disabled.
         */
        disabled: {
            type: Boolean,
            default: false,
        },
        /**
         * Placeholder text shown when the field is empty.
         */
        placeholder: {
            type: String,
            default: "",
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

    emits: [ "update:modelValue", "focus", "blur" ],

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
