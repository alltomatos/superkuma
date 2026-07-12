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
                <DashboardDetail
                    :dashboard="selectedDashboard"
                    :widgets="selectedWidgets"
                    @add-widget="addWidget"
                    @remove-widget="removeWidget"
                />
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
import { Modal } from "bootstrap";
import Confirm from "../components/Confirm.vue";
import DashboardDetail from "../components/DashboardDetail.vue";

export default {
    components: {
        Confirm,
        DashboardDetail,
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
        };
    },
    computed: {
        dashboardList() {
            return this.$root.dashboardList;
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
         * Add a widget to the selected dashboard from DashboardDetail's
         * "Add widget" form.
         * @param {object} newWidget Fields from the form ({ monitorId, kind, sectionName })
         * @returns {void}
         */
        addWidget(newWidget) {
            const monitor = this.$root.monitorList[newWidget.monitorId];
            this.selectedWidgets.push({
                id: `pending-${Date.now()}`,
                monitorId: newWidget.monitorId,
                monitorName: monitor ? monitor.name : null,
                kind: newWidget.kind,
                sectionName: newWidget.sectionName || null,
            });
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
    },
};
</script>

<style lang="scss" scoped>
.add-btn {
    padding-top: 10px;
    padding-bottom: 20px;
}
</style>
