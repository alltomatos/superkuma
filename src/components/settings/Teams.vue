<template>
    <div>
        <h5>{{ $t("Teams") }}</h5>
        <p class="form-text">{{ $t("teamsDescription") }}</p>

        <div class="add-btn">
            <button class="btn btn-primary me-2" type="button" @click="openCreateTeamModal">
                <font-awesome-icon icon="plus" />
                {{ $t("Add Team") }}
            </button>
        </div>

        <table class="table">
            <thead>
                <tr>
                    <th>{{ $t("Name") }}</th>
                    <th>{{ $t("Slug") }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="team in teamList" :key="team.id">
                    <td>
                        {{ team.name }}
                        <span v-if="!team.active" class="badge bg-secondary ms-1">{{ $t("Inactive") }}</span>
                    </td>
                    <td>{{ team.slug }}</td>
                    <td class="text-end">
                        <button class="btn btn-normal btn-sm" type="button" @click="openMembersModal(team)">
                            <font-awesome-icon icon="users" />
                            {{ $t("Manage Members") }}
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>

        <!-- Create team -->
        <div ref="createTeamModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitCreateTeam">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("Add Team") }}</h5>
                            <button
                                type="button"
                                class="btn-close"
                                data-bs-dismiss="modal"
                                :aria-label="$t('Close')"
                            />
                        </div>
                        <div class="modal-body">
                            <label class="form-label" for="newTeamName">{{ $t("Name") }}</label>
                            <input
                                id="newTeamName"
                                v-model="newTeamName"
                                class="form-control"
                                autocomplete="off"
                                required
                            />
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary" :disabled="creatingTeam">
                                <div v-if="creatingTeam" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Add Team") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <!-- Manage members -->
        <div ref="membersModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("Manage Members") }} — {{ selectedTeam && selectedTeam.name }}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                    </div>
                    <div class="modal-body">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>{{ $t("Username") }}</th>
                                    <th>{{ $t("Role") }}</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="member in members" :key="member.id">
                                    <td>{{ member.username }}</td>
                                    <td>{{ member.roleName }}</td>
                                    <td class="text-end">
                                        <button
                                            class="btn btn-normal btn-sm"
                                            type="button"
                                            @click="removeMemberDialog(member)"
                                        >
                                            <font-awesome-icon icon="trash" />
                                            {{ $t("Remove") }}
                                        </button>
                                    </td>
                                </tr>
                                <tr v-if="members.length === 0">
                                    <td colspan="3" class="text-center text-muted">{{ $t("notAvailableShort") }}</td>
                                </tr>
                            </tbody>
                        </table>

                        <hr />

                        <form class="row g-2 align-items-end" @submit.prevent="submitAddMember">
                            <div class="col-md-5">
                                <label class="form-label" for="newMemberUserId">{{ $t("Username") }}</label>
                                <select id="newMemberUserId" v-model="newMemberUserId" class="form-select" required>
                                    <option v-for="user in addableUsers" :key="user.id" :value="user.id">
                                        {{ user.username }}
                                    </option>
                                </select>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label" for="newMemberRole">{{ $t("Role") }}</label>
                                <select id="newMemberRole" v-model="newMemberRole" class="form-select">
                                    <option v-for="slug in assignableRoles" :key="slug" :value="slug">
                                        {{ $t("teamRole_" + slug) }}
                                    </option>
                                </select>
                            </div>
                            <div class="col-md-3">
                                <button
                                    type="submit"
                                    class="btn btn-primary w-100"
                                    :disabled="addingMember || addableUsers.length === 0"
                                >
                                    <div v-if="addingMember" class="spinner-border spinner-border-sm me-1"></div>
                                    {{ $t("Add") }}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>

        <Confirm ref="confirmRemoveMember" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="removeMember">
            {{ $t("removeTeamMemberMsg") }}
        </Confirm>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import Confirm from "../Confirm.vue";

// Assignable per-team roles, in privilege order. "superadmin" is deliberately
// excluded -- that's the separate, global "Make Admin" toggle in Users.vue,
// not a per-team role.
const ASSIGNABLE_ROLES = ["owner", "admin", "editor", "viewer"];

export default {
    components: {
        Confirm,
    },
    data() {
        return {
            newTeamName: "",
            creatingTeam: false,
            createTeamModal: null,

            selectedTeam: null,
            members: [],
            newMemberUserId: null,
            newMemberRole: "viewer",
            addingMember: false,
            membersModal: null,
            pendingRemoveMember: null,

            assignableRoles: ASSIGNABLE_ROLES,
        };
    },
    computed: {
        teamList() {
            return this.$root.teamList;
        },
        /**
         * Users not already a member of the currently selected team, for the
         * "add member" dropdown.
         * @returns {Array<object>} Users available to add
         */
        addableUsers() {
            const memberIds = new Set(this.members.map((m) => m.id));
            return (this.$root.userList || []).filter((u) => !memberIds.has(u.id));
        },
    },

    mounted() {
        this.$root.getTeamList();
        this.$root.getUserList();
        this.createTeamModal = new Modal(this.$refs.createTeamModal);
        this.membersModal = new Modal(this.$refs.membersModal);
    },

    methods: {
        /**
         * Open the "Add Team" dialog.
         * @returns {void}
         */
        openCreateTeamModal() {
            this.newTeamName = "";
            this.createTeamModal.show();
        },

        /**
         * Create a new team from the dialog's form.
         * @returns {void}
         */
        submitCreateTeam() {
            this.creatingTeam = true;
            this.$root.createTeam(this.newTeamName, (res) => {
                this.creatingTeam = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.createTeamModal.hide();
                }
            });
        },

        /**
         * Open the member-management dialog for a team and load its members.
         * @param {object} team The team to manage
         * @returns {void}
         */
        openMembersModal(team) {
            this.selectedTeam = team;
            this.members = [];
            this.newMemberUserId = null;
            this.newMemberRole = "viewer";
            this.membersModal.show();
            this.loadMembers();
        },

        /**
         * (Re)load the selected team's member list. Guards against a slower,
         * earlier request (e.g. for a team the admin has since navigated
         * away from) overwriting the list for whichever team is currently
         * selected by the time the response arrives.
         * @returns {void}
         */
        loadMembers() {
            const requestedTeamId = this.selectedTeam.id;
            this.$root.getTeamMembers(requestedTeamId, (res) => {
                if (!this.selectedTeam || this.selectedTeam.id !== requestedTeamId) {
                    return;
                }
                if (res.ok) {
                    this.members = res.members;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Add the chosen user to the selected team with the chosen role.
         * @returns {void}
         */
        submitAddMember() {
            if (!this.newMemberUserId) {
                return;
            }
            this.addingMember = true;
            this.$root.addTeamMember(this.selectedTeam.id, this.newMemberUserId, this.newMemberRole, (res) => {
                this.addingMember = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.newMemberUserId = null;
                    this.loadMembers();
                }
            });
        },

        /**
         * Show a confirmation dialog before removing a member from the team.
         * @param {object} member The member to remove
         * @returns {void}
         */
        removeMemberDialog(member) {
            this.pendingRemoveMember = member;
            this.$refs.confirmRemoveMember.show();
        },

        /**
         * Remove the pending member from the selected team.
         * @returns {void}
         */
        removeMember() {
            this.$root.removeTeamMember(this.selectedTeam.id, this.pendingRemoveMember.id, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadMembers();
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
