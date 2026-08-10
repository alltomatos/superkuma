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

    <div v-if="$parent.notification.izapiaRecipientType === 'group'" class="mb-3">
        <label for="izapia-group-picker" class="form-label">{{ $t("izapiaGroupPicker") }}</label>
        <div class="d-flex gap-2">
            <select
                id="izapia-group-picker"
                v-model="$parent.notification.izapiaRecipient"
                class="form-select"
                :disabled="groups.length === 0"
            >
                <option v-if="groups.length === 0" value="" disabled>{{ $t("izapiaNoGroupsLoaded") }}</option>
                <option v-for="group in groups" :key="group.id" :value="group.id">
                    {{ group.name }}
                </option>
            </select>
            <button
                type="button"
                class="btn btn-outline-primary text-nowrap"
                :disabled="loadingGroups"
                @click="loadGroups"
            >
                {{ loadingGroups ? $t("Loading...") : $t("izapiaLoadGroups") }}
            </button>
        </div>
        <div v-if="groupsError" class="form-text text-danger">{{ groupsError }}</div>
        <div class="form-text">{{ $t("izapiaGroupPickerHelp") }}</div>
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

    <div class="mb-3">
        <label for="izapia-auto-attach-tag" class="form-label">{{ $t("izapiaAutoAttachTag") }}</label>
        <select id="izapia-auto-attach-tag" v-model="$parent.notification.izapiaAutoAttachTagId" class="form-select">
            <option :value="null">{{ $t("izapiaNoAutoAttachTag") }}</option>
            <option v-for="tag in tags" :key="tag.id" :value="tag.id">
                {{ tag.name }}
            </option>
        </select>
        <div class="form-text">{{ $t("izapiaAutoAttachTagHelp") }}</div>
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

    data() {
        return {
            groups: [],
            loadingGroups: false,
            groupsError: null,
            tags: [],
        };
    },

    mounted() {
        this.loadTags();
    },

    methods: {
        /**
         * Fetch the tenant's tag list for the "auto-attach" dropdown.
         * @returns {void}
         */
        loadTags() {
            this.$root.getSocket().emit("getTags", (res) => {
                if (res.ok) {
                    this.tags = res.tags;
                }
            });
        },

        /**
         * Fetch the real WhatsApp groups visible to the session entered in
         * this (possibly unsaved) form, so the user can pick one instead of
         * pasting a raw group JID.
         * @returns {void}
         */
        loadGroups() {
            this.groupsError = null;
            this.loadingGroups = true;
            this.$root.getSocket().emit(
                "izapiaListGroups",
                {
                    izapiaApiUrl: this.$parent.notification.izapiaApiUrl,
                    izapiaApiKey: this.$parent.notification.izapiaApiKey,
                    izapiaSessionId: this.$parent.notification.izapiaSessionId,
                },
                (res) => {
                    this.loadingGroups = false;
                    if (res.ok) {
                        this.groups = res.groups;
                    } else {
                        this.groupsError = res.msg;
                    }
                }
            );
        },
    },
};
</script>
