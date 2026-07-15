<template>
    <div class="log-rule-editor my-3">
        <label class="form-label">Log Rules</label>
        <div class="form-text mb-2">
            Each rule is evaluated on every check, independent of this monitor's reachability status. A rule that trips
            raises a severity-routed alert without ever turning this monitor DOWN.
        </div>

        <div v-if="ruleList.length === 0" class="text-muted mb-2">No log rules yet.</div>

        <div v-for="rule in ruleList" :key="rule.id" class="log-rule-row border rounded p-3 mb-2">
            <div class="row g-2">
                <div class="col-md-3">
                    <label class="form-label">Name</label>
                    <input v-model="rule.name" type="text" class="form-control" placeholder="ERROR spikes" />
                </div>
                <div class="col-md-5">
                    <label class="form-label">LogQL</label>
                    <input
                        v-model="rule.logql"
                        type="text"
                        class="form-control"
                        placeholder='count_over_time({job="app"} |= "error" [5m])'
                    />
                </div>
                <div class="col-md-2">
                    <label class="form-label">Operator</label>
                    <select v-model="rule.operator" class="form-select">
                        <option v-for="op in operators" :key="op" :value="op">{{ op }}</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label">Threshold</label>
                    <input v-model.number="rule.threshold" type="number" class="form-control" />
                </div>
            </div>
            <div class="row g-2 align-items-end mt-1">
                <div class="col-md-3">
                    <label class="form-label">Severity</label>
                    <select v-model="rule.severity" class="form-select">
                        <option v-for="sev in severities" :key="sev" :value="sev">{{ sev }}</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <div class="form-check">
                        <input
                            :id="'rule-enabled-' + rule.id"
                            v-model="rule.enabled"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" :for="'rule-enabled-' + rule.id">Enabled</label>
                    </div>
                </div>
                <div class="col-md-6 text-end">
                    <button
                        type="button"
                        class="btn btn-primary btn-sm me-2"
                        :disabled="saving === rule.id"
                        @click="saveRule(rule)"
                    >
                        Save
                    </button>
                    <button type="button" class="btn btn-danger btn-sm" @click="removeRule(rule)">Remove</button>
                </div>
            </div>
        </div>

        <button type="button" class="btn btn-normal btn-sm" @click="addRule">
            <font-awesome-icon icon="plus" />
            Add rule
        </button>
    </div>
</template>

<script>
export default {
    props: {
        monitorId: {
            type: Number,
            required: true,
        },
    },

    data() {
        return {
            ruleList: [],
            saving: null,
            operators: [">", ">=", "<", "<=", "==", "!="],
            severities: ["info", "warning", "critical"],
        };
    },

    mounted() {
        this.fetchList();
    },

    methods: {
        /**
         * Load the rule list for this monitor from the server
         * @returns {void}
         */
        fetchList() {
            this.$root.getLogRuleList(this.monitorId, (res) => {
                if (res.ok) {
                    this.ruleList = res.ruleList;
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Add a new, unsaved rule row to the local list
         * @returns {void}
         */
        addRule() {
            this.ruleList.push({
                id: null,
                name: "",
                logql: "",
                operator: ">",
                threshold: 0,
                severity: "warning",
                enabled: true,
            });
        },

        /**
         * Persist a rule row -- creates it if it has no id yet, otherwise updates it
         * @param {object} rule The rule row to save
         * @returns {void}
         */
        saveRule(rule) {
            this.saving = rule.id;
            const done = (res) => {
                this.saving = null;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.fetchList();
                }
            };

            if (rule.id) {
                this.$root.updateLogRule(
                    {
                        id: rule.id,
                        name: rule.name,
                        logql: rule.logql,
                        operator: rule.operator,
                        threshold: rule.threshold,
                        severity: rule.severity,
                        enabled: rule.enabled,
                    },
                    done
                );
            } else {
                this.$root.addLogRule(
                    {
                        monitorId: this.monitorId,
                        name: rule.name,
                        logql: rule.logql,
                        operator: rule.operator,
                        threshold: rule.threshold,
                        severity: rule.severity,
                        enabled: rule.enabled,
                    },
                    done
                );
            }
        },

        /**
         * Remove a rule row -- deletes it server-side if already saved,
         * otherwise just drops the unsaved local row
         * @param {object} rule The rule row to remove
         * @returns {void}
         */
        removeRule(rule) {
            if (!rule.id) {
                this.ruleList = this.ruleList.filter((r) => r !== rule);
                return;
            }
            this.$root.deleteLogRule(rule.id, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.fetchList();
                }
            });
        },
    },
};
</script>
