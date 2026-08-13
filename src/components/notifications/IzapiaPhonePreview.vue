<template>
    <div class="izapia-phone">
        <div class="izapia-phone-notch"></div>
        <div class="izapia-phone-screen">
            <div class="izapia-chat-header">
                <div class="izapia-chat-avatar">SK</div>
                <div class="izapia-chat-title">SuperKuma</div>
            </div>
            <div class="izapia-chat-body">
                <div class="izapia-bubble">
                    <div class="izapia-bubble-text">{{ renderedText }}</div>
                    <div class="izapia-bubble-time">10:24</div>
                </div>
                <div v-if="interactive" class="izapia-buttons">
                    <button v-if="showPauseResumeButton" type="button" class="izapia-button" disabled>
                        {{ pauseLabel }}
                    </button>
                    <button v-if="showAckButton" type="button" class="izapia-button" disabled>{{ ackLabel }}</button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    props: {
        template: {
            type: String,
            default: "",
        },
        interactive: {
            type: Boolean,
            default: false,
        },
        showPauseResumeButton: {
            type: Boolean,
            default: true,
        },
        showAckButton: {
            type: Boolean,
            default: true,
        },
        customPauseLabel: {
            type: String,
            default: "",
        },
        customAckLabel: {
            type: String,
            default: "",
        },
    },

    computed: {
        renderedText() {
            const sample = {
                "{monitorName}": "API Principal",
                "{status}": "Down",
                "{statusEmoji}": "🔴",
                "{time}": "10:24",
                "{msg}": "Connection refused",
            };
            let text = this.template || "";
            for (const [placeholder, value] of Object.entries(sample)) {
                text = text.split(placeholder).join(value);
            }
            return text || " ";
        },

        pauseLabel() {
            return this.customPauseLabel || this.$t("izapiaPauseButtonLabel");
        },

        ackLabel() {
            return this.customAckLabel || this.$t("izapiaAckButtonLabel");
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.izapia-phone {
    width: 260px;
    border-radius: 28px;
    background: #111;
    padding: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    margin: 0 auto;
}

.izapia-phone-notch {
    width: 60px;
    height: 6px;
    border-radius: 3px;
    background: #333;
    margin: 0 auto 6px;
}

.izapia-phone-screen {
    background: #e5ddd5;
    border-radius: 18px;
    overflow: hidden;
    min-height: 360px;
    display: flex;
    flex-direction: column;
}

.izapia-chat-header {
    background: #075e54;
    color: #fff;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.izapia-chat-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #25d366;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: bold;
}

.izapia-chat-title {
    font-size: 0.85rem;
    font-weight: 600;
}

.izapia-chat-body {
    padding: 14px 10px;
    flex: 1;
}

.izapia-bubble {
    background: #fff;
    border-radius: 8px;
    padding: 8px 10px;
    max-width: 90%;
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.1);
}

.izapia-bubble-text {
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
    color: #111;
}

.izapia-bubble-time {
    font-size: 0.65rem;
    color: #999;
    text-align: right;
    margin-top: 4px;
}

.izapia-buttons {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 90%;
}

.izapia-button {
    background: #fff;
    border: none;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 0.78rem;
    color: #128c7e;
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.1);
    cursor: default;
}
</style>
