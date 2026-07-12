<template>
    <div v-if="dashboard" class="dashboard-builder">
        <div class="builder-toolbar">
            <div class="builder-title">
                <input v-model="dashboard.title" type="text" class="form-control title-input" />
                <span class="slug-badge">/panel/{{ dashboard.slug }}</span>
            </div>
            <div class="builder-actions">
                <label class="publish-toggle">
                    <input v-model="dashboard.published" type="checkbox" class="form-check-input" />
                    {{ dashboard.published ? $t("Published") : $t("Unpublished") }}
                </label>
                <a
                    v-if="dashboard.published"
                    :href="`/panel/${dashboard.slug}`"
                    target="_blank"
                    rel="noopener"
                    class="btn btn-normal btn-sm"
                >
                    <font-awesome-icon icon="external-link-square-alt" />
                    {{ $t("View") }}
                </a>
                <button type="button" class="btn btn-normal" @click="openAddPanelModal">
                    <font-awesome-icon icon="plus" />
                    {{ $t("Add Panel") }}
                </button>
                <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                    <div v-if="saving" class="spinner-border spinner-border-sm me-1"></div>
                    <font-awesome-icon v-else icon="save" />
                    {{ $t("Save") }}
                </button>
            </div>
        </div>

        <GridLayout
            v-model:layout="layout"
            :col-num="12"
            :row-height="30"
            :margin="[10, 10]"
            :is-draggable="true"
            :is-resizable="true"
            :vertical-compact="true"
            :use-css-transforms="true"
            @layout-updated="onLayoutUpdated"
        >
            <GridItem
                v-for="item in layout"
                :key="item.i"
                :x="item.x"
                :y="item.y"
                :w="item.w"
                :h="item.h"
                :i="item.i"
                drag-allow-from=".panel-drag-handle"
            >
                <div class="panel-card">
                    <div class="panel-head">
                        <span class="panel-drag-handle"><font-awesome-icon icon="grip-vertical" /></span>
                        <span class="panel-title">{{ panelTitle(item.i) }}</span>
                        <button type="button" class="btn-remove-panel" @click="removePanel(item.i)">
                            <font-awesome-icon icon="times" />
                        </button>
                    </div>
                    <div class="panel-body">
                        <component :is="panelComponent(item.i)" v-bind="panelProps(item.i)" />
                    </div>
                </div>
            </GridItem>
        </GridLayout>

        <div v-if="widgets.length === 0" class="text-center text-muted p-5">
            {{ $t("Select a dashboard to view its widgets") }}
        </div>

        <!-- Add panel -->
        <div ref="addPanelModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitAddPanel">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("Add Panel") }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label" for="newPanelKind">{{ $t("Widget Type") }}</label>
                                <select id="newPanelKind" v-model="newPanel.kind" class="form-select">
                                    <option value="status_tile">{{ $t("Status") }}</option>
                                    <option value="metric_gauge">{{ $t("Metric Gauge") }}</option>
                                    <option value="stat">{{ $t("Stat") }}</option>
                                    <option value="speedometer">{{ $t("Speedometer") }}</option>
                                    <option value="trend">{{ $t("Trend") }}</option>
                                    <option value="pie">{{ $t("Pie") }}</option>
                                    <option value="group_summary">{{ $t("Group Summary") }}</option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newPanelMonitor">{{ $t("Monitor") }}</label>
                                <select id="newPanelMonitor" v-model="newPanel.monitorId" class="form-select" required>
                                    <option :value="null" disabled>{{ $t("Select") }}</option>
                                    <option v-for="monitor in monitorOptions" :key="monitor.id" :value="monitor.id">
                                        {{ monitor.name }}
                                    </option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newPanelTitle">{{ $t("Title") }}</label>
                                <input
                                    id="newPanelTitle"
                                    v-model="newPanel.title"
                                    type="text"
                                    class="form-control"
                                    :placeholder="$t('Optional')"
                                />
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary" :disabled="!newPanel.monitorId">
                                {{ $t("Add") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { GridLayout, GridItem } from "grid-layout-plus";
import GroupSummaryWidget from "../components/GroupSummaryWidget.vue";
import StatusTilePanel from "../components/panels/StatusTilePanel.vue";
import StatPanel from "../components/panels/StatPanel.vue";
import SpeedometerPanel from "../components/panels/SpeedometerPanel.vue";
import TrendPanel from "../components/panels/TrendPanel.vue";
import PiePanel from "../components/panels/PiePanel.vue";
import { defineAsyncComponent } from "vue";
import { extractMetricValue, isMetricMonitorType } from "../metric-value.js";

const MetricGaugeWidget = defineAsyncComponent(() => import("../components/MetricGaugeWidget.vue"));

// Kinds that need a "group" monitor's children, not a single metric value.
const GROUP_KINDS = ["group_summary", "pie"];

/**
 * Grafana-style drag-and-drop dashboard builder (ADR-0017): edits a single
 * dashboard's title/slug/published state and its panel grid. Panels are
 * positioned via grid-layout-plus; saving replaces the dashboard's full panel
 * list server-side (same "save/replace" semantics as save_status_page).
 */
export default {
    components: {
        GridLayout,
        GridItem,
        GroupSummaryWidget,
        StatusTilePanel,
        StatPanel,
        SpeedometerPanel,
        TrendPanel,
        PiePanel,
        MetricGaugeWidget,
    },
    data() {
        return {
            dashboard: null,
            widgets: [],
            layout: [],
            saving: false,
            addPanelModal: null,
            newPanel: { kind: "status_tile", monitorId: null, title: "" },
            nextTempId: -1,
        };
    },
    computed: {
        monitorOptions() {
            if (!this.dashboard) {
                return [];
            }
            const teamId = this.dashboard.teamId;
            const wantGroup = GROUP_KINDS.includes(this.newPanel.kind);
            return Object.values(this.$root.monitorList || {}).filter((m) => {
                if (m.teamId !== teamId) {
                    return false;
                }
                return wantGroup ? m.type === "group" : true;
            });
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        /**
         * (Re)load the dashboard and its panels from the server, and derive
         * the grid-layout-plus layout array from the panel geometry.
         * @returns {void}
         */
        load() {
            const id = Number(this.$route.params.id);
            this.$root.getDashboard(id, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.dashboard = res.dashboard;
                this.widgets = res.widgets;
                this.rebuildLayout();

                // The "Add Panel" modal's root element only exists once
                // dashboard is set (the whole template is behind
                // v-if="dashboard"), so it can only be initialized here,
                // after the DOM has actually re-rendered -- not in
                // mounted(), where $refs.addPanelModal would still be
                // undefined and crash the Modal constructor.
                if (!this.addPanelModal) {
                    this.$nextTick(() => {
                        this.addPanelModal = new Modal(this.$refs.addPanelModal);
                    });
                }
            });
        },

        /**
         * Rebuild the grid-layout-plus layout array from `this.widgets`'
         * geometry. Widgets without a real id (freshly added, not yet saved)
         * get a negative temp id so grid-layout-plus still has a stable key.
         * @returns {void}
         */
        rebuildLayout() {
            this.layout = this.widgets.map((w) => {
                if (w.id === undefined || w.id === null) {
                    w.id = this.nextTempId--;
                }
                return { i: w.id, x: w.posX, y: w.posY, w: w.width, h: w.height };
            });
        },

        /**
         * Find the panel matching a grid layout item's id.
         * @param {number} id The panel id (or temp id).
         * @returns {object|undefined} The matching widget.
         */
        widgetById(id) {
            return this.widgets.find((w) => w.id === id);
        },

        /**
         * Sync geometry changes (drag/resize) from the grid back into the
         * widget list.
         * @param {Array<object>} newLayout The updated grid-layout-plus layout.
         * @returns {void}
         */
        onLayoutUpdated(newLayout) {
            for (const item of newLayout) {
                const widget = this.widgetById(item.i);
                if (widget) {
                    widget.posX = item.x;
                    widget.posY = item.y;
                    widget.width = item.w;
                    widget.height = item.h;
                }
            }
        },

        /**
         * Display title for a panel: its own title, else the monitor's name.
         * @param {number} id The panel id.
         * @returns {string} The title to show in the panel header.
         */
        panelTitle(id) {
            const w = this.widgetById(id);
            return (w && (w.title || w.monitorName)) || "";
        },

        /**
         * Which component renders a panel's body, by kind.
         * @param {number} id The panel id.
         * @returns {string} A component name.
         */
        panelComponent(id) {
            const w = this.widgetById(id);
            const kinds = {
                metric_gauge: "MetricGaugeWidget",
                group_summary: "GroupSummaryWidget",
                stat: "StatPanel",
                speedometer: "SpeedometerPanel",
                trend: "TrendPanel",
                pie: "PiePanel",
            };
            return (w && kinds[w.kind]) || "StatusTilePanel";
        },

        /**
         * Props to bind onto a panel's body component, derived from the
         * widget's monitor + kind + config. Mirrors Details.vue/DashboardDetail's
         * metricGaugeProps derivation.
         * @param {number} id The panel id.
         * @returns {object} Props for the panel body component.
         */
        panelProps(id) {
            const w = this.widgetById(id);
            if (!w) {
                return {};
            }
            if (GROUP_KINDS.includes(w.kind)) {
                return { monitorId: w.monitorId };
            }
            if (w.kind === "status_tile") {
                return { monitorId: w.monitorId, monitorName: w.monitorName };
            }
            if (w.kind === "trend") {
                return {
                    monitorId: w.monitorId,
                    monitorType: w.monitorType,
                    periodHours: (w.config && w.config.periodHours) || 6,
                };
            }

            const monitor = this.$root.monitorList[w.monitorId];
            const lastHeartbeat = this.$root.lastHeartbeatList[w.monitorId];
            const isMetric = monitor && isMetricMonitorType(monitor.type);
            const value = lastHeartbeat && isMetric ? extractMetricValue(lastHeartbeat.msg) : null;

            if (w.kind === "speedometer") {
                return {
                    value: value ?? 0,
                    status: lastHeartbeat ? lastHeartbeat.status : 2,
                    max: (w.config && w.config.max) || (monitor && Number(monitor.expectedValue)) || 100,
                    unit: (w.config && w.config.unit) || (monitor && monitor.metricUnit) || "",
                };
            }
            if (w.kind === "stat") {
                return {
                    value: value ?? 0,
                    status: lastHeartbeat ? lastHeartbeat.status : 2,
                    unit: (w.config && w.config.unit) || (monitor && monitor.metricUnit) || "",
                    label: (w.config && w.config.label) || "",
                };
            }
            // metric_gauge
            const unit = (monitor && monitor.metricUnit) || "";
            return {
                value: value ?? 0,
                status: lastHeartbeat ? lastHeartbeat.status : 2,
                thresholdOperator: monitor && monitor.jsonPathOperator,
                thresholdValue: monitor && monitor.expectedValue,
                unit,
                max: unit === "%" ? 100 : null,
            };
        },

        /**
         * Open the "Add Panel" dialog.
         * @returns {void}
         */
        openAddPanelModal() {
            this.newPanel = { kind: "status_tile", monitorId: null, title: "" };
            this.addPanelModal.show();
        },

        /**
         * Append the panel from the "Add Panel" form to the grid, auto-placed
         * below the lowest existing panel.
         * @returns {void}
         */
        submitAddPanel() {
            const monitor = this.$root.monitorList[this.newPanel.monitorId];
            const maxY = this.widgets.reduce((max, w) => Math.max(max, w.posY + w.height), 0);
            this.widgets.push({
                id: this.nextTempId--,
                monitorId: this.newPanel.monitorId,
                monitorName: monitor ? monitor.name : null,
                monitorType: monitor ? monitor.type : null,
                kind: this.newPanel.kind,
                title: this.newPanel.title || null,
                posX: 0,
                posY: maxY,
                width: 4,
                height: 4,
                config: null,
            });
            this.rebuildLayout();
            this.addPanelModal.hide();
        },

        /**
         * Remove a panel from the grid (only takes effect once Save is pressed).
         * @param {number} id The panel id.
         * @returns {void}
         */
        removePanel(id) {
            this.widgets = this.widgets.filter((w) => w.id !== id);
            this.rebuildLayout();
        },

        /**
         * Persist the dashboard's title/slug/published state and full panel
         * list (geometry + kind + config) to the server.
         * @returns {void}
         */
        save() {
            this.saving = true;
            this.$root.saveDashboard(
                {
                    id: this.dashboard.id,
                    title: this.dashboard.title,
                    slug: this.dashboard.slug,
                    published: this.dashboard.published,
                    widgets: this.widgets.map((w) => ({
                        monitorId: w.monitorId,
                        kind: w.kind,
                        title: w.title || undefined,
                        posX: w.posX,
                        posY: w.posY,
                        width: w.width,
                        height: w.height,
                        config: w.config || undefined,
                    })),
                },
                (res) => {
                    this.saving = false;
                    this.$root.toastRes(res);
                    if (res.ok) {
                        this.load();
                    }
                }
            );
        },
    },
};
</script>

<style lang="scss" scoped>
.builder-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
}

.builder-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 220px;
}

.title-input {
    max-width: 320px;
    font-weight: 600;
}

.slug-badge {
    font-size: 0.75rem;
    opacity: 0.6;
    font-family: monospace;
}

.builder-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.publish-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    margin-bottom: 0;
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
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 0.8rem;
    font-weight: 600;
    border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}

.panel-drag-handle {
    cursor: grab;
    opacity: 0.5;
}

.panel-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.btn-remove-panel {
    border: none;
    background: transparent;
    opacity: 0.5;
    padding: 0 4px;

    &:hover {
        opacity: 1;
    }
}

.panel-body {
    flex: 1;
    padding: 6px;
    overflow: hidden;
}
</style>
