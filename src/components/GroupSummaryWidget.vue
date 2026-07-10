<template>
    <div class="group-summary" data-testid="group-summary">
        <div class="counts">
            <span class="count-pill up">
                <font-awesome-icon icon="circle" />
                {{ counts.up }}
            </span>
            <span class="count-pill down">
                <font-awesome-icon icon="circle" />
                {{ counts.down }}
            </span>
            <span class="count-pill pending">
                <font-awesome-icon icon="circle" />
                {{ counts.pending }}
            </span>
            <span v-if="counts.paused" class="count-pill paused">
                <font-awesome-icon icon="circle" />
                {{ counts.paused }}
            </span>
        </div>
        <div class="labels">
            <span>{{ $t("Up") }}</span>
            <span>{{ $t("Down") }}</span>
            <span>{{ $t("Pending") }}</span>
            <span v-if="counts.paused">{{ $t("Paused") }}</span>
        </div>
    </div>
</template>

<script>
/**
 * Rollup of a "group" monitor's children -- how many are up/down/pending/paused
 * right now. Reads only already-loaded reactive state ($root.monitorList /
 * $root.lastHeartbeatList), no extra socket round-trip per widget.
 */
export default {
    props: {
        /** The group monitor's id (a monitor with type "group") */
        monitorId: {
            type: Number,
            required: true,
        },
    },
    computed: {
        group() {
            return this.$root.monitorList[this.monitorId];
        },
        childIds() {
            return (this.group && this.group.childrenIDs) || [];
        },
        counts() {
            const tally = { up: 0, down: 0, pending: 0, paused: 0 };
            for (const childId of this.childIds) {
                const child = this.$root.monitorList[childId];
                if (child && !child.active) {
                    tally.paused++;
                    continue;
                }
                const beat = this.$root.lastHeartbeatList[childId];
                if (!beat) {
                    tally.pending++;
                    continue;
                }
                switch (beat.status) {
                    case 1:
                        tally.up++;
                        break;
                    case 0:
                        tally.down++;
                        break;
                    default:
                        tally.pending++;
                }
            }
            return tally;
        },
    },
};
</script>

<style lang="scss" scoped>
.group-summary {
    text-align: center;
    padding: 4px 0;
}

.counts {
    display: flex;
    justify-content: center;
    gap: 10px;
    font-weight: bold;
}

.labels {
    display: flex;
    justify-content: center;
    gap: 10px;
    font-size: 0.7rem;
    opacity: 0.65;
}

.count-pill {
    svg {
        font-size: 0.5em;
        vertical-align: middle;
    }

    &.up svg {
        color: #5cdd8b;
    }

    &.down svg {
        color: #dc3545;
    }

    &.pending svg {
        color: #f8a306;
    }

    &.paused svg {
        color: #808080;
    }
}
</style>
