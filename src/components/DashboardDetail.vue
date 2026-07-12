<template>
    <div v-if="dashboard">
        <h4>{{ dashboard.title }}</h4>

        <form class="add-widget-form row g-2 align-items-end mb-4" @submit.prevent="submitAddWidget">
            <div class="col-md-4">
                <label class="form-label" for="newWidgetMonitor">{{ $t("Monitor") }}</label>
                <select id="newWidgetMonitor" v-model="newWidgetMonitorId" class="form-select" required>
                    <option :value="null" disabled>{{ $t("Select") }}</option>
                    <option v-for="monitor in teamMonitorOptions" :key="monitor.id" :value="monitor.id">
                        {{ monitor.name }}
                    </option>
                </select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="newWidgetKind">{{ $t("Widget Type") }}</label>
                <select id="newWidgetKind" v-model="newWidgetKind" class="form-select">
                    <option value="status_tile">{{ $t("Status") }}</option>
                    <option value="metric_gauge">{{ $t("Metric Gauge") }}</option>
                    <option value="group_summary">{{ $t("Group Summary") }}</option>
                </select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="newWidgetSection">{{ $t("Section") }}</label>
                <input
                    id="newWidgetSection"
                    v-model="newWidgetSection"
                    type="text"
                    class="form-control"
                    :placeholder="$t('Optional')"
                />
            </div>
            <div class="col-md-2">
                <button class="btn btn-primary w-100" type="submit" :disabled="!newWidgetMonitorId">
                    {{ $t("Add") }}
                </button>
            </div>
        </form>

        <div v-for="section in widgetSections" :key="section.name" class="widget-section mb-4">
            <h6 v-if="section.name">{{ section.name }}</h6>
            <div class="row">
                <div v-for="widget in section.widgets" :key="widget.id" class="col-md-4 mb-3">
                    <div class="card widget-card">
                        <div class="card-body text-center">
                            <button
                                class="btn btn-normal btn-sm remove-widget"
                                type="button"
                                @click="$emit('remove-widget', widget)"
                            >
                                <font-awesome-icon icon="times" />
                            </button>

                            <template v-if="widget.kind === 'metric_gauge' && metricGaugeProps(widget.monitorId)">
                                <MetricGaugeWidget v-bind="metricGaugeProps(widget.monitorId)" />
                            </template>
                            <template v-else-if="widget.kind === 'group_summary'">
                                <GroupSummaryWidget :monitor-id="widget.monitorId" />
                            </template>
                            <template v-else>
                                <font-awesome-icon icon="circle" :class="statusClass(widget.monitorId)" />
                            </template>

                            <div class="widget-name mt-1">
                                {{ widget.monitorName || $t("notAvailableShort") }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div v-if="widgets.length === 0" class="text-center text-muted p-3">
            {{ $t("notAvailableShort") }}
        </div>
    </div>
    <div v-else class="text-center text-muted p-5">
        {{ $t("Select a dashboard to view its widgets") }}
    </div>
</template>

<script>
import { defineAsyncComponent } from "vue";
import GroupSummaryWidget from "./GroupSummaryWidget.vue";
import { extractMetricValue, isMetricMonitorType } from "../metric-value.js";

const MetricGaugeWidget = defineAsyncComponent(() => import("./MetricGaugeWidget.vue"));

/**
 * Detail pane for a single team dashboard (ADR-0016): the "Add widget" form,
 * the widget list grouped by section, and per-kind widget rendering
 * (status_tile inline, metric_gauge via MetricGaugeWidget, group_summary via
 * GroupSummaryWidget). Purely presentational -- the parent (TeamDashboards.vue)
 * owns fetching/persisting the dashboard's widget list; this component only
 * emits add-widget/remove-widget requests and lets the parent perform the
 * actual mutation + save (GAP-016 split out of TeamDashboards.vue).
 */
export default {
    components: {
        GroupSummaryWidget,
        MetricGaugeWidget,
    },
    props: {
        /** The selected dashboard ({ id, title, teamId }), or null when none is selected */
        dashboard: {
            type: Object,
            default: null,
        },
        /** The selected dashboard's full, ordered widget list */
        widgets: {
            type: Array,
            default: () => [],
        },
    },
    emits: ["add-widget", "remove-widget"],
    data() {
        return {
            newWidgetMonitorId: null,
            newWidgetKind: "status_tile",
            newWidgetSection: "",
        };
    },
    computed: {
        /**
         * Monitors belonging to the same team as the currently selected
         * dashboard -- a widget can only reference a monitor from that team
         * (enforced server-side too, see dashboard-socket-handler.js).
         * @returns {Array<object>} Candidate monitors for the "Add widget" form
         */
        teamMonitorOptions() {
            if (!this.dashboard) {
                return [];
            }
            const teamId = this.dashboard.teamId;
            return Object.values(this.$root.monitorList || {}).filter((m) => m.teamId === teamId);
        },
        /**
         * The selected dashboard's widgets grouped by their optional section
         * heading, in the order they were saved -- mirrors save_status_page's
         * groups ergonomics without a separate sections table (ADR-0016).
         * @returns {Array<{name: string, widgets: Array<object>}>} Sections in order
         */
        widgetSections() {
            const sections = [];
            const byName = new Map();
            for (const widget of this.widgets) {
                const name = widget.sectionName || "";
                if (!byName.has(name)) {
                    const section = { name, widgets: [] };
                    byName.set(name, section);
                    sections.push(section);
                }
                byName.get(name).widgets.push(widget);
            }
            return sections;
        },
    },
    methods: {
        /**
         * Emit an add-widget request built from the "Add widget" form, then
         * reset the form. The parent owns the actual list mutation + save.
         * @returns {void}
         */
        submitAddWidget() {
            this.$emit("add-widget", {
                monitorId: this.newWidgetMonitorId,
                kind: this.newWidgetKind,
                sectionName: this.newWidgetSection || null,
            });
            this.newWidgetMonitorId = null;
            this.newWidgetSection = "";
        },

        /**
         * Props for a MetricGaugeWidget rendering the given monitor's current
         * value, or null when it isn't a metric monitor or has no value yet.
         * Same derivation as Details.vue's metricGaugeProps.
         * @param {number} monitorId The widget's monitor id
         * @returns {object|null} Props to bind onto MetricGaugeWidget, or null
         */
        metricGaugeProps(monitorId) {
            const monitor = this.$root.monitorList[monitorId];
            if (!monitor || !isMetricMonitorType(monitor.type)) {
                return null;
            }
            const lastHeartbeat = this.$root.lastHeartbeatList[monitorId];
            if (!lastHeartbeat) {
                return null;
            }
            const value = extractMetricValue(lastHeartbeat.msg);
            if (value === null) {
                return null;
            }
            const unit = monitor.metricUnit || "";
            return {
                value,
                status: lastHeartbeat.status,
                thresholdOperator: monitor.jsonPathOperator,
                thresholdValue: monitor.expectedValue,
                unit,
                max: unit === "%" ? 100 : null,
            };
        },

        /**
         * FontAwesome class for a status_tile widget's colored status dot.
         * @param {number} monitorId The widget's monitor id
         * @returns {string} A CSS class name
         */
        statusClass(monitorId) {
            const monitor = this.$root.monitorList[monitorId];
            if (monitor && !monitor.active) {
                return "status-paused";
            }
            const beat = this.$root.lastHeartbeatList[monitorId];
            if (!beat) {
                return "status-pending";
            }
            switch (beat.status) {
                case 1:
                    return "status-up";
                case 0:
                    return "status-down";
                default:
                    return "status-pending";
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.widget-card {
    position: relative;
}

.remove-widget {
    position: absolute;
    top: 4px;
    right: 4px;
}

.widget-name {
    font-size: 0.85rem;
}

.status-up {
    color: #5cdd8b;
}

.status-down {
    color: #dc3545;
}

.status-pending {
    color: #f8a306;
}

.status-paused {
    color: #808080;
}
</style>
