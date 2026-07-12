<template>
    <div class="stat-panel">
        <div class="stat-value" :style="{ color: statusColor }">
            {{ displayValue }}
            <span v-if="unit" class="stat-unit">{{ unitSuffix }}</span>
        </div>
        <div v-if="label" class="stat-label">{{ label }}</div>
    </div>
</template>

<script>
const STATUS_COLORS = {
    0: "#dc3545", // down
    1: "#5cdd8b", // up
    2: "#f8a306", // pending
    3: "#1747f5", // maintenance
};

/**
 * A single large number + unit (ADR-0017 "stat" panel kind) -- the simplest
 * possible view of a metric monitor's current value, no chart.
 */
export default {
    props: {
        /** Current metric value (already extracted server-side) */
        value: {
            type: Number,
            required: true,
        },
        /** Monitor's current heartbeat status (0 down / 1 up / 2 pending / 3 maintenance), colors the number */
        status: {
            type: Number,
            default: 1,
        },
        /** Optional unit suffix, e.g. '%' or 'Mb/s' */
        unit: {
            type: String,
            default: "",
        },
        /** Optional small caption under the number, e.g. the monitor name */
        label: {
            type: String,
            default: "",
        },
    },
    computed: {
        statusColor() {
            return STATUS_COLORS[this.status] ?? STATUS_COLORS[2];
        },
        displayValue() {
            return Math.round(this.value * 100) / 100;
        },
        unitSuffix() {
            if (this.unit && this.unit !== "%") {
                return ` ${this.unit}`;
            }
            return this.unit;
        },
    },
};
</script>

<style lang="scss" scoped>
.stat-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
}

.stat-value {
    font-size: 2rem;
    font-weight: 800;
    line-height: 1;
}

.stat-unit {
    font-size: 1rem;
    font-weight: 500;
    opacity: 0.7;
}

.stat-label {
    font-size: 0.75rem;
    opacity: 0.65;
    margin-top: 4px;
}
</style>
