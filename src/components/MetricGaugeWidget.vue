<template>
    <div class="metric-gauge" data-testid="metric-gauge">
        <div class="gauge-canvas-wrapper">
            <Doughnut :data="chartData" :options="chartOptions" />
            <div class="gauge-value" :style="{ color: statusColor }">
                {{ displayValue }}<span v-if="unit" class="gauge-unit">{{ unitSuffix }}</span>
            </div>
        </div>
        <div class="gauge-threshold">{{ thresholdLabel }}</div>
    </div>
</template>

<script>
import { ArcElement, Chart, DoughnutController } from "chart.js";
import { Doughnut } from "vue-chartjs";

Chart.register(DoughnutController, ArcElement);

const TRACK_COLOR = "rgba(128, 128, 128, 0.15)";
const STATUS_COLORS = {
    0: "#dc3545", // down
    1: "#5cdd8b", // up
    2: "#f8a306", // pending
    3: "#1747f5", // maintenance
};

export default {
    components: { Doughnut },
    props: {
        /** Current metric value (already extracted server-side, see Heartbeat.extractPublicMetricValue) */
        value: {
            type: Number,
            required: true,
        },
        /** Monitor's current heartbeat status (0 down / 1 up / 2 pending / 3 maintenance) */
        status: {
            type: Number,
            default: 1,
        },
        /** Condition operator, e.g. '>' '<' '>=' '<=' '==' -- used to orient/label the threshold */
        thresholdOperator: {
            type: String,
            default: null,
        },
        /** Condition threshold value (string, as stored on the monitor) */
        thresholdValue: {
            type: [String, Number],
            default: null,
        },
        /** Optional fixed gauge ceiling (e.g. 100 for "%"). When omitted, the ceiling is the alert threshold, falling back to 1.25x the value. */
        max: {
            type: Number,
            default: null,
        },
        /** Optional unit suffix shown next to the value, e.g. '%' or 's' */
        unit: {
            type: String,
            default: "",
        },
    },
    computed: {
        gaugeMax() {
            if (this.max !== null) {
                return this.max;
            }
            // Anchor the ceiling to the alert threshold so the arc reads as
            // "value relative to your limit": a "<" usage monitor fills toward
            // the limit (disk 120/400 = 30%), a ">" headroom monitor stays full
            // while safe and drains as it nears the floor. This avoids the old
            // auto-scale that pinned every above-threshold value at a flat 80%.
            const threshold = Number(this.thresholdValue);
            if (Number.isFinite(threshold) && threshold > 0) {
                return threshold;
            }
            // No usable threshold: fall back to headroom above the value.
            return Math.max(this.value * 1.25, 1);
        },
        clampedValue() {
            return Math.max(0, Math.min(this.value, this.gaugeMax));
        },
        statusColor() {
            return STATUS_COLORS[this.status] ?? STATUS_COLORS[2];
        },
        displayValue() {
            // Trim to a sane number of decimals for display without implying false precision.
            // Plain number (not toLocaleString) so it matches the CountUp stat boxes,
            // which use a dot decimal separator regardless of locale.
            return Math.round(this.value * 100) / 100;
        },
        /**
         * The unit spaced for display: no space before "%", a leading space
         * before alphabetic units. Matches CountUp's metric mode.
         * @returns {string} The spaced unit suffix, or "".
         */
        unitSuffix() {
            if (this.unit && this.unit !== "%") {
                return ` ${this.unit}`;
            }
            return this.unit;
        },
        thresholdLabel() {
            if (!this.thresholdOperator || this.thresholdValue === null || this.thresholdValue === undefined) {
                return "";
            }
            return `${this.thresholdOperator} ${this.thresholdValue}${this.unitSuffix}`;
        },
        chartData() {
            return {
                datasets: [
                    {
                        data: [this.clampedValue, this.gaugeMax - this.clampedValue],
                        backgroundColor: [this.statusColor, TRACK_COLOR],
                        borderWidth: 0,
                    },
                ],
            };
        },
        chartOptions() {
            return {
                circumference: 180,
                rotation: -90,
                cutout: "72%",
                responsive: true,
                maintainAspectRatio: true,
                animation: { duration: 300 },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                },
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.metric-gauge {
    text-align: center;
    padding: 4px 0;
}

.gauge-canvas-wrapper {
    position: relative;
    max-width: 140px;
    margin: 0 auto;
}

.gauge-value {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 8%;
    text-align: center;
    font-weight: bold;
    font-size: 1.1rem;
}

.gauge-unit {
    font-size: 0.7em;
    font-weight: normal;
}

.gauge-threshold {
    font-size: 0.7rem;
    opacity: 0.65;
    margin-top: -6px;
}
</style>
