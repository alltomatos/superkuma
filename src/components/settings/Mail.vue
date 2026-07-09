<template>
    <div>
        <h5>{{ $t("Mail") }}</h5>
        <p class="form-text">{{ $t("mailSettingsDescription") }}</p>

        <form @submit.prevent="saveMail">
            <!-- Provider preset -->
            <div class="mb-4">
                <label class="form-label">{{ $t("mailProvider") }}</label>
                <div class="btn-group d-block">
                    <button
                        type="button"
                        class="btn"
                        :class="mailProvider === 'manual' ? 'btn-primary' : 'btn-normal'"
                        @click="selectManualProvider"
                    >
                        {{ $t("mailProviderManual") }}
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :class="mailProvider === 'resend' ? 'btn-primary' : 'btn-normal'"
                        @click="selectResendProvider"
                    >
                        {{ $t("mailProviderResend") }}
                    </button>
                </div>
                <div v-if="mailProvider === 'resend'" class="form-text">{{ $t("mailProviderResendDescription") }}</div>
            </div>

            <!-- Host -->
            <div class="mb-4">
                <label class="form-label" for="mailHost">{{ $t("SMTP Host") }}</label>
                <input
                    id="mailHost"
                    v-model="settings.mailHost"
                    class="form-control"
                    autocomplete="new-password"
                    :disabled="mailProvider === 'resend'"
                />
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
                    :disabled="mailProvider === 'resend'"
                />
            </div>

            <!-- Secure -->
            <div class="mb-4 form-check form-switch">
                <input
                    id="mailSecure"
                    v-model="settings.mailSecure"
                    class="form-check-input"
                    type="checkbox"
                    :disabled="mailProvider === 'resend'"
                />
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
                    :disabled="mailProvider === 'resend'"
                />
            </div>

            <!-- Password -->
            <div class="mb-4">
                <label class="form-label" for="mailPassword">{{
                    mailProvider === "resend" ? $t("mailProviderResendApiKey") : $t("Password")
                }}</label>
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

                            <div class="form-check form-switch mt-3">
                                <input
                                    id="testEmailDebug"
                                    v-model="testEmailDebug"
                                    class="form-check-input"
                                    type="checkbox"
                                />
                                <label class="form-check-label" for="testEmailDebug">
                                    {{ $t("smtpDebugLog") }}
                                </label>
                                <div class="form-text">{{ $t("smtpDebugLogDescription") }}</div>
                            </div>

                            <div v-if="testLogLines.length > 0" class="mt-3">
                                <label class="form-label">{{ $t("smtpDebugLogTitle") }}</label>
                                <pre class="smtp-debug-log">{{ testLogLines.join("\n") }}</pre>
                            </div>
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

// Resend's SMTP relay (https://resend.com/docs/send-with-smtp) accepts the
// literal username "resend" and the account's API key as the password --
// these three plus the port/TLS mode are fixed, only the API key varies.
const RESEND_SMTP_HOST = "smtp.resend.com";
const RESEND_SMTP_PORT = 465;

export default {
    components: {
        HiddenInput,
    },
    data() {
        return {
            testing: false,
            verifying: false,
            testEmailTo: "",
            testEmailDebug: false,
            testLogLines: [],
            testEmailModal: null,
            mailProvider: "manual",
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
        this.mailProvider = this.settings.mailHost === RESEND_SMTP_HOST ? "resend" : "manual";
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
         * Switch to the Resend SMTP preset, filling in its fixed host/port/
         * TLS/username so only the API key (password) and "From" address are
         * left for the admin to provide.
         * @returns {void}
         */
        selectResendProvider() {
            this.mailProvider = "resend";
            this.settings.mailHost = RESEND_SMTP_HOST;
            this.settings.mailPort = RESEND_SMTP_PORT;
            this.settings.mailSecure = true;
            this.settings.mailUsername = "resend";
        },

        /**
         * Switch back to free-form SMTP settings, unlocking the host/port/
         * TLS/username fields without changing their current values.
         * @returns {void}
         */
        selectManualProvider() {
            this.mailProvider = "manual";
        },

        /**
         * Open the recipient-prompt modal for the "Test SMTP" action,
         * pre-filled with the configured "From" address.
         * @returns {void}
         */
        openTestEmailModal() {
            this.testEmailTo = this.settings.mailFrom || "";
            this.testEmailDebug = false;
            this.testLogLines = [];
            this.testEmailModal.show();
        },

        /**
         * Send a test email to the chosen recipient using the current
         * (possibly unsaved) form values, so the SMTP configuration can be
         * confirmed before saving. When the debug toggle is on, the raw SMTP
         * transcript is shown in the modal instead of auto-closing on
         * success, since the whole point is to inspect it.
         * @returns {void}
         */
        submitTestEmail() {
            this.testing = true;
            this.testLogLines = [];
            this.$root.testMailSettings(this.settings, this.testEmailTo, this.testEmailDebug, (res) => {
                this.testing = false;
                this.$root.toastRes(res);
                this.testLogLines = res.logLines || [];
                if (res.ok && !this.testEmailDebug) {
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

<style lang="scss" scoped>
.smtp-debug-log {
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 0.8rem;
    background-color: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
    border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 0.25rem;
    padding: 0.5rem;
    margin-bottom: 0;
}
</style>
