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
                    <td>{{ item.username }}</td>
                    <td>{{ item.email }}</td>
                    <td class="text-end">
                        <button
                            v-if="item.email"
                            class="btn btn-normal btn-sm"
                            type="button"
                            @click="resendDialog(item.id)"
                        >
                            <font-awesome-icon icon="paper-plane" />
                            {{ $t("Resend Welcome Email") }}
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>

        <UserDialog ref="userDialog" />

        <Confirm ref="confirmResend" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="resendWelcome">
            {{ $t("resendWelcomeMsg") }}
        </Confirm>
    </div>
</template>

<script>
import UserDialog from "../../components/UserDialog.vue";
import Confirm from "../Confirm.vue";

export default {
    components: {
        UserDialog,
        Confirm,
    },
    data() {
        return {
            selectedUserID: null,
        };
    },
    computed: {
        userList() {
            return this.$root.userList;
        },
    },

    mounted() {
        this.$root.getUserList();
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
    },
};
</script>

<style lang="scss" scoped>
.add-btn {
    padding-top: 10px;
    padding-bottom: 20px;
}
</style>
