<template>
    <div>
        <h5>{{ $t("Notification Routing") }}</h5>
        <p class="form-text">{{ $t("notificationRoutingDescription") }}</p>

        <div class="add-btn">
            <button class="btn btn-primary me-2" type="button" @click="openCreateModal">
                <font-awesome-icon icon="plus" />
                {{ $t("Add Route") }}
            </button>
        </div>

        <table class="table">
            <thead>
                <tr>
                    <th>{{ $t("Team") }}</th>
                    <th>{{ $t("Minimum Severity") }}</th>
                    <th>{{ $t("Monitor") }}</th>
                    <th>{{ $t("Tag") }}</th>
                    <th>{{ $t("Notification") }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="route in routeList" :key="route.id">
                    <td>
                        <span v-if="route.team_id === null" class="badge bg-secondary">{{ $t("Global") }}</span>
                        <span v-else>{{ route.teamName }}</span>
                    </td>
                    <td>{{ $t("severity_" + route.min_severity) }}</td>
                    <td>{{ route.monitorName || $t("Any") }}</td>
                    <td>{{ route.tagName || $t("Any") }}</td>
                    <td>{{ route.notificationName }}</td>
                    <td class="text-end">
                        <button class="btn btn-normal btn-sm" type="button" @click="deleteDialog(route)">
                            <font-awesome-icon icon="trash" />
                            {{ $t("Delete") }}
                        </button>
                    </td>
                </tr>
                <tr v-if="routeList.length === 0">
                    <td colspan="6" class="text-center text-muted">{{ $t("notAvailableShort") }}</td>
                </tr>
            </tbody>
        </table>

        <!-- Add route -->
        <div ref="createModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitCreate">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("Add Route") }}</h5>
                            <button
                                type="button"
                                class="btn-close"
                                data-bs-dismiss="modal"
                                :aria-label="$t('Close')"
                            />
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label" for="newRouteTeam">{{ $t("Team") }}</label>
                                <select id="newRouteTeam" v-model="newRoute.teamId" class="form-select">
                                    <option v-if="isSuperadmin" :value="null">{{ $t("Global (all teams)") }}</option>
                                    <option v-for="team in teamList" :key="team.id" :value="team.id">
                                        {{ team.name }}
                                    </option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newRouteSeverity">{{ $t("Minimum Severity") }}</label>
                                <select id="newRouteSeverity" v-model="newRoute.minSeverity" class="form-select">
                                    <option value="info">{{ $t("severity_info") }}</option>
                                    <option value="warning">{{ $t("severity_warning") }}</option>
                                    <option value="critical">{{ $t("severity_critical") }}</option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newRouteMonitor">{{ $t("Monitor") }}</label>
                                <select id="newRouteMonitor" v-model="newRoute.monitorId" class="form-select">
                                    <option :value="null">{{ $t("Any") }}</option>
                                    <option v-for="monitor in monitorOptions" :key="monitor.id" :value="monitor.id">
                                        {{ monitor.name }}
                                    </option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newRouteTag">{{ $t("Tag") }}</label>
                                <select id="newRouteTag" v-model="newRoute.tagId" class="form-select">
                                    <option :value="null">{{ $t("Any") }}</option>
                                    <option v-for="tag in tagsList" :key="tag.id" :value="tag.id">
                                        {{ tag.name }}
                                    </option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="newRouteNotification">{{ $t("Notification") }}</label>
                                <select
                                    id="newRouteNotification"
                                    v-model="newRoute.notificationId"
                                    class="form-select"
                                    required
                                >
                                    <option v-for="notification in notificationList" :key="notification.id" :value="notification.id">
                                        {{ notification.name }}
                                    </option>
                                </select>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button
                                type="submit"
                                class="btn btn-primary"
                                :disabled="creatingRoute || !newRoute.notificationId"
                            >
                                <div v-if="creatingRoute" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Add Route") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <Confirm ref="confirmDelete" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="deleteRoute">
            {{ $t("confirmDeleteRouteMsg") }}
        </Confirm>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import Confirm from "../Confirm.vue";

/**
 * Default fields for the "Add Route" form.
 * @returns {object} A fresh newRoute object
 */
function emptyRoute() {
    return {
        teamId: null,
        minSeverity: "critical",
        monitorId: null,
        tagId: null,
        notificationId: null,
    };
}

export default {
    components: {
        Confirm,
    },
    data() {
        return {
            newRoute: emptyRoute(),
            creatingRoute: false,
            createModal: null,
            pendingDeleteRoute: null,
            tagsList: [],
        };
    },
    computed: {
        routeList() {
            return this.$root.routeList;
        },
        teamList() {
            return this.$root.teamList;
        },
        notificationList() {
            return this.$root.notificationList;
        },
        isSuperadmin() {
            return !!(this.$root.info && this.$root.info.currentUser && this.$root.info.currentUser.isSuperadmin);
        },
        /**
         * Monitors belonging to the currently selected team in the Add Route
         * form, since a route's monitor/tag selectors only make sense scoped
         * to the team it's being created for.
         * @returns {Array<object>} Candidate monitors for the dropdown
         */
        monitorOptions() {
            const teamId = this.newRoute.teamId;
            return Object.values(this.$root.monitorList || {}).filter(
                (m) => teamId === null || m.team_id === teamId
            );
        },
    },

    mounted() {
        this.$root.getNotificationRouteList();
        this.$root.getTeamList();
        this.loadTags();
        this.createModal = new Modal(this.$refs.createModal);
    },

    methods: {
        /**
         * Fetch the raw tag list for the "Tag" dropdown, mirroring Tags.vue's
         * own direct getTags() call (there is no mixin-wrapped tag list).
         * @returns {void}
         */
        loadTags() {
            this.$root.getSocket().emit("getTags", (res) => {
                if (res.ok) {
                    this.tagsList = res.tags;
                }
            });
        },

        /**
         * Open the "Add Route" dialog.
         * @returns {void}
         */
        openCreateModal() {
            this.newRoute = emptyRoute();
            this.createModal.show();
        },

        /**
         * Create a notification route from the dialog's form.
         * @returns {void}
         */
        submitCreate() {
            this.creatingRoute = true;
            this.$root.createNotificationRoute(this.newRoute, (res) => {
                this.creatingRoute = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.createModal.hide();
                }
            });
        },

        /**
         * Show a confirmation dialog before deleting a route.
         * @param {object} route The route to delete
         * @returns {void}
         */
        deleteDialog(route) {
            this.pendingDeleteRoute = route;
            this.$refs.confirmDelete.show();
        },

        /**
         * Delete the pending route.
         * @returns {void}
         */
        deleteRoute() {
            this.$root.deleteNotificationRoute(this.pendingDeleteRoute.id, (res) => {
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
