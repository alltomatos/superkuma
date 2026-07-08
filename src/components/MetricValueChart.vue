<template>
    <div>
        <div class="chart-wrapper">
            <Line :data="chartData" :options="chartOptions" />
        </div>
        <div class="form-text text-center mt-1">
            {{ $t("recentHeartbeatsOnly") }}
        </div>
    </div>
</template>

<script lang="js">
import { Chart, Filler, LinearScale, LineController, LineElement, PointElement, TimeScale, Tooltip } from "chart.js";
import "chartjs-adapter-dayjs-4";
import { Line } from "vue-chartjs";
import { extractMetricValue } from "../metric-value.js";

Chart.register(LineController, LineElement, PointElement, TimeScale, LinearScale, Tooltip, Filler);

export default {
    components: { Line },
    props: {
        /** ID of monitor */
        monitorId: {
            type: Number,
            required: true,
        },
        /** Optional unit suffix for the tooltip/axis, e.g. '%' or 'MB' */
        unit: {
            type: String,
            default: "",
        },
    },
    computed: {
        heartbeatList() {
            return this.$root.heartbeatList[this.monitorId] ?? [];
        },
        points() {
            return this.heartbeatList
                .map((beat) => {
                    const value = extractMetricValue(beat.msg);
                    if (value === null) {
                        return null;
                    }
                    return { x: beat.time, y: value, status: beat.status };
                })
                .filter(Boolean);
        },
        chartData() {
            return {
                datasets: [
                    {
                        label: this.$t("Value") + (this.unit ? ` (${this.unit})` : ""),
                        data: this.points,
                        borderColor: "#5cdd8b",
                        backgroundColor: "rgba(92, 221, 139, 0.3)",
                        fill: true,
                        tension: 0.2,
                        pointRadius: 0,
                        borderWidth: 2,
                    },
                ],
            };
        },
        chartOptions() {
            // Captured in a local so the tick/tooltip callbacks (called with
            // chart.js's own `this`) can reach the unit. No space before "%",
            // a space before alphabetic units ("18%" vs "115 GB").
            const isPercent = this.unit === "%";
            const suffix = this.unit ? (isPercent ? "%" : ` ${this.unit}`) : "";
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            // Round like the stat boxes so the tooltip doesn't leak raw float noise.
                            label: (ctx) => `${Math.round(ctx.parsed.y * 100) / 100}${suffix}`,
                        },
                    },
                },
                scales: {
                    x: {
                        type: "time",
                        ticks: { maxRotation: 0 },
                    },
                    y: {
                        // Percentages anchor at 0 with a soft 100 ceiling (spikes past
                        // 100 still show); absolute units auto-fit around the data band
                        // instead of being flattened against a 0 floor.
                        beginAtZero: isPercent,
                        suggestedMax: isPercent ? 100 : undefined,
                        ticks: {
                            // Label the axis with the unit so "18" reads as "18%".
                            callback: (value) => `${value}${suffix}`,
                        },
                    },
                },
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.chart-wrapper {
    position: relative;
    height: 220px;
}
</style>
