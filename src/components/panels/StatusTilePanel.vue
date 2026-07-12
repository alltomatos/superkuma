<template>
    <div class="status-tile-panel">
        <font-awesome-icon icon="circle" :class="statusClass" />
        <div class="status-tile-name">{{ monitorName }}</div>
    </div>
</template>

<script>
/**
 * A single colored status dot + monitor name (ADR-0016 "status_tile" panel
 * kind, unchanged by ADR-0017 beyond becoming a standalone component so the
 * builder can render it via the same dynamic-component dispatch as the
 * richer panel kinds).
 */
export default {
    props: {
        /** The monitor id this tile reflects */
        monitorId: {
            type: Number,
            required: true,
        },
        /** Display name (falls back to a lookup if omitted) */
        monitorName: {
            type: String,
            default: "",
        },
        /**
         * Optional status override (0/1/2/3), for contexts with no
         * $root.lastHeartbeatList to read from (the public dashboard view).
         * When omitted, status is derived from $root as usual.
         */
        publicStatus: {
            type: Number,
            default: null,
        },
    },
    computed: {
        statusClass() {
            if (this.publicStatus !== null) {
                return this.classForStatus(this.publicStatus);
            }
            const monitor = this.$root.monitorList[this.monitorId];
            if (monitor && !monitor.active) {
                return "status-paused";
            }
            const beat = this.$root.lastHeartbeatList[this.monitorId];
            if (!beat) {
                return "status-pending";
            }
            return this.classForStatus(beat.status);
        },
    },
    methods: {
        /**
         * Map a heartbeat status code to its CSS class.
         * @param {number} status A heartbeat status (0/1/2/3).
         * @returns {string} The CSS class name.
         */
        classForStatus(status) {
            switch (status) {
                case 1:
                    return "status-up";
                case 0:
                    return "status-down";
                default:
                    return "status-pending";
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.status-tile-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
}

.status-tile-name {
    font-size: 0.85rem;
    margin-top: 6px;
}

.status-up {
    color: #5cdd8b;
}

.status-down {
    color: #dc3545;
}

.status-pending {
    color: #f8a306;
}

.status-paused {
    color: #808080;
}
</style>
