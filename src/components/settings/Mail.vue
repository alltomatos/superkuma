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

            <!-- Save / Test Buttons -->
            <div>
                <button class="btn btn-primary me-2" type="submit">
                    {{ $t("Save") }}
                </button>
                <button class="btn btn-normal" type="button" :disabled="testing" @click="testSmtp">
                    <div v-if="testing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Test SMTP") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>
import HiddenInput from "../../components/HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },
    data() {
        return {
            testing: false,
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

    methods: {
        /**
         * Save the settings
         * @returns {void}
         */
        saveMail() {
            this.saveSettings();
        },

        /**
         * Send a test email using the current (possibly unsaved) form values,
         * so the SMTP configuration can be confirmed before saving.
         * @returns {void}
         */
        testSmtp() {
            this.testing = true;
            this.$root.testMailSettings(this.settings, (res) => {
                this.testing = false;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>
