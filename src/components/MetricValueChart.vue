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
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                },
                scales: {
                    x: {
                        type: "time",
                        ticks: { maxRotation: 0 },
                    },
                    y: {
                        beginAtZero: true,
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
