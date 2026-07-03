<template>
    <!-- Hostname -->
    <!-- TCP Port / Ping / DNS / Steam / MQTT / Radius / Tailscale Ping / SNMP / SMTP / SIP Options only -->
    <div
        v-if="
            model.type === 'port' ||
            model.type === 'ping' ||
            model.type === 'dns' ||
            model.type === 'steam' ||
            model.type === 'gamedig' ||
            model.type === 'mqtt' ||
            model.type === 'radius' ||
            model.type === 'tailscale-ping' ||
            model.type === 'smtp' ||
            model.type === 'snmp' ||
            model.type === 'sip-options'
        "
        class="my-3"
    >
        <label for="hostname" class="form-label">{{ $t("Hostname") }}</label>
        <input
            id="hostname"
            v-model="model.hostname"
            type="text"
            class="form-control"
            required
            data-testid="hostname-input"
        />
        <div v-if="model.type === 'mqtt'" class="form-text">
            <i18n-t tag="p" keypath="mqttHostnameTip">
                <template #hostnameFormat>
                    <code>[mqtt,mqtts,ws,wss]://hostname</code>
                </template>
            </i18n-t>
        </div>
    </div>

    <!-- Port -->
    <!-- For TCP Port / Steam / MQTT / Radius Type / SNMP / SIP Options -->
    <div
        v-if="
            model.type === 'port' ||
            model.type === 'steam' ||
            model.type === 'gamedig' ||
            model.type === 'mqtt' ||
            model.type === 'radius' ||
            model.type === 'smtp' ||
            model.type === 'snmp' ||
            model.type === 'sip-options' ||
            (model.type === 'globalping' && model.subtype === 'ping' && model.protocol === 'TCP')
        "
        class="my-3"
    >
        <label for="port" class="form-label">{{ $t("Port") }}</label>
        <input id="port" v-model="model.port" type="number" class="form-control" required min="0" max="65535" step="1" />
    </div>
</template>

<script>
export default {
    name: "TcpPortFields",

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
    },

    computed: {
        // Template reads/writes go through this computed alias (rather than
        // directly against the "monitor" prop) since the underlying object is
        // the same reference as the parent's reactive monitor: field mutations
        // (e.g. v-model="monitor.hostname") still propagate to the parent as
        // if the markup were still inline there.
        model() {
            return this.monitor;
        },
    },
};
</script>
