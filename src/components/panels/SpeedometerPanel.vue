<template>
    <div class="speedometer-panel">
        <svg viewBox="0 0 120 80" class="speedometer-svg">
            <path d="M12 72 A48 48 0 0 1 108 72" fill="none" class="track" stroke-width="11" stroke-linecap="round" />
            <path
                v-if="arcPath"
                :d="arcPath"
                fill="none"
                :style="{ stroke: statusColor }"
                stroke-width="11"
                stroke-linecap="round"
            />
            <line
                :x1="60"
                :y1="72"
                :x2="needleTip.x"
                :y2="needleTip.y"
                class="needle"
                :style="{ stroke: needleColor }"
            />
            <circle cx="60" cy="72" r="4" class="needle-hub" :style="{ fill: needleColor }" />
            <text x="60" y="60" class="gval">
                {{ displayValue }}
                <tspan v-if="unit" class="u">{{ unit }}</tspan>
            </text>
        </svg>
    </div>
</template>

<script>
const STATUS_COLORS = {
    0: "#dc3545", // down
    1: "#5cdd8b", // up
    2: "#f8a306", // pending
    3: "#1747f5", // maintenance
};

/**
 * A needle gauge over a 180-degree arc (ADR-0017 "speedometer" panel kind) --
 * e.g. NIC throughput, disk IOPS. SVG-based (chart.js has no native needle
 * gauge without a plugin dependency).
 */
export default {
    props: {
        /** Current metric value */
        value: {
            type: Number,
            required: true,
        },
        /** Monitor's current heartbeat status, colors the arc/needle */
        status: {
            type: Number,
            default: 1,
        },
        /** Gauge ceiling. Values are clamped to [0, max]. */
        max: {
            type: Number,
            default: 100,
        },
        /** Optional unit suffix shown next to the value */
        unit: {
            type: String,
            default: "",
        },
    },
    computed: {
        statusColor() {
            return STATUS_COLORS[this.status] ?? STATUS_COLORS[2];
        },
        needleColor() {
            // The needle itself stays neutral so it reads against any arc color.
            return "var(--needle-color, #333)";
        },
        clampedRatio() {
            if (!Number.isFinite(this.max) || this.max <= 0) {
                return 0;
            }
            return Math.max(0, Math.min(this.value / this.max, 1));
        },
        displayValue() {
            return Math.round(this.value * 100) / 100;
        },
        /**
         * Point on the 180deg arc for the needle tip, at the current ratio.
         * @returns {{x: number, y: number}} The SVG coordinate.
         */
        needleTip() {
            const angle = Math.PI - this.clampedRatio * Math.PI; // PI (left) -> 0 (right)
            const radius = 38;
            return {
                x: 60 + radius * Math.cos(angle),
                y: 72 - radius * Math.sin(angle),
            };
        },
        /**
         * SVG arc path from the left endpoint to the current value's angle,
         * filling the colored portion of the track.
         * @returns {string} An SVG path "d" attribute.
         */
        arcPath() {
            if (this.clampedRatio <= 0) {
                return null;
            }
            const angle = Math.PI - this.clampedRatio * Math.PI;
            const radius = 48;
            const endX = 60 + radius * Math.cos(angle);
            const endY = 72 - radius * Math.sin(angle);
            const largeArc = this.clampedRatio > 0.5 ? 1 : 0;
            return `M12 72 A48 48 0 ${largeArc} 1 ${endX} ${endY}`;
        },
    },
};
</script>

<style lang="scss" scoped>
.speedometer-panel {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
}

.speedometer-svg {
    width: 100%;
    max-height: 90px;
}

.track {
    stroke: rgba(128, 128, 128, 0.15);
}

.needle {
    stroke-width: 2.5;
    stroke-linecap: round;
}

.gval {
    text-anchor: middle;
    font-size: 15px;
    font-weight: 700;
    fill: currentColor;
}

.u {
    font-size: 9px;
    fill: currentColor;
    opacity: 0.65;
}
</style>
