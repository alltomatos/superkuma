<template>
    <!-- Push URL -->
    <div v-if="monitor.type === 'push'" class="my-3">
        <label for="push-url" class="form-label">{{ $t("PushUrl") }}</label>
        <CopyableInput id="push-url" v-model="pushURL" type="url" disabled="disabled" />
        <div class="form-text">
            {{ $t("needPushEvery", [monitor.interval]) }}
            <br />
            {{ $t("pushOptionalParams", ["status, msg, ping"]) }}
        </div>
        <button class="btn btn-primary" type="button" @click="resetToken">
            {{ $t("Reset Token") }}
        </button>
    </div>
</template>

<script>
import CopyableInput from "../CopyableInput.vue";
import { genSecret } from "../../util.ts";

const pushTokenLength = 32;

export default {
    name: "PushUrlField",

    components: {
        CopyableInput,
    },

    props: {
        /**
         * The monitor object being edited. Passed by reference (same reactive
         * object as the parent's), so mutations to its fields propagate back
         * to the parent automatically.
         */
        monitor: {
            type: Object,
            required: true,
        },

        /**
         * Base URL used to build the full push URL.
         */
        baseUrl: {
            type: String,
            required: true,
        },
    },

    computed: {
        pushURL() {
            return this.baseUrl + "/api/push/" + this.monitor.pushToken + "?status=up&msg=OK&ping=";
        },

        // Alias used for mutation only (see resetToken), since the underlying
        // object is the same reference as the parent's reactive monitor:
        // mutating its fields still propagates to the parent as if the markup
        // were still inline there.
        model() {
            return this.monitor;
        },
    },

    methods: {
        resetToken() {
            this.model.pushToken = genSecret(pushTokenLength);
        },
    },
};
</script>
