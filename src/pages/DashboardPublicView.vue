<template>
    <div class="dashboard-public-view">
        <div v-if="notFound" class="text-center text-muted p-5">{{ $t("Dashboard Not Found") }}</div>
        <template v-else-if="dashboard">
            <div class="public-header">
                <h1>{{ dashboard.title }}</h1>
                <p v-if="dashboard.description" class="text-muted">{{ dashboard.description }}</p>
            </div>

            <GridLayout
                :layout="layout"
                :col-num="12"
                :row-height="30"
                :margin="[10, 10]"
                :is-draggable="false"
                :is-resizable="false"
            >
                <GridItem
                    v-for="item in layout"
                    :key="item.i"
                    :x="item.x"
                    :y="item.y"
                    :w="item.w"
                    :h="item.h"
                    :i="item.i"
                >
                    <div class="panel-card">
                        <div class="panel-head">{{ panelTitle(item.i) }}</div>
                        <div class="panel-body">
                            <component :is="panelComponent(item.i)" v-bind="panelProps(item.i)" />
                        </div>
                    </div>
                </GridItem>
            </GridLayout>

            <div class="public-footer text-muted">{{ $t("Provided by") }} SuperKuma</div>
        </template>
    </div>
</template>

<script>
import axios from "axios";
import { GridLayout, GridItem } from "grid-layout-plus";
import StatusTilePanel from "../components/panels/StatusTilePanel.vue";
import StatPanel from "../components/panels/StatPanel.vue";
import SpeedometerPanel from "../components/panels/SpeedometerPanel.vue";
import { defineAsyncComponent } from "vue";

const MetricGaugeWidget = defineAsyncComponent(() => import("../components/MetricGaugeWidget.vue"));

/**
 * Public, read-only render of a published dashboard (ADR-0017 D3), at
 * /panel/:slug. Fetches from the unauthenticated /api/panel/:slug REST
 * endpoint (no socket.io, mirrors StatusPage.vue's own public data-fetch
 * pattern) -- trend/pie/group_summary panels are intentionally omitted here
 * since they need live authenticated monitor state ($root.monitorList) that
 * a public, unauthenticated visitor never loads; the panel-picker in the
 * builder does not prevent adding them to a published dashboard, so any such
 * panel is simply skipped in the public render (see visiblePanels).
 */
export default {
    components: { GridLayout, GridItem, StatusTilePanel, StatPanel, SpeedometerPanel, MetricGaugeWidget },
    data() {
        return {
            dashboard: null,
            panels: [],
            heartbeatList: {},
            notFound: false,
        };
    },
    computed: {
        visiblePanels() {
            const supported = ["status_tile", "metric_gauge", "stat", "speedometer"];
            return this.panels.filter((p) => supported.includes(p.kind));
        },
        layout() {
            return this.visiblePanels.map((p) => ({ i: p.id, x: p.posX, y: p.posY, w: p.width, h: p.height }));
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        /**
         * Fetch the published dashboard's data from the public REST endpoint.
         * @returns {void}
         */
        load() {
            const slug = this.$route.params.slug;
            axios
                .get(`/api/panel/${slug}`)
                .then((res) => {
                    this.dashboard = res.data.dashboard;
                    this.panels = res.data.panels;
                    this.heartbeatList = res.data.heartbeatList;
                })
                .catch(() => {
                    this.notFound = true;
                });
        },

        /**
         * Find a visible panel by id.
         * @param {number} id The panel id.
         * @returns {object|undefined} The matching panel.
         */
        panelById(id) {
            return this.visiblePanels.find((p) => p.id === id);
        },

        /**
         * Display title for a panel.
         * @param {number} id The panel id.
         * @returns {string} The title.
         */
        panelTitle(id) {
            const p = this.panelById(id);
            return (p && (p.title || p.monitorName)) || "";
        },

        /**
         * Which component renders a panel's body, by kind.
         * @param {number} id The panel id.
         * @returns {string} A component name.
         */
        panelComponent(id) {
            const p = this.panelById(id);
            const kinds = { metric_gauge: "MetricGaugeWidget", stat: "StatPanel", speedometer: "SpeedometerPanel" };
            return (p && kinds[p.kind]) || "StatusTilePanel";
        },

        /**
         * The latest public heartbeat for a monitor (last element -- the list
         * is chronologically ascending), or null if there is none yet.
         * @param {number} monitorId The monitor id.
         * @returns {object|null} The latest public heartbeat.
         */
        latestBeat(monitorId) {
            const list = this.heartbeatList[monitorId];
            return list && list.length > 0 ? list[list.length - 1] : null;
        },

        /**
         * Props to bind onto a panel's body component, derived from its
         * latest public heartbeat.
         * @param {number} id The panel id.
         * @returns {object} Props for the panel body component.
         */
        panelProps(id) {
            const p = this.panelById(id);
            if (!p) {
                return {};
            }
            if (p.kind === "status_tile") {
                return { monitorId: p.monitorId, monitorName: p.monitorName, publicStatus: this.publicStatus(p) };
            }
            const beat = this.latestBeat(p.monitorId);
            const value = beat && beat.metricValue !== undefined ? beat.metricValue : 0;
            const status = beat ? beat.status : 2;
            const config = p.config || {};

            if (p.kind === "speedometer") {
                return { value, status, max: config.max || 100, unit: config.unit || "" };
            }
            if (p.kind === "stat") {
                return { value, status, unit: config.unit || "", label: config.label || "" };
            }
            // metric_gauge
            return { value, status, unit: config.unit || "", max: config.max ?? null };
        },

        /**
         * The status class for a status_tile panel's colored dot, computed
         * from the public heartbeat instead of $root.lastHeartbeatList (which
         * an unauthenticated visitor never has).
         * @param {object} panel The panel.
         * @returns {number} A heartbeat status (0/1/2/3).
         */
        publicStatus(panel) {
            const beat = this.latestBeat(panel.monitorId);
            return beat ? beat.status : 2;
        },
    },
};
</script>

<style lang="scss" scoped>
.dashboard-public-view {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 16px;
}

.public-header {
    margin-bottom: 20px;
}

.panel-card {
    height: 100%;
    display: flex;
    flex-direction: column;
    background-color: var(--bs-body-bg, #fff);
    border: 1px solid var(--bs-border-color, #dee2e6);
    border-radius: 8px;
    overflow: hidden;
}

.panel-head {
    padding: 4px 8px;
    font-size: 0.8rem;
    font-weight: 600;
    border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}

.panel-body {
    flex: 1;
    padding: 6px;
    overflow: hidden;
}

.public-footer {
    text-align: center;
    font-size: 0.8rem;
    margin-top: 24px;
}
</style>
