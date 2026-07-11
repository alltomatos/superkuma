<template>
    <div>
        <h1 class="mb-3">{{ $t("Dashboards") }}</h1>
        <p class="form-text">{{ $t("teamDashboardsDescription") }}</p>

        <div class="add-btn">
            <button class="btn btn-primary me-2" type="button" @click="openCreateModal">
                <font-awesome-icon icon="plus" />
                {{ $t("New Dashboard") }}
            </button>
        </div>

        <div class="row">
            <div class="col-md-4">
                <div class="list-group">
                    <button
                        v-for="dashboard in dashboardList"
                        :key="dashboard.id"
                        type="button"
                        class="list-group-item list-group-item-action"
                        :class="{ active: dashboard.id === selectedDashboardId }"
                        @click="selectDashboard(dashboard.id)"
                    >
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div>{{ dashboard.title }}</div>
                                <small class="text-muted">
                                    {{ dashboard.teamName }} &middot; {{ dashboard.widgetCount }} {{ $t("widgets") }}
                                </small>
                            </div>
                            <button class="btn btn-normal btn-sm" type="button" @click.stop="deleteDialog(dashboard)">
                                <font-awesome-icon icon="trash" />
                            </button>
                        </div>
                    </button>
                    <div v-if="dashboardList.length === 0" class="text-center text-muted p-3">
                        {{ $t("notAvailableShort") }}
                    </div>
                </div>
            </div>

            <div class="col-md-8">
                <div v-if="selectedDashboard">
                    <h4>{{ selectedDashboard.title }}</h4>

                    <form class="add-widget-form row g-2 align-items-end mb-4" @submit.prevent="addWidget">
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
                                            @click="removeWidget(widget)"
                                        >
                                            <font-awesome-icon icon="times" />
                                        </button>

                                        <template
                                            v-if="widget.kind === 'metric_gauge' && metricGaugeProps(widget.monitorId)"
                                        >
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
                    <div v-if="selectedWidgets.length === 0" class="text-center text-muted p-3">
                        {{ $t("notAvailableShort") }}
                    </div>
                </div>
                <div v-else class="text-center text-muted p-5">
                    {{ $t("Select a dashboard to view its widgets") }}
                </div>
            </div>
        </div>

        <!-- Create dashboard -->
        <div ref="createModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitCreate">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("New Dashboard") }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label" for="newDashboardTitle">{{ $t("Title") }}</label>
                                <input
                                    id="newDashboardTitle"
                                    v-model="newDashboardTitle"
                                    type="text"
                                    class="form-control"
                                    required
                                />
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button
                                type="submit"
                                class="btn btn-primary"
                                :disabled="creatingDashboard || !newDashboardTitle"
                            >
                                <div v-if="creatingDashboard" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Create") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <Confirm
            ref="confirmDelete"
            btn-style="btn-danger"
            :yes-text="$t('Yes')"
            :no-text="$t('No')"
            @yes="deleteDashboard"
        >
            {{ $t("confirmDeleteDashboardMsg") }}
        </Confirm>
    </div>
</template>

<script>
import { defineAsyncComponent } from "vue";
import { Modal } from "bootstrap";
import Confirm from "../components/Confirm.vue";
import GroupSummaryWidget from "../components/GroupSummaryWidget.vue";
import { extractMetricValue, isMetricMonitorType } from "../metric-value.js";

const MetricGaugeWidget = defineAsyncComponent(() => import("../components/MetricGaugeWidget.vue"));

export default {
    components: {
        Confirm,
        GroupSummaryWidget,
        MetricGaugeWidget,
    },
    data() {
        return {
            newDashboardTitle: "",
            creatingDashboard: false,
            createModal: null,
            pendingDeleteDashboard: null,
            selectedDashboardId: null,
            selectedDashboard: null,
            selectedWidgets: [],
            newWidgetMonitorId: null,
            newWidgetKind: "status_tile",
            newWidgetSection: "",
        };
    },
    computed: {
        dashboardList() {
            return this.$root.dashboardList;
        },
        /**
         * Monitors belonging to the same team as the currently selected
         * dashboard -- a widget can only reference a monitor from that team
         * (enforced server-side too, see dashboard-socket-handler.js).
         * @returns {Array<object>} Candidate monitors for the "Add widget" form
         */
        teamMonitorOptions() {
            if (!this.selectedDashboard) {
                return [];
            }
            const teamId = this.selectedDashboard.teamId;
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
            for (const widget of this.selectedWidgets) {
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
    mounted() {
        this.$root.getDashboardList();
        this.createModal = new Modal(this.$refs.createModal);
    },
    methods: {
        /**
         * Open the "New Dashboard" dialog.
         * @returns {void}
         */
        openCreateModal() {
            this.newDashboardTitle = "";
            this.createModal.show();
        },

        /**
         * Create a dashboard from the dialog's form.
         * @returns {void}
         */
        submitCreate() {
            this.creatingDashboard = true;
            this.$root.createDashboard({ title: this.newDashboardTitle }, (res) => {
                this.creatingDashboard = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.createModal.hide();
                }
            });
        },

        /**
         * Load a dashboard's full widget list into the detail pane.
         * @param {number} id Dashboard id
         * @returns {void}
         */
        selectDashboard(id) {
            this.$root.getDashboard(id, (res) => {
                if (res.ok) {
                    this.selectedDashboardId = id;
                    this.selectedDashboard = res.dashboard;
                    this.selectedWidgets = res.widgets;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Persist the current in-memory widget list (full replace, same
         * semantics as save_status_page).
         * @returns {void}
         */
        persistWidgets() {
            this.$root.saveDashboard(
                {
                    id: this.selectedDashboardId,
                    widgets: this.selectedWidgets.map((w) => ({
                        monitorId: w.monitorId,
                        kind: w.kind,
                        sectionName: w.sectionName || undefined,
                    })),
                },
                (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                        // Reload from the server to undo the optimistic local change.
                        this.selectDashboard(this.selectedDashboardId);
                    }
                }
            );
        },

        /**
         * Add a widget to the selected dashboard from the "Add widget" form.
         * @returns {void}
         */
        addWidget() {
            const monitor = this.$root.monitorList[this.newWidgetMonitorId];
            this.selectedWidgets.push({
                id: `pending-${Date.now()}`,
                monitorId: this.newWidgetMonitorId,
                monitorName: monitor ? monitor.name : null,
                kind: this.newWidgetKind,
                sectionName: this.newWidgetSection || null,
            });
            this.newWidgetMonitorId = null;
            this.newWidgetSection = "";
            this.persistWidgets();
        },

        /**
         * Remove a widget from the selected dashboard.
         * @param {object} widget The widget to remove
         * @returns {void}
         */
        removeWidget(widget) {
            this.selectedWidgets = this.selectedWidgets.filter((w) => w !== widget);
            this.persistWidgets();
        },

        /**
         * Show a confirmation dialog before deleting a dashboard.
         * @param {object} dashboard The dashboard to delete
         * @returns {void}
         */
        deleteDialog(dashboard) {
            this.pendingDeleteDashboard = dashboard;
            this.$refs.confirmDelete.show();
        },

        /**
         * Delete the pending dashboard.
         * @returns {void}
         */
        deleteDashboard() {
            const id = this.pendingDeleteDashboard.id;
            this.$root.deleteDashboard(id, (res) => {
                this.$root.toastRes(res);
                if (res.ok && this.selectedDashboardId === id) {
                    this.selectedDashboardId = null;
                    this.selectedDashboard = null;
                    this.selectedWidgets = [];
                }
            });
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
.add-btn {
    padding-top: 10px;
    padding-bottom: 20px;
}

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
