<template>
    <div class="pie-panel">
        <Doughnut :data="chartData" :options="chartOptions" />
        <div class="pie-legend">
            <div>
                <span class="sw up"></span>
                {{ $t("Up") }} ({{ counts.up }})
            </div>
            <div>
                <span class="sw down"></span>
                {{ $t("Down") }} ({{ counts.down }})
            </div>
            <div v-if="counts.pending">
                <span class="sw pending"></span>
                {{ $t("Pending") }} ({{ counts.pending }})
            </div>
            <div v-if="counts.paused">
                <span class="sw paused"></span>
                {{ $t("Paused") }} ({{ counts.paused }})
            </div>
        </div>
    </div>
</template>

<script>
import { ArcElement, Chart, DoughnutController } from "chart.js";
import { Doughnut } from "vue-chartjs";

Chart.register(DoughnutController, ArcElement);

const COLORS = { up: "#5cdd8b", down: "#dc3545", pending: "#f8a306", paused: "#808080" };

/**
 * A doughnut chart of a "group" monitor's children's up/down/pending/paused
 * distribution (ADR-0017 "pie" panel kind) -- same underlying data as
 * GroupSummaryWidget, charted instead of tallied as text.
 */
export default {
    components: { Doughnut },
    props: {
        /** The group monitor's id (a monitor with type "group") */
        monitorId: {
            type: Number,
            required: true,
        },
    },
    computed: {
        group() {
            return this.$root.monitorList[this.monitorId];
        },
        childIds() {
            return (this.group && this.group.childrenIDs) || [];
        },
        counts() {
            const tally = { up: 0, down: 0, pending: 0, paused: 0 };
            for (const childId of this.childIds) {
                const child = this.$root.monitorList[childId];
                if (child && !child.active) {
                    tally.paused++;
                    continue;
                }
                const beat = this.$root.lastHeartbeatList[childId];
                if (!beat) {
                    tally.pending++;
                    continue;
                }
                switch (beat.status) {
                    case 1:
                        tally.up++;
                        break;
                    case 0:
                        tally.down++;
                        break;
                    default:
                        tally.pending++;
                }
            }
            return tally;
        },
        chartData() {
            return {
                labels: [this.$t("Up"), this.$t("Down"), this.$t("Pending"), this.$t("Paused")],
                datasets: [
                    {
                        data: [this.counts.up, this.counts.down, this.counts.pending, this.counts.paused],
                        backgroundColor: [COLORS.up, COLORS.down, COLORS.pending, COLORS.paused],
                        borderWidth: 0,
                    },
                ],
            };
        },
        chartOptions() {
            return {
                responsive: true,
                maintainAspectRatio: true,
                animation: { duration: 300 },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: true },
                },
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.pie-panel {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 100%;
}

.pie-panel > :deep(canvas) {
    max-width: 90px;
    max-height: 90px;
}

.pie-legend {
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.sw {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    margin-right: 5px;
}

.sw.up {
    background-color: #5cdd8b;
}

.sw.down {
    background-color: #dc3545;
}

.sw.pending {
    background-color: #f8a306;
}

.sw.paused {
    background-color: #808080;
}
</style>
