<template>
    <form @submit.prevent="submit">
        <div ref="addModal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("Add Remote Instance") }}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                    </div>
                    <div class="modal-body">
                        <!-- Name -->
                        <div class="mb-3">
                            <label for="remote-instance-name" class="form-label">{{ $t("Name") }}</label>
                            <input
                                id="remote-instance-name"
                                v-model="remoteInstance.name"
                                type="text"
                                class="form-control"
                                required
                            />
                        </div>

                        <!-- Instance ID -->
                        <div class="mb-3">
                            <label for="remote-instance-id" class="form-label">{{ $t("Instance ID") }}</label>
                            <input
                                id="remote-instance-id"
                                v-model="remoteInstance.instanceId"
                                type="text"
                                class="form-control"
                                required
                            />
                            <div class="form-text">
                                {{ $t("remoteInstanceIdDescription") }}
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-primary" type="submit" :disabled="processing">
                            {{ $t("Add Remote Instance") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div ref="tokenModal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("Remote Instance Added") }}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                    </div>

                    <div class="modal-body">
                        <div class="mb-3">
                            {{ $t("remoteInstanceTokenAddedMsg") }}
                        </div>
                        <div class="mb-3">
                            <CopyableInput v-model="clearToken" disabled="disabled" />
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button type="button" class="btn btn-primary" data-bs-dismiss="modal">
                            {{ $t("Continue") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>
</template>

<script>
import { Modal } from "bootstrap";
import CopyableInput from "./CopyableInput.vue";

export default {
    components: {
        CopyableInput,
    },
    data() {
        return {
            addModal: null,
            tokenModal: null,
            processing: false,
            remoteInstance: {},
            clearToken: null,
        };
    },

    mounted() {
        this.addModal = new Modal(this.$refs.addModal);
        this.tokenModal = new Modal(this.$refs.tokenModal);
    },

    methods: {
        /**
         * Show modal
         * @returns {void}
         */
        show() {
            this.remoteInstance = {
                name: "",
                instanceId: "",
            };

            this.addModal.show();
        },

        /**
         * Submit data to server
         * @returns {void}
         */
        submit() {
            this.processing = true;

            this.$root.addRemoteInstance(this.remoteInstance, (res) => {
                this.addModal.hide();
                this.processing = false;
                if (res.ok) {
                    this.clearToken = res.token;
                    this.tokenModal.show();
                    this.clearForm();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Clear Form inputs
         * @returns {void}
         */
        clearForm() {
            this.remoteInstance = {
                name: "",
                instanceId: "",
            };
        },
    },
};
</script>
