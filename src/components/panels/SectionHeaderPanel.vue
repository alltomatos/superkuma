<template>
    <div class="section-header-panel">
        <div class="section-divider">
            <span class="section-title">{{ title || monitorName || $t("Section") }}</span>
        </div>
    </div>
</template>

<script>
export default {
    props: {
        monitorId: {
            type: Number,
            default: 0,
        },
        monitorName: {
            type: String,
            default: "",
        },
        title: {
            type: String,
            default: "",
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.section-header-panel {
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 4px;
    box-sizing: border-box;
}

.section-divider {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;

    &::after {
        content: "";
        flex: 1;
        height: 1px;
        background: rgba(20, 184, 166, 0.25);
    }
}

.section-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: #14b8a6;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
}
</style>
