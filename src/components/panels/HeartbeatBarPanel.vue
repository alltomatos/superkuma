<template>
    <div class="heartbeat-bar-panel">
        <div class="panel-meta">
            <div class="monitor-info">
                <span :class="statusClass" class="status-indicator"></span>
                <span class="monitor-name" :title="displayName">{{ displayName }}</span>
            </div>
            <div v-if="uptime !== null" class="uptime-badge" :class="uptimeClass">
                {{ uptime }}%
            </div>
        </div>
        <div class="bar-container">
            <div class="beats-wrapper">
                <div
                    v-for="(beat, index) in displayBeats"
                    :key="index"
                    class="beat-pill"
                    :class="beatClass(beat)"
                    :title="beatTitle(beat)"
                ></div>
            </div>
        </div>
    </div>
</template>

<script>
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

const DOWN = 0;
const UP = 1;
const PENDING = 2;
const MAINTENANCE = 3;

export default {
    props: {
        monitorId: {
            type: Number,
            required: true,
        },
        monitorName: {
            type: String,
            default: "",
        },
        publicStatus: {
            type: Number,
            default: null,
        },
        heartbeatList: {
            type: Array,
            default: null,
        },
    },
    computed: {
        displayName() {
            return this.monitorName || this.$root.monitorList?.[this.monitorId]?.name || "";
        },
        beats() {
            if (this.heartbeatList && this.heartbeatList.length > 0) {
                return this.heartbeatList;
            }
            if (this.$root.heartbeatList?.[this.monitorId]) {
                return this.$root.heartbeatList[this.monitorId];
            }
            return [];
        },
        displayBeats() {
            const list = this.beats || [];
            const count = 30;
            if (list.length >= count) {
                return list.slice(-count);
            }
            const placeholders = new Array(count - list.length).fill(null);
            return placeholders.concat(list);
        },
        currentStatus() {
            if (this.publicStatus !== null) {
                return this.publicStatus;
            }
            const monitor = this.$root.monitorList?.[this.monitorId];
            if (monitor && !monitor.active) {
                return "paused";
            }
            const lastBeat = this.beats[this.beats.length - 1] || this.$root.lastHeartbeatList?.[this.monitorId];
            if (!lastBeat) {
                return PENDING;
            }
            return lastBeat.status;
        },
        statusClass() {
            if (this.currentStatus === "paused") {
                return "status-paused";
            }
            switch (Number(this.currentStatus)) {
                case UP:
                    return "status-up";
                case DOWN:
                    return "status-down";
                case MAINTENANCE:
                    return "status-maintenance";
                default:
                    return "status-pending";
            }
        },
        uptime() {
            const valid = this.beats.filter((b) => b && b.status !== null);
            if (valid.length === 0) {
                return null;
            }
            const upCount = valid.filter((b) => Number(b.status) === UP).length;
            return Math.round((upCount / valid.length) * 100);
        },
        uptimeClass() {
            if (this.uptime === null) {
                return "";
            }
            if (this.uptime >= 99) {
                return "uptime-good";
            }
            if (this.uptime >= 90) {
                return "uptime-warning";
            }
            return "uptime-bad";
        },
    },
    methods: {
        beatClass(beat) {
            if (!beat || beat.status === null) {
                return "beat-empty";
            }
            switch (Number(beat.status)) {
                case UP:
                    return "beat-up";
                case DOWN:
                    return "beat-down";
                case MAINTENANCE:
                    return "beat-maintenance";
                default:
                    return "beat-pending";
            }
        },
        beatTitle(beat) {
            if (!beat || !beat.time) {
                return this.$t("No Data");
            }
            const time = dayjs.utc(beat.time).local().format("YYYY-MM-DD HH:mm:ss");
            const ping = beat.ping != null ? ` (${beat.ping} ms)` : "";
            return `${time}${ping} ${beat.msg || ""}`.trim();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.heartbeat-bar-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 6px 10px;
    box-sizing: border-box;
}

.panel-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
}

.monitor-info {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
}

.status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;

    &.status-up {
        background-color: #5cdd8b;
        box-shadow: 0 0 6px rgba(92, 221, 139, 0.4);
    }

    &.status-down {
        background-color: #dc3545;
        box-shadow: 0 0 6px rgba(220, 53, 69, 0.4);
    }

    &.status-pending {
        background-color: #f8a306;
    }

    &.status-maintenance {
        background-color: #1d4ed8;
    }

    &.status-paused {
        background-color: #808080;
    }
}

.monitor-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.uptime-badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    flex-shrink: 0;

    &.uptime-good {
        color: #5cdd8b;
        background: rgba(92, 221, 139, 0.12);
    }

    &.uptime-warning {
        color: #f8a306;
        background: rgba(248, 163, 6, 0.12);
    }

    &.uptime-bad {
        color: #dc3545;
        background: rgba(220, 53, 69, 0.12);
    }
}

.bar-container {
    width: 100%;
    padding-top: 2px;
}

.beats-wrapper {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    height: 18px;
}

.beat-pill {
    flex: 1;
    height: 100%;
    min-width: 2px;
    border-radius: 3px;
    transition:
        transform 0.15s ease,
        opacity 0.15s ease;

    &:hover {
        transform: scaleY(1.25);
        opacity: 0.85;
    }

    &.beat-up {
        background-color: #5cdd8b;
    }

    &.beat-down {
        background-color: #dc3545;
    }

    &.beat-pending {
        background-color: #f8a306;
    }

    &.beat-maintenance {
        background-color: #1d4ed8;
    }

    &.beat-empty {
        background-color: rgba(255, 255, 255, 0.06);

        .dark & {
            background-color: rgba(255, 255, 255, 0.04);
        }
    }
}
</style>
