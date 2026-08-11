<template>
    <div class="chart-skeleton" aria-hidden="true">
        <div class="skeleton-bars">
            <span v-for="bar in bars" :key="bar" class="skeleton-bar" :style="{ height: barHeight(bar) }"></span>
        </div>
    </div>
</template>

<script>
/**
 * Placeholder shown over the ping chart area (PingChart.vue) while chart
 * data is being fetched, replacing the previous blur-only loading state.
 */
export default {
    data() {
        return {
            bars: Array.from({ length: 24 }, (_, index) => index),
        };
    },
    methods: {
        /**
         * Deterministic pseudo-random bar height so the skeleton looks like
         * a plausible chart instead of a flat block, without relying on
         * Math.random() (which would repeat re-renders inconsistently).
         * @param {number} index Bar index
         * @returns {string} CSS height percentage
         */
        barHeight(index) {
            const pattern = [40, 65, 50, 80, 55, 70, 45, 60];
            return `${pattern[index % pattern.length]}%`;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";
@import "../assets/_skeleton.scss";

.chart-skeleton {
    height: 250px;
    padding: 10px;
    display: flex;
    align-items: flex-end;

    @media (max-width: $breakpoint-mobile) {
        height: 275px;
    }

    @media (min-width: $breakpoint-mobile) and (max-width: $breakpoint-tablet) {
        height: 320px;
    }
}

.skeleton-bars {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: flex-end;
    gap: 4px;
}

.skeleton-bar {
    @include skeleton-block;

    flex: 1 1 auto;
    border-radius: 3px 3px 0 0;
}
</style>
