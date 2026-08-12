<template>
    <div class="izapia-settings-page">
        <h1 class="mb-1">{{ $t("izapiaPageTitle") }}</h1>
        <p class="text-muted">{{ $t("izapiaPageSubtitle") }}</p>

        <div class="row">
            <div class="col-12 col-xl-8">
                <!-- Step 1: API Key -->
                <div class="izapia-section">
                    <h5 class="settings-subheading">{{ $t("izapiaApiKeyStep") }}</h5>
                    <HiddenInput
                        id="izapia-api-key"
                        v-model="notification.izapiaApiKey"
                        autocomplete="new-password"
                    ></HiddenInput>
                    <div class="form-text mb-2">
                        {{ $t("izapiaNoAccountYet") }}
                        <a href="https://app.izapia.com/register" target="_blank" rel="noopener">
                            {{ $t("izapiaSignupCta") }}
                        </a>
                    </div>
                    <button
                        type="button"
                        class="btn btn-primary"
                        :disabled="!notification.izapiaApiKey || loadingSessions"
                        @click="connectExisting"
                    >
                        {{ loadingSessions ? $t("Loading...") : $t("izapiaConnectButton") }}
                    </button>
                    <div v-if="sessionsError" class="form-text text-danger">{{ sessionsError }}</div>
                </div>

                <!-- Step 2: Connection -->
                <div class="izapia-section">
                    <h5 class="settings-subheading">{{ $t("izapiaConnectionStep") }}</h5>

                    <div v-if="sessionStatusDisplay" class="izapia-session-status mb-3">
                        <strong>{{ $t("izapiaSessionStatus") }}:</strong>
                        {{ sessionStatusDisplay }}
                        <button
                            v-if="notification.izapiaSessionId"
                            type="button"
                            class="btn btn-sm btn-outline-danger ms-2"
                            @click="disconnectSession"
                        >
                            {{ $t("izapiaDisconnect") }}
                        </button>
                    </div>

                    <div v-if="showSessionPicker" class="mb-3">
                        <label class="form-label">{{ $t("izapiaSelectConnection") }}</label>
                        <select v-model="notification.izapiaSessionId" class="form-select" @change="onSessionPicked">
                            <option v-if="sessions.length === 0" value="" disabled>
                                {{ $t("izapiaNoSessionsLoaded") }}
                            </option>
                            <option v-for="s in sessions" :key="s.sid" :value="s.sid">
                                {{ s.name || s.sid }} ({{ s.status }})
                            </option>
                        </select>
                    </div>

                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :disabled="!notification.izapiaApiKey || creatingSession"
                        @click="createNewConnection"
                    >
                        {{ $t("izapiaCreateNewConnection") }}
                    </button>

                    <div v-if="qrError" class="form-text text-danger">
                        {{ qrError }}
                    </div>

                    <div v-if="qrImage" class="izapia-qr-box mb-3">
                        <p class="fw-bold">{{ $t("izapiaScanQrTitle") }}</p>
                        <p class="form-text">{{ $t("izapiaScanQrHelp") }}</p>
                        <img :src="`data:image/png;base64,${qrImage}`" alt="QR" class="izapia-qr-image" />
                        <p v-if="polling" class="form-text mt-2">{{ $t("izapiaWaitingForScan") }}</p>
                        <p v-else-if="pairedJustNow" class="text-success fw-bold mt-2">
                            {{ $t("izapiaSessionConnected") }}
                        </p>
                    </div>
                </div>

                <!-- Step 3: Recipient -->
                <div class="izapia-section">
                    <h5 class="settings-subheading">{{ $t("izapiaRecipientStep") }}</h5>

                    <div class="mb-3">
                        <label class="form-label">{{ $t("izapiaRecipientType") }}</label>
                        <select v-model="notification.izapiaRecipientType" class="form-select">
                            <option value="contact">{{ $t("izapiaRecipientTypeContact") }}</option>
                            <option value="group">{{ $t("izapiaRecipientTypeGroup") }}</option>
                        </select>
                    </div>

                    <div v-if="notification.izapiaRecipientType === 'group'" class="mb-3">
                        <label class="form-label">{{ $t("izapiaGroupPicker") }}</label>
                        <div class="d-flex gap-2">
                            <select
                                v-model="notification.izapiaRecipient"
                                class="form-select"
                                :disabled="groups.length === 0"
                            >
                                <option v-if="groups.length === 0" value="" disabled>
                                    {{ $t("izapiaNoGroupsLoaded") }}
                                </option>
                                <option v-for="group in groups" :key="group.id" :value="group.id">
                                    {{ group.name }}
                                </option>
                            </select>
                            <button
                                type="button"
                                class="btn btn-outline-primary text-nowrap"
                                :disabled="loadingGroups || !notification.izapiaSessionId"
                                @click="loadGroups"
                            >
                                {{ loadingGroups ? $t("Loading...") : $t("izapiaLoadGroups") }}
                            </button>
                        </div>
                        <div v-if="groupsError" class="form-text text-danger">{{ groupsError }}</div>
                    </div>

                    <div class="mb-3">
                        <label class="form-label">{{ $t("izapiaRecipient") }}</label>
                        <input v-model="notification.izapiaRecipient" type="text" class="form-control" />
                        <div class="form-text">
                            {{
                                notification.izapiaRecipientType === "group"
                                    ? $t("izapiaRecipientHelpGroup", ["123456789012345678"])
                                    : $t("izapiaRecipientHelpContact", ["5511987654321"])
                            }}
                        </div>
                    </div>

                    <div class="mb-3">
                        <label class="form-label">{{ $t("izapiaAutoAttachTag") }}</label>
                        <select v-model="notification.izapiaAutoAttachTagId" class="form-select">
                            <option :value="null">{{ $t("izapiaNoAutoAttachTag") }}</option>
                            <option v-for="tag in tags" :key="tag.id" :value="tag.id">
                                {{ tag.name }}
                            </option>
                        </select>
                    </div>
                </div>

                <!-- Step 4: Template -->
                <div class="izapia-section">
                    <h5 class="settings-subheading">{{ $t("izapiaTemplateStep") }}</h5>

                    <div class="form-check form-switch mb-3">
                        <input
                            id="izapia-enable-interactive"
                            v-model="notification.izapiaEnableInteractive"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label for="izapia-enable-interactive" class="form-check-label">
                            {{ $t("izapiaEnableInteractive") }}
                        </label>
                    </div>

                    <div v-if="notification.izapiaEnableInteractive" class="mb-3">
                        <label class="form-label">{{ $t("izapiaWebhookSecret") }}</label>
                        <HiddenInput
                            v-model="notification.izapiaWebhookSecret"
                            autocomplete="new-password"
                        ></HiddenInput>
                    </div>

                    <div class="mb-3">
                        <label class="form-label">{{ $t("izapiaTemplateBody") }}</label>
                        <textarea v-model="notification.izapiaTemplateBody" class="form-control" rows="4"></textarea>
                        <div class="form-text">
                            {{ $t("izapiaTemplateBodyHelp", ["{monitorName}", "{status}", "{msg}"]) }}
                        </div>
                    </div>
                </div>

                <div class="izapia-section d-flex gap-2">
                    <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                        {{ $t("Save") }}
                    </button>
                    <button type="button" class="btn btn-outline-secondary" :disabled="testing" @click="test">
                        {{ $t("Test") }}
                    </button>
                </div>
            </div>

            <div class="col-12 col-xl-4">
                <div class="izapia-section izapia-preview-section">
                    <h5 class="settings-subheading">{{ $t("izapiaTemplatePreview") }}</h5>
                    <p class="form-text">{{ $t("izapiaTemplatePreviewHelp") }}</p>
                    <IzapiaPhonePreview
                        :template="notification.izapiaTemplateBody"
                        :interactive="notification.izapiaEnableInteractive"
                    />
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import HiddenInput from "../components/HiddenInput.vue";
import IzapiaPhonePreview from "../components/notifications/IzapiaPhonePreview.vue";

