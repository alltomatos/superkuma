<template>
    <div>
        <h5>{{ $t("Mail") }}</h5>
        <p class="form-text">{{ $t("mailSettingsDescription") }}</p>

        <form @submit.prevent="saveMail">
            <!-- Host -->
            <div class="mb-4">
                <label class="form-label" for="mailHost">{{ $t("SMTP Host") }}</label>
                <input id="mailHost" v-model="settings.mailHost" class="form-control" autocomplete="new-password" />
            </div>

            <!-- Port -->
            <div class="mb-4">
                <label class="form-label" for="mailPort">{{ $t("SMTP Port") }}</label>
                <input
                    id="mailPort"
                    v-model.number="settings.mailPort"
                    type="number"
                    class="form-control"
                    autocomplete="new-password"
                />
            </div>

            <!-- Secure -->
            <div class="mb-4 form-check form-switch">
                <input id="mailSecure" v-model="settings.mailSecure" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="mailSecure">{{ $t("enableSSL") }}</label>
            </div>

            <!-- Ignore TLS Error -->
            <div class="mb-4 form-check form-switch">
                <input
                    id="mailIgnoreTLSError"
                    v-model="settings.mailIgnoreTLSError"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="mailIgnoreTLSError">{{ $t("Ignore TLS Error") }}</label>
            </div>

            <!-- Username -->
            <div class="mb-4">
                <label class="form-label" for="mailUsername">{{ $t("Username") }}</label>
                <input
                    id="mailUsername"
                    v-model="settings.mailUsername"
                    class="form-control"
                    autocomplete="new-password"
                />
            </div>

            <!-- Password -->
            <div class="mb-4">
                <label class="form-label" for="mailPassword">{{ $t("Password") }}</label>
                <HiddenInput id="mailPassword" v-model="settings.mailPassword" autocomplete="new-password" />
            </div>

            <!-- From -->
            <div class="mb-4">
                <label class="form-label" for="mailFrom">{{ $t("From") }}</label>
                <input id="mailFrom" v-model="settings.mailFrom" class="form-control" autocomplete="new-password" />
            </div>

            <!-- Save / Verify / Test Buttons -->
            <div>
                <button class="btn btn-primary me-2" type="submit">
                    {{ $t("Save") }}
                </button>
                <button class="btn btn-normal me-2" type="button" :disabled="verifying" @click="verifyConnection">
                    <div v-if="verifying" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Verify Connection") }}
                </button>
                <button class="btn btn-normal" type="button" @click="openTestEmailModal">
                    {{ $t("Test SMTP") }}
                </button>
            </div>
        </form>

        <!-- Recipient prompt for the "Test SMTP" action -->
        <div ref="testEmailModal" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form @submit.prevent="submitTestEmail">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ $t("Test SMTP") }}</h5>
                            <button
                                type="button"
                                class="btn-close"
                                data-bs-dismiss="modal"
                                :aria-label="$t('Close')"
                            />
                        </div>
                        <div class="modal-body">
                            <label class="form-label" for="testEmailTo">{{ $t("sendTestEmailTo") }}</label>
                            <input
                                id="testEmailTo"
                                v-model="testEmailTo"
                                type="email"
                                class="form-control"
                                autocomplete="off"
                                required
                            />
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary" :disabled="testing">
                                <div v-if="testing" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Send") }}
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
import HiddenInput from "../../components/HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },
    data() {
        return {
            testing: false,
            verifying: false,
            testEmailTo: "",
            testEmailModal: null,
        };
    },
    computed: {
        // Shared settings object/save-flow with General.vue and the other
        // settings tabs, see Settings.vue's loadSettings/saveSettings.
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
    },

    mounted() {
        this.testEmailModal = new Modal(this.$refs.testEmailModal);
    },

    methods: {
        /**
         * Save the settings
         * @returns {void}
         */
        saveMail() {
            this.saveSettings();
        },

        /**
         * Open the recipient-prompt modal for the "Test SMTP" action,
         * pre-filled with the configured "From" address.
         * @returns {void}
         */
        openTestEmailModal() {
            this.testEmailTo = this.settings.mailFrom || "";
            this.testEmailModal.show();
        },

        /**
         * Send a test email to the chosen recipient using the current
         * (possibly unsaved) form values, so the SMTP configuration can be
         * confirmed before saving.
         * @returns {void}
         */
        submitTestEmail() {
            this.testing = true;
            this.$root.testMailSettings(this.settings, this.testEmailTo, (res) => {
                this.testing = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.testEmailModal.hide();
                }
            });
        },

        /**
         * Check SMTP connectivity/authentication only (no email sent) using
         * the current (possibly unsaved) form values.
         * @returns {void}
         */
        verifyConnection() {
            this.verifying = true;
            this.$root.verifyMailConnection(this.settings, (res) => {
                this.verifying = false;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>
