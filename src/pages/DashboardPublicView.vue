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
                :vertical-compact="false"
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
                    <div
                        class="panel-card"
                        :class="{
                            'card-section-header': isSectionHeader(item.i),
                            'card-alarm-pulse': hasAlarm(item.i),
                        }"
                    >
                        <div v-if="!isSectionHeader(item.i)" class="panel-head">{{ panelTitle(item.i) }}</div>
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
import HeartbeatBarPanel from "../components/panels/HeartbeatBarPanel.vue";
import SectionHeaderPanel from "../components/panels/SectionHeaderPanel.vue";
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
    components: {
        GridLayout,
        GridItem,
        StatusTilePanel,
        HeartbeatBarPanel,
        SectionHeaderPanel,
        StatPanel,
        SpeedometerPanel,
        MetricGaugeWidget,
    },
    data() {
        return {
            dashboard: null,
            panels: [],
            heartbeatList: {},
            notFound: false,
            refreshTimer: null,
        };
    },
    computed: {
        visiblePanels() {
            const supported = ["status_tile", "heartbeat_bar", "section_header", "metric_gauge", "stat", "speedometer"];
            return this.panels.filter((p) => supported.includes(p.kind));
        },
        layout() {
            return this.visiblePanels.map((p) => ({ i: p.id, x: p.posX, y: p.posY, w: p.width, h: p.height }));
        },
    },
    mounted() {
        this.load();
    },
    beforeUnmount() {
        this.stopAutoRefresh();
    },
    methods: {
        /**
         * Fetch the published dashboard's data from the public REST endpoint,
         * then (re)schedule the next fetch per the dashboard's own
         * refreshInterval -- this is a static one-shot page otherwise, which
         * defeats the point of a wallboard/TV display nobody is reloading by
         * hand.
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
                    this.$root.dashboardTheme = this.dashboard.theme || "auto";
                    this.scheduleAutoRefresh();
                })
                .catch(() => {
                    this.notFound = true;
                });
        },

        /**
         * (Re)starts the auto-refresh timer at the dashboard's configured
         * refreshInterval (seconds), clamped to a sane minimum so a
         * misconfigured 0/negative value can't hammer the server.
         * @returns {void}
         */
        scheduleAutoRefresh() {
            this.stopAutoRefresh();
            const intervalSecs = Math.max(5, this.dashboard.refreshInterval || 60);
            this.refreshTimer = setInterval(() => {
                this.load();
            }, intervalSecs * 1000);
        },

        /**
         * Stops the auto-refresh timer, if running.
         * @returns {void}
         */
        stopAutoRefresh() {
            if (this.refreshTimer) {
                clearInterval(this.refreshTimer);
                this.refreshTimer = null;
            }
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
            const kinds = {
                status_tile: "StatusTilePanel",
                heartbeat_bar: "HeartbeatBarPanel",
                section_header: "SectionHeaderPanel",
                metric_gauge: "MetricGaugeWidget",
                stat: "StatPanel",
                speedometer: "SpeedometerPanel",
            };
            return (p && kinds[p.kind]) || "StatusTilePanel";
        },

        /**
         * Checks if the panel is a section_header.
         * @param {number} id The panel id.
         * @returns {boolean} True if section header.
         */
        isSectionHeader(id) {
            const p = this.panelById(id);
            return p && p.kind === "section_header";
        },

        /**
         * Checks if the panel has an active alarm/down status.
         * @param {number} id The panel id.
         * @returns {boolean} True if down.
         */
        hasAlarm(id) {
            const p = this.panelById(id);
            if (!p || p.kind === "section_header") {
                return false;
            }
            const beat = this.latestBeat(p.monitorId);
            return beat && Number(beat.status) === 0;
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
            if (p.kind === "heartbeat_bar") {
                return {
                    monitorId: p.monitorId,
                    monitorName: p.monitorName,
                    publicStatus: this.publicStatus(p),
                    heartbeatList: this.heartbeatList[p.monitorId] || [],
                };
            }
            if (p.kind === "section_header") {
                return {
                    monitorId: p.monitorId,
                    monitorName: p.monitorName,
                    title: p.title,
                };
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
@import "../assets/vars.scss";

.dashboard-public-view {
    width: 100%;
    max-width: 98%;
    margin: 0 auto;
    padding: 16px 20px;
    box-sizing: border-box;
}

.public-header {
    margin-bottom: 16px;

    h1 {
        font-size: 1.6rem;
        font-weight: 700;
        letter-spacing: -0.01em;
    }
}

.panel-card {
    height: 100%;
    display: flex;
    flex-direction: column;
    background-color: #fff;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    transition:
        box-shadow 0.2s ease,
        border-color 0.2s ease;

    .dark & {
        background-color: $dark-bg2;
        border-color: $dark-border-color;
        color: $dark-font-color;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    }

    &.card-section-header {
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
    }

    &.card-alarm-pulse {
        border-color: #dc3545 !important;
        box-shadow: 0 0 12px rgba(220, 53, 69, 0.6) !important;
        animation: pulse-danger 1.5s infinite alternate;
    }
}

@keyframes pulse-danger {
    from {
        box-shadow: 0 0 4px rgba(220, 53, 69, 0.4);
    }

    to {
        box-shadow: 0 0 16px rgba(220, 53, 69, 0.85);
    }
}

.panel-head {
    padding: 6px 12px;
    font-size: 0.85rem;
    font-weight: 700;
    text-align: center;
    background: rgba(15, 118, 110, 0.22);
    color: #14b8a6;
    border-bottom: 1px solid rgba(20, 184, 166, 0.25);
    letter-spacing: 0.02em;

    .dark & {
        background: rgba(15, 118, 110, 0.28);
        color: #2dd4bf;
        border-bottom-color: rgba(45, 212, 191, 0.2);
    }
}

.panel-body {
    flex: 1;
    padding: 6px 10px;
    overflow: hidden;
    box-sizing: border-box;
}

.public-footer {
    text-align: center;
    font-size: 0.8rem;
    margin-top: 24px;
}
</style>