const DEFAULT_TEMPLATE = "[{status}] {monitorName}\n{msg}";

export default {
    components: {
        HiddenInput,
        IzapiaPhonePreview,
    },

    data() {
        return {
            id: null,
            notification: {
                name: "IZapia",
                type: "izapia",
                izapiaApiUrl: "https://api.izapia.com",
                izapiaApiKey: "",
                izapiaSessionId: "",
                izapiaRecipientType: "contact",
                izapiaRecipient: "",
                izapiaAutoAttachTagId: null,
                izapiaEnableInteractive: false,
                izapiaWebhookSecret: "",
                izapiaTemplateBody: DEFAULT_TEMPLATE,
                isDefault: false,
                applyExisting: false,
            },

            tags: [],
            groups: [],
            loadingGroups: false,
            groupsError: null,

            sessions: [],
            loadingSessions: false,
            sessionsError: null,
            showSessionPicker: false,

            creatingSession: false,
            qrImage: null,
            qrError: null,
            polling: false,
            pairedJustNow: false,
            pollTimer: null,

            currentSession: null,

            saving: false,
            testing: false,
        };
    },

    computed: {
        sessionStatusDisplay() {
            if (!this.currentSession) {
                return null;
            }
            const connected = this.currentSession.status === "connected";
            return connected ? this.$t("izapiaSessionStatusConnected") : this.$t("izapiaSessionStatusDisconnected");
        },
    },

    mounted() {
        this.id = this.$route.params.id ? parseInt(this.$route.params.id, 10) : null;
        this.loadTags();

        if (this.id) {
            const existing = this.$root.notificationList.find((n) => n.id === this.id);
            if (existing) {
                this.notification = { ...this.notification, ...JSON.parse(existing.config), applyExisting: false };
            }
        }

        if (this.notification.izapiaSessionId && this.notification.izapiaApiKey) {
            this.refreshCurrentSession();
        }
    },

    beforeUnmount() {
        this.stopPolling();
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
         * Fetch the real WhatsApp groups visible to the currently selected session.
         * @returns {void}
         */
        loadGroups() {
            this.groupsError = null;
            this.loadingGroups = true;
            this.$root.getSocket().emit(
                "izapiaListGroups",
                {
                    izapiaApiUrl: this.notification.izapiaApiUrl,
                    izapiaApiKey: this.notification.izapiaApiKey,
                    izapiaSessionId: this.notification.izapiaSessionId,
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

        /**
         * Loads the tenant's existing sessions so the user can pick one
         * instead of creating a brand new connection.
         * @returns {void}
         */
        connectExisting() {
            this.sessionsError = null;
            this.loadingSessions = true;
            this.showSessionPicker = true;
            this.qrImage = null;
            this.$root
                .getSocket()
                .emit("izapiaListSessions", { izapiaApiKey: this.notification.izapiaApiKey }, (res) => {
                    this.loadingSessions = false;
                    if (res.ok) {
                        this.sessions = res.sessions;
                        // A native <select> visually shows the first option by
                        // default even though v-model's underlying value is
                        // still "" until the user manually changes it -- so
                        // without this, the dropdown LOOKS like a session is
                        // picked (misleading) while notification.izapiaSessionId
                        // stays empty and "Load groups" stays disabled.
                        if (!this.notification.izapiaSessionId && this.sessions.length > 0) {
                            this.notification.izapiaSessionId = this.sessions[0].sid;
                            this.onSessionPicked();
                        }
                    } else {
                        this.sessionsError = res.msg;
                    }
                });
        },

        /**
         * Reacts to picking a session from the "connect existing" dropdown.
         * @returns {void}
         */
        onSessionPicked() {
            this.refreshCurrentSession();
        },

        /**
         * Creates a brand new WhatsApp session and immediately requests its
         * pairing QR code, then starts polling until it connects.
         * @returns {void}
         */
        createNewConnection() {
            this.qrError = null;
            this.creatingSession = true;
            this.showSessionPicker = false;
            this.pairedJustNow = false;
            this.$root
                .getSocket()
                .emit("izapiaCreateSession", { izapiaApiKey: this.notification.izapiaApiKey }, undefined, (res) => {
                    this.creatingSession = false;
                    if (!res.ok) {
                        this.qrError = res.msg;
                        return;
                    }
                    this.notification.izapiaSessionId = res.session.sid;
                    this.requestQr();
                });
        },

        /**
         * Requests a pairing QR code for the current session and starts polling.
         * @returns {void}
         */
        requestQr() {
            this.qrError = null;
            this.$root
                .getSocket()
                .emit(
                    "izapiaRequestPairingQr",
                    { izapiaApiKey: this.notification.izapiaApiKey },
                    this.notification.izapiaSessionId,
                    (res) => {
                        if (!res.ok) {
                            this.qrError = res.msg;
                            return;
                        }
                        this.qrImage = res.pairing.qr_png_base64;
                        this.startPolling();
                    }
                );
        },

        /**
         * Polls session status every 3s (2 minute timeout) until it reports
         * connected, then stops and refreshes the displayed status.
         * @returns {void}
         */
        startPolling() {
            this.stopPolling();
            this.polling = true;
            let elapsed = 0;
            this.pollTimer = setInterval(() => {
                elapsed += 3000;
                this.$root
                    .getSocket()
                    .emit(
                        "izapiaGetSessionDetails",
                        { izapiaApiKey: this.notification.izapiaApiKey },
                        this.notification.izapiaSessionId,
                        (res) => {
                            if (res.ok && res.session?.status === "connected") {
                                this.currentSession = res.session;
                                this.pairedJustNow = true;
                                this.stopPolling();
                            } else if (elapsed >= 120000) {
                                this.stopPolling();
                            }
                        }
                    );
            }, 3000);
        },

        /**
         * Stops the QR pairing status poll, if running.
         * @returns {void}
         */
        stopPolling() {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.polling = false;
        },

        /**
         * Refreshes the currently configured session's status.
         * @returns {void}
         */
        refreshCurrentSession() {
            this.$root
                .getSocket()
                .emit(
                    "izapiaGetSessionDetails",
                    { izapiaApiKey: this.notification.izapiaApiKey },
                    this.notification.izapiaSessionId,
                    (res) => {
                        if (res.ok) {
                            this.currentSession = res.session;
                        }
                    }
                );
        },

        /**
         * Soft-disconnects the current session.
         * @returns {void}
         */
        disconnectSession() {
            this.$root
                .getSocket()
                .emit(
                    "izapiaLogoutSession",
                    { izapiaApiKey: this.notification.izapiaApiKey },
                    this.notification.izapiaSessionId,
                    (res) => {
                        if (res.ok) {
                            this.refreshCurrentSession();
                        }
                    }
                );
        },

        /**
         * Persists the notification via the same generic socket contract the
         * shared NotificationDialog uses.
         * @returns {void}
         */
        save() {
            this.saving = true;
            this.$root.getSocket().emit("addNotification", this.notification, this.id, (res) => {
                this.saving = false;
                this.$root.toastRes(res);
                if (res.ok && !this.id) {
                    this.id = res.id;
                    this.$router.replace(`/settings/notifications/izapia/${res.id}`);
                }
            });
        },

        /**
         * Sends a test notification with the current (possibly unsaved) config.
         * @returns {void}
         */
        test() {
            this.testing = true;
            this.$root.getSocket().emit("testNotification", this.notification, (res) => {
                this.testing = false;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.izapia-settings-page {
    padding: 1rem 0 3rem;
}

.izapia-section {
    margin-bottom: 2rem;
}

.izapia-session-status {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: rgba(0, 0, 0, 0.03);

    .dark & {
        background: rgba(255, 255, 255, 0.06);
    }
}

.izapia-qr-box {
    text-align: center;
}

.izapia-qr-image {
    width: 220px;
    height: 220px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 0.5rem;
}

.izapia-preview-section {
    position: sticky;
    top: 1rem;
}
</style>
