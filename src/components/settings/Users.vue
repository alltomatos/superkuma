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
                </tr>
            </thead>
            <tbody>
                <tr v-for="item in userList" :key="item.id">
                    <td>{{ item.username }}</td>
                    <td>{{ item.email }}</td>
                </tr>
            </tbody>
        </table>

        <UserDialog ref="userDialog" />
    </div>
</template>

<script>
import UserDialog from "../../components/UserDialog.vue";

export default {
    components: {
        UserDialog,
    },
    computed: {
        userList() {
            return this.$root.userList;
        },
    },

    mounted() {
        this.$root.getUserList();
    },
};
</script>

<style lang="scss" scoped>
.add-btn {
    padding-top: 10px;
    padding-bottom: 20px;
}
</style>
