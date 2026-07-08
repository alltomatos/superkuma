<template>
    <div>
        <h5>{{ $t("Users") }}</h5>
        <p class="form-text">{{ $t("usersDescription") }}</p>

        <div class="add-btn">
            <button class="btn btn-primary me-2" type="button" @click="$refs.userDialog.show()">
                <font-awesome-icon icon="plus" />
                {{ $t("Add User") }}
            </button>
        </div>

        <table class="table">
            <thead>
                <tr>
                    <th>{{ $t("Username") }}</th>
                    <th>{{ $t("Email") }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="item in userList" :key="item.id">
                    <td>
                        {{ item.username }}
                        <span v-if="item.is_superadmin" class="badge bg-primary ms-1">{{ $t("Admin") }}</span>
                    </td>
                    <td>{{ item.email }}</td>
                    <td class="text-end">
                        <div class="d-flex gap-2 justify-content-end">
                            <button
                                v-if="item.email"
                                class="btn btn-normal btn-sm"
                                type="button"
                                @click="resendDialog(item.id)"
                            >
                                <font-awesome-icon icon="paper-plane" />
                                {{ $t("Resend Welcome Email") }}
                            </button>
                            <button class="btn btn-normal btn-sm" type="button" @click="setPasswordDialog(item.id)">
                                <font-awesome-icon icon="key" />
                                {{ $t("Set Password") }}
                            </button>
                            <button
                                class="btn btn-normal btn-sm"
                                type="button"
                                @click="toggleSuperadminDialog(item.id, !item.is_superadmin)"
                            >
                                <font-awesome-icon icon="user-shield" />
                                {{ item.is_superadmin ? $t("Remove Admin") : $t("Make Admin") }}
                            </button>
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>

        <UserDialog ref="userDialog" />

        <Confirm ref="confirmResend" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="resendWelcome">
            {{ $t("resendWelcomeMsg") }}
        </Confirm>

        <Confirm ref="confirmSuperadmin" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="toggleSuperadmin">
            {{ confirmSuperadminMsg }}
        </Confirm>

        <!-- Manual password entry for an existing user -->
        <div ref="setPasswordModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitSetPassword">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("Set Password") }}</h5>
                            <button
                                type="button"
                                class="btn-close"
                                data-bs-dismiss="modal"
                                :aria-label="$t('Close')"
                            />
                        </div>
                        <div class="modal-body">
                            <label class="form-label" for="newUserPassword">{{ $t("Password") }}</label>
                            <HiddenInput id="newUserPassword" v-model="newPassword" required />

                            <div class="form-check form-switch">
                                <input
                                    id="setPasswordSendEmail"
                                    v-model="setPasswordSendEmail"
                                    class="form-check-input"
                                    type="checkbox"
                                    :disabled="!selectedUserEmail"
                                />
                                <label class="form-check-label" for="setPasswordSendEmail">
                                    {{ $t("notifyUserByEmail") }}
                                </label>
                            </div>
                            <div v-if="!selectedUserEmail" class="form-text">{{ $t("userHasNoEmail") }}</div>
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary" :disabled="settingPassword">
                                <div v-if="settingPassword" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Set Password") }}
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
import UserDialog from "../../components/UserDialog.vue";
import Confirm from "../Confirm.vue";
import HiddenInput from "../../components/HiddenInput.vue";

export default {
    components: {
        UserDialog,
        Confirm,
        HiddenInput,
    },
    data() {
        return {
            selectedUserID: null,
            newPassword: "",
            setPasswordSendEmail: false,
            settingPassword: false,
            setPasswordModal: null,
            pendingSuperadminValue: null,
        };
    },
    computed: {
        userList() {
            return this.$root.userList;
        },
        /**
         * Email of the user currently targeted by the set-password modal, or
         * null (used to gate the "notify by email" checkbox).
         * @returns {string|null} The selected user's email, or null
         */
        selectedUserEmail() {
            const user = (this.userList || []).find((item) => item.id === this.selectedUserID);
            return (user && user.email) || null;
        },
        /**
         * Confirmation text for the pending admin-status change (grant vs revoke).
         * @returns {string} The translated confirmation message
         */
        confirmSuperadminMsg() {
            return this.pendingSuperadminValue ? this.$t("makeAdminMsg") : this.$t("removeAdminMsg");
        },
    },

    mounted() {
        this.$root.getUserList();
        this.setPasswordModal = new Modal(this.$refs.setPasswordModal);
    },

    methods: {
        /**
         * Show dialog to confirm resending a user's welcome email
         * @param {number} id ID of the user to resend credentials to
         * @returns {void}
         */
        resendDialog(id) {
            this.selectedUserID = id;
            this.$refs.confirmResend.show();
        },

        /**
         * Resend (reissue) the selected user's welcome email
         * @returns {void}
         */
        resendWelcome() {
            this.$root.resendWelcome(this.selectedUserID, (res) => {
                this.$root.toastRes(res);
            });
        },

        /**
         * Open the manual password-entry modal for a user.
         * @param {number} id ID of the user to set a password for
         * @returns {void}
         */
        setPasswordDialog(id) {
            this.selectedUserID = id;
            this.newPassword = "";
            this.setPasswordSendEmail = false;
            this.setPasswordModal.show();
        },

        /**
         * Set the selected user's password to the typed value.
         * @returns {void}
         */
        submitSetPassword() {
            this.settingPassword = true;
            this.$root.setUserPassword(this.selectedUserID, this.newPassword, this.setPasswordSendEmail, (res) => {
                this.settingPassword = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.setPasswordModal.hide();
                }
            });
        },

        /**
         * Show dialog to confirm granting or revoking a user's admin status.
         * @param {number} id ID of the user to update
         * @param {boolean} makeSuperadmin Whether this would grant (true) or revoke (false) admin status
         * @returns {void}
         */
        toggleSuperadminDialog(id, makeSuperadmin) {
            this.selectedUserID = id;
            this.pendingSuperadminValue = makeSuperadmin;
            this.$refs.confirmSuperadmin.show();
        },

        /**
         * Apply the pending admin-status change for the selected user.
         * @returns {void}
         */
        toggleSuperadmin() {
            this.$root.setUserSuperadmin(this.selectedUserID, this.pendingSuperadminValue, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$root.getUserList();
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
