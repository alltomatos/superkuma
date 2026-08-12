<template>
    <div class="izapia-settings-page">
        <h1 class="mb-1">{{ $t("izapiaPageTitle") }}</h1>
        <p class="text-muted">{{ $t("izapiaPageSubtitle") }}</p>

        <ol v-if="!id" class="izapia-wizard-steps">
            <li v-for="step in 4" :key="step" :class="{ active: wizardStep === step, done: wizardStep > step }">
                {{ $t(wizardStepLabelKey(step)) }}
            </li>
        </ol>

        <div class="row">
            <div class="col-12 col-xl-8">
                <div v-if="showStep(1)" class="izapia-section">
                    <label class="form-label">{{ $t("izapiaNotificationName") }}</label>
                    <input v-model="notification.name" type="text" class="form-control mb-3" />

                    <h5 class="settings-subheading">{{ $t("izapiaApiKeyStep") }}</h5>

                    <div v-if="reusableConnections.length > 0" class="mb-3">
                        <label class="form-label">{{ $t("izapiaReuseConnection") }}</label>
                        <select class="form-select" @change="onReuseConnectionPicked">
                            <option value="">{{ $t("izapiaReuseConnectionPlaceholder") }}</option>
                            <option v-for="item in reusableConnections" :key="item.id" :value="item.id">
                                {{ item.label }}
                            </option>
                        </select>
                    </div>

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

                <div v-if="showStep(2)" class="izapia-section">
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

                <div v-if="showStep(3)" class="izapia-section">
                    <h5 class="settings-subheading">{{ $t("izapiaRecipientStep") }}</h5>

                    <div class="mb-3">
                        <div class="d-flex justify-content-between align-items-center">
                            <label class="form-label mb-0">{{ $t("izapiaGroupPicker") }}</label>
                            <button
                                type="button"
                                class="btn btn-sm btn-outline-primary text-nowrap"
                                :disabled="loadingGroups || !notification.izapiaSessionId"
                                @click="loadGroups"
                            >
                                {{ loadingGroups ? $t("Loading...") : $t("izapiaLoadGroups") }}
                            </button>
                        </div>
                        <div v-if="groupsError" class="form-text text-danger">{{ groupsError }}</div>
                        <div v-if="groups.length === 0" class="form-text">{{ $t("izapiaNoGroupsLoaded") }}</div>
                        <div v-for="group in groups" :key="group.id" class="form-check">
                            <input
                                :id="`izapia-group-${group.id}`"
                                class="form-check-input"
                                type="checkbox"
                                :checked="notification.izapiaGroupIds.includes(group.id)"
                                @change="toggleGroup(group.id)"
                            />
                            <label class="form-check-label" :for="`izapia-group-${group.id}`">{{ group.name }}</label>
                        </div>
                    </div>

                    <div class="mb-3">
                        <label class="form-label">{{ $t("izapiaContacts") }}</label>
                        <div class="izapia-contact-chips mb-2">
                            <span v-for="(contact, index) in notification.izapiaContacts" :key="contact" class="izapia-chip">
                                {{ contact }}
                                <a href="#" class="izapia-chip-remove" @click.prevent="removeContact(index)">&times;</a>
                            </span>
                        </div>
                        <div class="d-flex gap-2">
                            <input
                                v-model="newContact"
                                type="text"
                                class="form-control"
                                :placeholder="$t('izapiaContactPlaceholder', ['5511987654321'])"
                                @keydown.enter.prevent="addContact"
                            />
                            <button type="button" class="btn btn-outline-primary text-nowrap" @click="addContact">
                                {{ $t("izapiaAddContact") }}
                            </button>
                        </div>
                        <div class="form-text">{{ $t("izapiaContactsHelp") }}</div>
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

                <div v-if="showStep(4)" class="izapia-section">
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

                <div v-if="!id" class="izapia-section d-flex gap-2">
                    <button v-if="wizardStep > 1" type="button" class="btn btn-outline-secondary" @click="wizardStep--">
                        {{ $t("izapiaWizardBack") }}
                    </button>
                    <button
                        v-if="wizardStep < 4"
                        type="button"
                        class="btn btn-primary"
                        :disabled="!canProceedWizard"
                        @click="wizardStep++"
                    >
                        {{ $t("izapiaWizardNext") }}
                    </button>
                </div>

                <div v-if="id || wizardStep === 4" class="izapia-section d-flex gap-2">
                    <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                        {{ $t("Save") }}
                    </button>
                    <button type="button" class="btn btn-outline-secondary" :disabled="testing" @click="test">
                        {{ $t("Test") }}
                    </button>
                    <button
                        v-if="id"
                        type="button"
                        class="btn btn-outline-danger ms-auto"
                        :disabled="deleting"
                        @click="$refs.confirmDelete.show()"
                    >
                        {{ $t("Delete") }}
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

        <Confirm ref="confirmDelete" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="deleteNotification">
            {{ $t("deleteNotificationMsg") }}
        </Confirm>
    </div>
