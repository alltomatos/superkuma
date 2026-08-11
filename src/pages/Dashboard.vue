<template>
    <div class="container-fluid">
        <button
            v-if="!$root.isMobile"
            type="button"
            class="monitor-list-toggle btn"
            :class="{ collapsed: !showMonitorList }"
            :aria-expanded="showMonitorList"
            :aria-label="showMonitorList ? $t('Hide Monitor List') : $t('Show Monitor List')"
            :title="showMonitorList ? $t('Hide Monitor List') : $t('Show Monitor List')"
            @click="toggleMonitorList"
        >
            <font-awesome-icon icon="bars" />
        </button>

        <div class="row">
            <div
                v-if="!$root.isMobile && showMonitorList"
                class="col-12 col-md-5 col-xl-4 ps-0 monitor-list-col"
            >
                <div>
                    <router-link to="/add" class="btn btn-primary mb-3">
                        <font-awesome-icon icon="plus" />
                        {{ $t("Add New Monitor") }}
                    </router-link>
                </div>
                <MonitorList :scrollbar="true" />
            </div>

            <div
                ref="container"
                class="col-12 mb-3 gx-0"
                :class="
                    $root.isMobile || showMonitorList ? 'col-md-7 col-xl-8' : 'col-md-12 monitor-list-collapsed'
                "
            >
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>
import MonitorList from "../components/MonitorList.vue";

const STORAGE_KEY = "showMonitorList";

export default {
    components: {
        MonitorList,
    },
    data() {
        return {
            height: 0,
            showMonitorList: localStorage.getItem(STORAGE_KEY) !== "0",
        };
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
    methods: {
        /**
         * Toggle the visibility of the monitor list column and persist the choice.
         * @returns {void}
         */
        toggleMonitorList() {
            this.showMonitorList = !this.showMonitorList;
            localStorage.setItem(STORAGE_KEY, this.showMonitorList ? "1" : "0");
            this.$nextTick(() => {
                if (this.$refs.container) {
                    this.height = this.$refs.container.offsetHeight;
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.container-fluid {
    width: 98%;
    position: relative;
}

.monitor-list-toggle {
    position: absolute;
    top: -6px;
    left: 0;
    z-index: 10;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    background-color: #fff;
    color: inherit;

    &:hover {
        background-color: $primary;
        color: #fff;
    }

    &.collapsed {
        position: static;
        margin-bottom: 12px;
    }

    .dark & {
        background-color: $dark-bg2;
        border-color: $dark-border-color;

        &:hover {
            background-color: $primary;
        }
    }
}

.monitor-list-col {
    padding-top: 44px;
    transition: all 0.15s ease-in-out;
}
</style>
