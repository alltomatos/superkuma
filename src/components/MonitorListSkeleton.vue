<template>
    <div class="monitor-list-skeleton" aria-hidden="true">
        <div v-for="row in rows" :key="row" class="skeleton-row">
            <div class="skeleton-pill"></div>
            <div class="skeleton-lines">
                <div class="skeleton-line skeleton-line-title"></div>
                <div class="skeleton-line skeleton-line-subtitle"></div>
            </div>
        </div>
    </div>
</template>

<script>
/**
 * Placeholder rows shown in MonitorList.vue while the first "monitorList"
 * socket payload has not arrived yet, replacing the previous generic
 * Bootstrap spinner.
 */
export default {
    props: {
        /** How many placeholder rows to render */
        rows: {
            type: Number,
            default: 8,
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";
@import "../assets/_skeleton.scss";

.monitor-list-skeleton {
    padding: 4px 0;
}

.skeleton-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 8px;
}

.skeleton-pill {
    @include skeleton-block;

    flex-shrink: 0;
    width: 46px;
    height: 20px;
    border-radius: 10px;
}

.skeleton-lines {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.skeleton-line {
    @include skeleton-block;

    height: 10px;
}

.skeleton-line-title {
    width: 60%;
}

.skeleton-line-subtitle {
    width: 35%;
}

@media (max-width: $breakpoint-mobile) {
    .skeleton-line-title {
        width: 75%;
    }

    .skeleton-line-subtitle {
        width: 45%;
    }
}
</style>
