<template>
    <div class="mb-3">
        <label for="izapia-api-url" class="form-label">{{ $t("API URL") }}</label>
        <input
            id="izapia-api-url"
            v-model="$parent.notification.izapiaApiUrl"
            placeholder="https://api.izapia.com"
            type="text"
            class="form-control"
        />
    </div>

    <div class="mb-3">
        <label for="izapia-api-key" class="form-label">{{ $t("Token") }}</label>
        <HiddenInput
            id="izapia-api-key"
            v-model="$parent.notification.izapiaApiKey"
            :required="true"
            autocomplete="new-password"
        ></HiddenInput>
    </div>

    <div class="mb-3">
        <label for="izapia-session-id" class="form-label">{{ $t("izapiaSessionId") }}</label>
        <input
            id="izapia-session-id"
            v-model="$parent.notification.izapiaSessionId"
            type="text"
            class="form-control"
            required
        />
        <div class="form-text">{{ $t("izapiaSessionIdHelp") }}</div>
    </div>

    <div class="mb-3">
        <label for="izapia-recipient-type" class="form-label">{{ $t("izapiaRecipientType") }}</label>
        <select id="izapia-recipient-type" v-model="$parent.notification.izapiaRecipientType" class="form-select">
            <option value="contact">{{ $t("izapiaRecipientTypeContact") }}</option>
            <option value="group">{{ $t("izapiaRecipientTypeGroup") }}</option>
        </select>
    </div>

    <div class="mb-3">
        <label for="izapia-recipient" class="form-label">{{ $t("izapiaRecipient") }}</label>
        <input
            id="izapia-recipient"
            v-model="$parent.notification.izapiaRecipient"
            type="text"
            class="form-control"
            required
        />
        <div class="form-text">
            {{
                $parent.notification.izapiaRecipientType === "group"
                    ? $t("izapiaRecipientHelpGroup", ["123456789012345678"])
                    : $t("izapiaRecipientHelpContact", ["5511987654321"])
            }}
        </div>
    </div>

    <div class="form-check form-switch mb-3">
        <input
            id="izapia-enable-interactive"
            v-model="$parent.notification.izapiaEnableInteractive"
            class="form-check-input"
            type="checkbox"
        />
        <label for="izapia-enable-interactive" class="form-check-label">{{ $t("izapiaEnableInteractive") }}</label>
        <div class="form-text">{{ $t("izapiaEnableInteractiveHelp") }}</div>
    </div>

    <div v-if="$parent.notification.izapiaEnableInteractive" class="mb-3">
        <label for="izapia-webhook-secret" class="form-label">{{ $t("izapiaWebhookSecret") }}</label>
        <HiddenInput
            id="izapia-webhook-secret"
            v-model="$parent.notification.izapiaWebhookSecret"
            :required="$parent.notification.izapiaEnableInteractive"
            autocomplete="new-password"
        ></HiddenInput>
        <div class="form-text">{{ $t("izapiaWebhookSecretHelp") }}</div>
    </div>

    <i18n-t tag="div" keypath="More info on:" class="mb-3 form-text">
        <a href="https://api.izapia.com/openapi.json" target="_blank">https://api.izapia.com/openapi.json</a>
    </i18n-t>
</template>
<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },
};
</script>
