<template>
    <form @submit.prevent="submit">
        <div ref="addModal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ editing ? $t("Edit User") : $t("Add User") }}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                    </div>
                    <div class="modal-body">
                        <!-- Username -->
                        <div class="mb-3">
                            <label for="user-username" class="form-label">{{ $t("Username") }}</label>
                            <input
                                id="user-username"
                                v-model="user.username"
                                type="text"
                                class="form-control"
                                autocomplete="off"
                                pattern="\S+"
                                :title="$t('usernameNoSpacesDescription')"
                                required
                                @input="normalizeUsername"
                            />
                            <div class="form-text">
                                {{ $t("usernameNoSpacesDescription") }}
                            </div>
                        </div>

                        <!-- Email -->
                        <div class="mb-3">
                            <label for="user-email" class="form-label">{{ $t("Email") }}</label>
                            <input
                                id="user-email"
                                v-model="user.email"
                                type="email"
                                class="form-control"
                                autocomplete="off"
                                required
                            />
                            <div v-if="!editing" class="form-text">
                                {{ $t("userWelcomeEmailDescription") }}
                            </div>
                        </div>

                        <!-- Password (add mode only; editing an existing user reuses the dedicated Set Password action) -->
                        <div v-if="!editing" class="mb-3">
                            <label for="user-password" class="form-label">{{ $t("Password") }}</label>
                            <input
                                id="user-password"
                                v-model="user.password"
                                type="password"
                                class="form-control"
                                autocomplete="new-password"
                            />
                            <div class="form-text">
                                {{ $t("userPasswordGeneratedDescription") }}
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-primary" type="submit" :disabled="processing">
                            {{ editing ? $t("Save") : $t("Add User") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>
</template>

<script>
import { Modal } from "bootstrap";

export default {
    emits: ["added", "edited"],
    data() {
        return {
            addModal: null,
            processing: false,
            editing: false,
            user: {},
        };
    },

    mounted() {
        this.addModal = new Modal(this.$refs.addModal);
    },

    methods: {
        /**
         * Show modal in "add user" mode
         * @returns {void}
         */
        show() {
            this.editing = false;
            this.clearForm();
            this.addModal.show();
        },

        /**
         * Show modal pre-filled for editing an existing user.
         * @param {object} user Existing user ({ id, username, email })
         * @returns {void}
         */
        showEdit(user) {
            this.editing = true;
            this.user = {
                id: user.id,
                username: user.username,
                email: user.email,
            };
            this.addModal.show();
        },

        /**
         * Force the username field to stay lowercase and space-free as the
         * admin types, rather than only rejecting on submit.
         * @returns {void}
         */
        normalizeUsername() {
            this.user.username = (this.user.username || "").toLowerCase().replace(/\s/g, "");
        },

        /**
         * Submit data to server
         * @returns {void}
         */
        submit() {
            this.processing = true;

            const done = (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.addModal.hide();
                    this.clearForm();
                    this.$emit(this.editing ? "edited" : "added");
                }
            };

            if (this.editing) {
                this.$root.editUser(this.user, done);
            } else {
                this.$root.addUser(this.user, done);
            }
        },

        /**
         * Clear Form inputs
         * @returns {void}
         */
        clearForm() {
            this.user = {
                username: "",
                email: "",
                password: "",
            };
        },
    },
};
</script>
