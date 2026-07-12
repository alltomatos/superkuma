<template>
    <div class="trend-panel">
        <Line v-if="chartData" :data="chartData" :options="chartOptions" />
        <div v-else class="trend-empty text-muted">{{ $t("notAvailableShort") }}</div>
    </div>
</template>

<script>
import { LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler, Chart } from "chart.js";
import "chartjs-adapter-dayjs-4";
import { Line } from "vue-chartjs";
import { extractMetricValue, isMetricMonitorType } from "../../metric-value.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

/**
 * A line chart of a single monitor's recent history (ADR-0017): ping duration
 * for regular monitors, or the extracted metric value for metric monitor
 * types (prometheus/influxdb/snmp/json-query) -- the same channel PingChart
 * uses on the monitor detail page.
 */
export default {
    components: { Line },
    props: {
        /** The monitor id whose history to chart */
        monitorId: {
            type: Number,
            required: true,
        },
        /** Monitor type, used to decide whether to plot ping or the extracted metric value */
        monitorType: {
            type: String,
            default: null,
        },
        /** Hours of history to fetch */
        periodHours: {
            type: Number,
            default: 6,
        },
    },
    data() {
        return {
            beats: null,
        };
    },
    computed: {
        isMetric() {
            return isMetricMonitorType(this.monitorType);
        },
        chartData() {
            if (!this.beats || this.beats.length === 0) {
                return null;
            }
            const points = this.beats
                .map((beat) => {
                    const y = this.isMetric ? extractMetricValue(beat.msg) : beat.ping;
                    return y === null || y === undefined ? null : { x: new Date(beat.time), y };
                })
                .filter((p) => p !== null);

            return {
                datasets: [
                    {
                        data: points,
                        borderColor: "#5cdd8b",
                        backgroundColor: "rgba(92, 221, 139, 0.15)",
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.25,
                    },
                ],
            };
        },
        chartOptions() {
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                scales: {
                    x: { type: "time", display: false },
                    y: { display: false, beginAtZero: true },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                },
            };
        },
    },
    mounted() {
        this.$root.getMonitorBeats(this.monitorId, this.periodHours, (res) => {
            if (res.ok) {
                this.beats = res.data;
            }
        });
    },
};
</script>

<style lang="scss" scoped>
.trend-panel {
    height: 100%;
    min-height: 60px;
    position: relative;
}

.trend-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-size: 0.85rem;
}
</style>