</template>

<script>
import HiddenInput from "../components/HiddenInput.vue";
import IzapiaPhonePreview from "../components/notifications/IzapiaPhonePreview.vue";
import Confirm from "../components/Confirm.vue";

const DEFAULT_TEMPLATE = "[{status}] {monitorName}\n{msg}";
const WIZARD_STEP_LABEL_KEYS = ["izapiaApiKeyStep", "izapiaConnectionStep", "izapiaRecipientStep", "izapiaTemplateStep"];

export default {
    components: {
        HiddenInput,
        IzapiaPhonePreview,
        Confirm,
    },

    data() {
        return {
            id: null,
            wizardStep: 1,
            newContact: "",
            notification: {
                name: "IZapia",
                type: "izapia",
                izapiaApiUrl: "https://api.izapia.com",
                izapiaApiKey: "",
                izapiaSessionId: "",
                izapiaGroupIds: [],
                izapiaContacts: [],
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
            deleting: false,
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

        /**
         * Other already-configured iZapia notifications, offered as a
         * shortcut to reuse their API key + connected session instead of
         * entering/pairing one from scratch. The API key is already sent to
         * the browser in cleartext for every notification in the list
         * (same exposure as editing any of them individually), so this is
         * purely a client-side convenience, no new backend surface.
         * @returns {{id: number, label: string, izapiaApiKey: string, izapiaSessionId: string}[]} Reusable connections.
         */
        reusableConnections() {
            return this.$root.notificationList
                .filter((n) => n.id !== this.id)
                .map((n) => {
                    try {
                        const cfg = JSON.parse(n.config);
                        return cfg.type === "izapia" && cfg.izapiaApiKey && cfg.izapiaSessionId
                            ? { id: n.id, label: `${n.name} (${cfg.izapiaSessionId})`, ...cfg }
                            : null;
                    } catch (e) {
                        return null;
                    }
                })
                .filter(Boolean);
        },

        canProceedWizard() {
            if (this.wizardStep === 1) {
                return !!this.notification.izapiaApiKey;
            }
            if (this.wizardStep === 2) {
                return !!this.notification.izapiaSessionId;
            }
            if (this.wizardStep === 3) {
                return this.notification.izapiaGroupIds.length > 0 || this.notification.izapiaContacts.length > 0;
            }
            return true;
        },
    },

    mounted() {
        this.id = this.$route.params.id ? parseInt(this.$route.params.id, 10) : null;
        this.loadTags();

        if (this.id) {
            const existing = this.$root.notificationList.find((n) => n.id === this.id);
            if (existing) {
                const cfg = JSON.parse(existing.config);
                // Migrate notifications saved before multi-recipient support
                // (single izapiaRecipient/izapiaRecipientType) into the new
                // array fields, transparently -- the next Save writes the
                // new shape.
                if (!cfg.izapiaGroupIds && !cfg.izapiaContacts && cfg.izapiaRecipient) {
                    if (cfg.izapiaRecipientType === "group") {
                        cfg.izapiaGroupIds = [cfg.izapiaRecipient];
                    } else {
                        cfg.izapiaContacts = [cfg.izapiaRecipient];
                    }
                }
                this.notification = { ...this.notification, ...cfg, applyExisting: false };
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
         * Whether wizard step `n`'s section should render -- always true
         * when editing an existing notification (everything shown at
         * once), or only for the current step while creating a new one.
         * @param {number} n Step number (1-4).
         * @returns {boolean} True if the section for step n should render.
         */
        showStep(n) {
            return !!this.id || this.wizardStep === n;
        },

        /**
         * i18n key for a wizard step's progress-indicator label.
         * @param {number} step Step number (1-4).
         * @returns {string} Translation key.
         */
        wizardStepLabelKey(step) {
            return WIZARD_STEP_LABEL_KEYS[step - 1];
        },

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
         * Toggles a group's membership in the selected-recipients list.
         * @param {string} groupId The WhatsApp group id.
         * @returns {void}
         */
        toggleGroup(groupId) {
            const idx = this.notification.izapiaGroupIds.indexOf(groupId);
            if (idx === -1) {
                this.notification.izapiaGroupIds.push(groupId);
            } else {
                this.notification.izapiaGroupIds.splice(idx, 1);
            }
        },

        /**
         * Adds the pending contact input to the recipients list.
         * @returns {void}
         */
        addContact() {
            const value = this.newContact.trim();
            if (value && !this.notification.izapiaContacts.includes(value)) {
                this.notification.izapiaContacts.push(value);
            }
            this.newContact = "";
        },

        /**
         * Removes a contact from the recipients list by index.
         * @param {number} index Index into notification.izapiaContacts.
         * @returns {void}
         */
        removeContact(index) {
            this.notification.izapiaContacts.splice(index, 1);
        },

        /**
         * Prefills the API key + already-connected session from another
         * saved iZapia notification, then jumps straight to the channels
         * step since the connection is already known-good.
         * @param {Event} event The select's native change event.
         * @returns {void}
         */
        onReuseConnectionPicked(event) {
            const picked = this.reusableConnections.find((item) => String(item.id) === event.target.value);
            if (!picked) {
                return;
            }
            this.notification.izapiaApiKey = picked.izapiaApiKey;
            this.notification.izapiaSessionId = picked.izapiaSessionId;
            this.refreshCurrentSession();
            this.wizardStep = 3;
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
         * Persists the choice immediately -- otherwise navigating away
         * without pressing "Save" silently discards the connection.
         * @returns {void}
         */
        onSessionPicked() {
            this.refreshCurrentSession();
            if (this.notification.izapiaSessionId) {
                this.save();
            }
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
                                this.save();
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

        /**
         * Deletes this notification and returns to the notification list.
         * @returns {void}
         */
        deleteNotification() {
            this.deleting = true;
            this.$root.getSocket().emit("deleteNotification", this.id, (res) => {
                this.deleting = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$router.push("/settings/notifications");
                }
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

.izapia-wizard-steps {
    display: flex;
    gap: 0.5rem;
    list-style: none;
    padding: 0;
    margin: 1rem 0 1.5rem;

    li {
        flex: 1;
        text-align: center;
        padding: 0.4rem 0.5rem;
        border-radius: 0.5rem;
        font-size: 0.8rem;
        background: rgba(0, 0, 0, 0.04);
        color: rgba(0, 0, 0, 0.5);

        .dark & {
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.5);
        }

        &.done {
            background: rgba(37, 211, 102, 0.15);
            color: #128c7e;
        }

        &.active {
            background: #25d366;
            color: #fff;
            font-weight: 600;
        }
    }
}

.izapia-contact-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
}

.izapia-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 1rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.85rem;

    .dark & {
        background: rgba(255, 255, 255, 0.1);
    }
}

.izapia-chip-remove {
    color: inherit;
    text-decoration: none;
    font-weight: bold;
}
</style>
