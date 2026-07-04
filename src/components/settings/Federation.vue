<template>
    <div>
        <!-- Master side: manage registered remote (agent) instances -->
        <h5>{{ $t("Remote Instances") }}</h5>
        <p class="form-text">{{ $t("remoteInstancesDescription") }}</p>

        <div class="add-btn">
            <button class="btn btn-primary me-2" type="button" @click="$refs.remoteInstanceDialog.show()">
                <font-awesome-icon icon="plus" />
                {{ $t("Add Remote Instance") }}
            </button>
        </div>

        <div>
            <span
                v-if="remoteInstanceList.length === 0"
                class="d-flex align-items-center justify-content-center my-3"
            >
                {{ $t("No Remote Instances") }}
            </span>

            <div v-for="item in remoteInstanceList" :key="item.id" class="item" :class="{ active: item.active, inactive: !item.active }">
                <div class="left-part">
                    <div class="circle"></div>
                    <div class="info">
                        <div class="title">{{ item.name }}</div>
                        <div class="status">{{ item.instanceId }}</div>
                        <div class="date">
                            {{ $t("Last Seen") }}:
                            {{ item.lastSeen || $t("Never") }}
                        </div>
                    </div>
                </div>

                <div class="buttons">
                    <div class="btn-group" role="group">
                        <button class="btn btn-danger" @click="deleteDialog(item.id)">
                            <font-awesome-icon icon="trash" />
                            {{ $t("Delete") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <Confirm ref="confirmDelete" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="deleteRemoteInstance">
            {{ $t("deleteRemoteInstanceMsg") }}
        </Confirm>

        <RemoteInstanceDialog ref="remoteInstanceDialog" />

        <hr class="my-4" />

        <!-- Agent side: this instance forwarding its own heartbeats to a Master -->
        <h5>{{ $t("Agent Configuration") }}</h5>
        <p class="form-text">{{ $t("agentConfigurationDescription") }}</p>

        <form @submit.prevent="saveGeneral">
            <!-- Master URL -->
            <div class="mb-4">
                <label class="form-label" for="federationMasterUrl">
                    {{ $t("Master URL") }}
                </label>
                <input
                    id="federationMasterUrl"
                    v-model="settings.federationMasterUrl"
                    class="form-control"
                    placeholder="https://"
                    autocomplete="new-password"
                />
            </div>

            <!-- Instance ID -->
            <div class="mb-4">
                <label class="form-label" for="federationInstanceId">
                    {{ $t("Instance ID") }}
                </label>
                <input
                    id="federationInstanceId"
                    v-model="settings.federationInstanceId"
                    class="form-control"
                    autocomplete="new-password"
                />
                <div class="form-text">
                    {{ $t("federationInstanceIdDescription") }}
                </div>
            </div>

            <!-- Token -->
            <div class="mb-4">
                <label class="form-label" for="federationToken">
                    {{ $t("Token") }}
                </label>
                <HiddenInput id="federationToken" v-model="settings.federationToken" autocomplete="new-password" />
                <div class="form-text">
                    {{ $t("federationTokenDescription") }}
                </div>
            </div>

            <!-- Save Button -->
            <div>
                <button class="btn btn-primary" type="submit">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>
import HiddenInput from "../../components/HiddenInput.vue";
import RemoteInstanceDialog from "../../components/RemoteInstanceDialog.vue";
import Confirm from "../Confirm.vue";

export default {
    components: {
        HiddenInput,
        RemoteInstanceDialog,
        Confirm,
    },
    data() {
        return {
            selectedRemoteInstanceID: null,
        };
    },
    computed: {
        remoteInstanceList() {
            return this.$root.remoteInstanceList;
        },
        // Shared settings object/save-flow with General.vue and the other
        // settings tabs, so saving here always round-trips the FULL current
        // settings state (see Settings.vue's loadSettings/saveSettings) and
        // never clobbers unrelated settings saved elsewhere.
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
    },

    mounted() {
        this.$root.getRemoteInstanceList();
    },

    methods: {
        /**
         * Save the settings
         * @returns {void}
         */
        saveGeneral() {
            this.saveSettings();
        },

        /**
         * Show dialog to confirm deletion
         * @param {number} remoteInstanceID ID of remote instance that is being deleted
         * @returns {void}
         */
        deleteDialog(remoteInstanceID) {
            this.selectedRemoteInstanceID = remoteInstanceID;
            this.$refs.confirmDelete.show();
        },

        /**
         * Delete a remote instance
         * @returns {void}
         */
        deleteRemoteInstance() {
            this.$root.deleteRemoteInstance(this.selectedRemoteInstanceID, (res) => {
                this.$root.toastRes(res);
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.add-btn {
    padding-top: 10px;
    padding-bottom: 20px;
}

.item {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    border-radius: 10px;
    transition: all ease-in-out 0.15s;
    justify-content: space-between;
    padding: 10px;
    min-height: 90px;
    margin-bottom: 5px;

    &:hover {
        background-color: $highlight-white;
    }

    &.active {
        .circle {
            background-color: $primary;
        }
    }

    &.inactive {
        .circle {
            background-color: $danger;
        }
    }

    .left-part {
        display: flex;
        gap: 12px;
        align-items: center;

        .circle {
            width: 25px;
            height: 25px;
            border-radius: 50rem;
        }

        .info {
            .title {
                font-weight: bold;
                font-size: 20px;
            }

            .status {
                font-size: 14px;
            }
        }
    }

    .buttons {
        display: flex;
        gap: 8px;
        flex-direction: row-reverse;
    }
}

.date {
    margin-top: 5px;
    display: block;
    font-size: 14px;
    background-color: rgba(255, 255, 255, 0.5);
    border-radius: 20px;
    padding: 0 10px;
    width: fit-content;

    .dark & {
        color: white;
        background-color: rgba(255, 255, 255, 0.1);
    }
}

.dark {
    .item {
        &:hover {
            background-color: $dark-bg2;
        }
    }
}
</style>
