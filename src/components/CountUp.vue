<template>
    <span v-if="isNum" ref="output">{{ outputFixed }}</span>
    <span v-if="isNum">{{ unitDisplay }}</span>
    <span v-else>{{ value }}</span>
</template>

<script lang="ts">
import { sleep } from "../util.ts";

export default {
    props: {
        /** Value to count */
        value: {
            type: [String, Number],
            default: 0,
        },
        time: {
            type: Number,
            default: 0.3,
        },
        /** Unit of the value */
        unit: {
            type: String,
            default: "ms",
        },
        /**
         * Metric-monitor mode. When true, the value is shown verbatim (already
         * rounded upstream): no "<1" shortcut (so 0 -> "0", 0.3 -> "0.3") and a
         * space before alphabetic units ("115 GB") but not before "%" ("80%").
         */
        metric: {
            type: Boolean,
            default: false,
        },
    },

    data() {
        return {
            output: "",
            frameDuration: 30,
        };
    },

    computed: {
        isNum() {
            return typeof this.value === "number";
        },
        outputFixed() {
            if (typeof this.output === "number") {
                if (this.metric) {
                    // Value is already rounded upstream; show it verbatim so a
                    // legitimate 0 or 0.3 isn't collapsed into "<1".
                    return this.output;
                }
                if (this.output < 1) {
                    return "<1";
                } else if (Number.isInteger(this.output)) {
                    return this.output;
                } else {
                    return this.output.toFixed(2);
                }
            } else {
                return this.output;
            }
        },
        /**
         * The unit with metric-mode spacing applied: no space before "%",
         * a leading space before alphabetic units (GB, MB, s...).
         * @returns {string} The unit as it should render after the value.
         */
        unitDisplay() {
            if (this.metric && this.unit && this.unit !== "%") {
                return " " + this.unit;
            }
            return this.unit;
        },
    },

    watch: {
        async value(from, to) {
            let diff = to - from;
            let frames = 12;
            let step = Math.floor(diff / frames);

            if (!(isNaN(step) || !this.isNum || (diff > 0 && step < 1) || (diff < 0 && step > 1) || diff === 0)) {
                for (let i = 1; i < frames; i++) {
                    this.output += step;
                    await sleep(15);
                }
            }

            this.output = this.value;
        },
    },

    mounted() {
        this.output = this.value;
    },

    methods: {},
};
</script>
