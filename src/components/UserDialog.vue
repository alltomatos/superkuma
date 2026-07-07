<template>
    <form @submit.prevent="submit">
        <div ref="addModal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("Add User") }}
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
                                required
                            />
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
                            <div class="form-text">
                                {{ $t("userWelcomeEmailDescription") }}
                            </div>
                        </div>

                        <!-- Password -->
                        <div class="mb-3">
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
                            {{ $t("Add User") }}
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
    emits: ["added"],
    data() {
        return {
            addModal: null,
            processing: false,
            user: {},
        };
    },

    mounted() {
        this.addModal = new Modal(this.$refs.addModal);
    },

    methods: {
        /**
         * Show modal
         * @returns {void}
         */
        show() {
            this.clearForm();
            this.addModal.show();
        },

        /**
         * Submit data to server
         * @returns {void}
         */
        submit() {
            this.processing = true;

            this.$root.addUser(this.user, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.addModal.hide();
                    this.clearForm();
                    this.$emit("added");
                }
            });
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
