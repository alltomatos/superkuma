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

        <div class="list-group">
            <router-link
                v-for="dashboard in dashboardList"
                :key="dashboard.id"
                :to="`/dashboard-builder/${dashboard.id}`"
                class="list-group-item list-group-item-action"
            >
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <div>
                            {{ dashboard.title }}
                            <span v-if="dashboard.published" class="badge bg-primary ms-1">{{ $t("Published") }}</span>
                        </div>
                        <small class="text-muted">
                            {{ dashboard.teamName }} &middot; {{ dashboard.widgetCount }} {{ $t("widgets") }}
                        </small>
                    </div>
                    <button class="btn btn-normal btn-sm" type="button" @click.prevent.stop="deleteDialog(dashboard)">
                        <font-awesome-icon icon="trash" />
                    </button>
                </div>
            </router-link>
            <div v-if="dashboardList.length === 0" class="text-center text-muted p-3">
                {{ $t("notAvailableShort") }}
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

/**
 * List of the current team's dashboards (ADR-0016/ADR-0017): create new ones,
 * delete existing ones, and navigate into the Grafana-style builder
 * (DashboardBuilder.vue, at /dashboard-builder/:id) to edit a dashboard's
 * panels.
 */
export default {
    components: {
        Confirm,
    },
    data() {
        return {
            newDashboardTitle: "",
            creatingDashboard: false,
            createModal: null,
            pendingDeleteDashboard: null,
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
         * Create a dashboard from the dialog's form, then navigate straight
         * into its builder (same "create, then edit" flow as add-status-page).
         * @returns {void}
         */
        submitCreate() {
            this.creatingDashboard = true;
            this.$root.createDashboard({ title: this.newDashboardTitle }, (res) => {
                this.creatingDashboard = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    // Navigate first: the page unmounts right after, so a
                    // broken modal teardown (e.g. Bootstrap's Modal throwing
                    // on hide()) can never block leaving this page.
                    this.$router.push(`/dashboard-builder/${res.dashboardId}`);
                    try {
                        this.createModal.hide();
                    } catch (e) {
                        void e;
                    }
                }
            });
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
