<template>
    <!-- HTTP Options -->
    <template v-if="model.type === 'http' || model.type === 'keyword' || model.type === 'json-query'">
        <h2 class="mt-5 mb-2">{{ $t("HTTP Options") }}</h2>

        <!-- Method -->
        <div class="my-3">
            <label for="method" class="form-label">{{ $t("Method") }}</label>
            <select id="method" v-model="model.method" class="form-select">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
                <option value="HEAD">HEAD</option>
                <option value="OPTIONS">OPTIONS</option>
            </select>
        </div>

        <!-- Encoding -->
        <div class="my-3">
            <label for="httpBodyEncoding" class="form-label">{{ $t("Body Encoding") }}</label>
            <select id="httpBodyEncoding" v-model="model.httpBodyEncoding" class="form-select">
                <option value="json">JSON</option>
                <option value="form">x-www-form-urlencoded</option>
                <option value="xml">XML</option>
            </select>
        </div>

        <!-- Body -->
        <div class="my-3">
            <label for="body" class="form-label">{{ $t("Body") }}</label>
            <textarea id="body" v-model="model.body" class="form-control" :placeholder="bodyPlaceholder"></textarea>
        </div>

        <!-- Headers -->
        <div class="my-3">
            <label for="headers" class="form-label">{{ $t("Headers") }}</label>
            <textarea
                id="headers"
                v-model="model.headers"
                class="form-control"
                :placeholder="headersPlaceholder"
            ></textarea>
        </div>

        <!-- HTTP Auth -->
        <h4 class="mt-5 mb-2">{{ $t("Authentication") }}</h4>

        <!-- Method -->
        <div class="my-3">
            <label for="method" class="form-label">{{ $t("Method") }}</label>
            <select id="method" v-model="model.authMethod" class="form-select">
                <option :value="null">
                    {{ $t("None") }}
                </option>
                <option value="basic">
                    {{ $t("HTTP Basic Auth") }}
                </option>
                <option value="bearer">
                    {{ $t("Bearer Token") }}
                </option>
                <option value="oauth2-cc">
                    {{ $t("OAuth2: Client Credentials") }}
                </option>
                <option value="ntlm">NTLM</option>
                <option value="mtls">mTLS</option>
            </select>
        </div>
        <template v-if="model.authMethod && model.authMethod !== null">
            <template v-if="model.authMethod === 'mtls'">
                <div class="my-3">
                    <label for="tls-cert" class="form-label">
                        {{ $t("mtls-auth-server-cert-label") }}
                    </label>
                    <textarea
                        id="tls-cert"
                        v-model="model.tlsCert"
                        class="form-control"
                        :placeholder="$t('mtls-auth-server-cert-placeholder')"
                        required
                    ></textarea>
                </div>
                <div class="my-3">
                    <label for="tls-key" class="form-label">
                        {{ $t("mtls-auth-server-key-label") }}
                    </label>
                    <textarea
                        id="tls-key"
                        v-model="model.tlsKey"
                        class="form-control"
                        :placeholder="$t('mtls-auth-server-key-placeholder')"
                        required
                    ></textarea>
                </div>
                <div class="my-3">
                    <label for="tls-ca" class="form-label">
                        {{ $t("mtls-auth-server-ca-label") }}
                    </label>
                    <textarea
                        id="tls-ca"
                        v-model="model.tlsCa"
                        class="form-control"
                        :placeholder="$t('mtls-auth-server-ca-placeholder')"
                    ></textarea>
                </div>
            </template>
            <template v-else-if="model.authMethod === 'bearer'">
                <div class="my-3">
                    <label for="bearer-token" class="form-label">{{ $t("Token") }}</label>
                    <HiddenInput
                        id="bearer-token"
                        v-model="model.bearer_token"
                        autocomplete="new-password"
                        :placeholder="$t('Token')"
                    />
                </div>
            </template>
            <template v-else-if="model.authMethod === 'oauth2-cc'">
                <div class="my-3">
                    <label for="oauth_auth_method" class="form-label">
                        {{ $t("Authentication Method") }}
                    </label>
                    <select id="oauth_auth_method" v-model="model.oauth_auth_method" class="form-select">
                        <option value="client_secret_basic">
                            {{ $t("Authorization Header") }}
                        </option>
                        <option value="client_secret_post">
                            {{ $t("Form Data Body") }}
                        </option>
                    </select>
                </div>
                <div class="my-3">
                    <label for="oauth_token_url" class="form-label">
                        {{ $t("OAuth Token URL") }}
                    </label>
                    <input
                        id="oauth_token_url"
                        v-model="model.oauth_token_url"
                        type="text"
                        class="form-control"
                        :placeholder="$t('OAuth Token URL')"
                        required
                    />
                </div>
                <div class="my-3">
                    <label for="oauth_client_id" class="form-label">
                        {{ $t("Client ID") }}
                    </label>
                    <input
                        id="oauth_client_id"
                        v-model="model.oauth_client_id"
                        type="text"
                        class="form-control"
                        :placeholder="$t('Client ID')"
                        required
                    />
                </div>
                <template
                    v-if="
                        model.oauth_auth_method === 'client_secret_post' ||
                        model.oauth_auth_method === 'client_secret_basic'
                    "
                >
                    <div class="my-3">
                        <label for="oauth_client_secret" class="form-label">
                            {{ $t("Client Secret") }}
                        </label>
                        <HiddenInput
                            id="oauth_client_secret"
                            v-model="model.oauth_client_secret"
                            :placeholder="$t('Client Secret')"
                            :required="true"
                        />
                    </div>
                    <div class="my-3">
                        <label for="oauth_scopes" class="form-label">
                            {{ $t("OAuth Scope") }}
                        </label>
                        <input
                            id="oauth_scopes"
                            v-model="model.oauth_scopes"
                            type="text"
                            class="form-control"
                            :placeholder="$t('Optional: Space separated list of scopes')"
                        />
                    </div>
                    <div class="my-3">
                        <label for="oauth_audience" class="form-label">
                            {{ $t("OAuth Audience") }}
                        </label>
                        <input
                            id="oauth_audience"
                            v-model="model.oauth_audience"
                            type="text"
                            class="form-control"
                            :placeholder="$t('Optional: The audience to request the JWT for')"
                        />
                    </div>
                </template>
            </template>
            <template v-else>
                <div class="my-3">
                    <label for="basicauth-user" class="form-label">{{ $t("Username") }}</label>
                    <input
                        id="basicauth-user"
                        v-model="model.basic_auth_user"
                        type="text"
                        class="form-control"
                        :placeholder="$t('Username')"
                    />
                </div>

                <div class="my-3">
                    <label for="basicauth-pass" class="form-label">{{ $t("Password") }}</label>
                    <HiddenInput
                        id="basicauth-pass"
                        v-model="model.basic_auth_pass"
                        autocomplete="new-password"
                        :placeholder="$t('Password')"
                    />
                </div>
                <template v-if="model.authMethod === 'ntlm'">
                    <div class="my-3">
                        <label for="ntlm-domain" class="form-label">{{ $t("Domain") }}</label>
                        <input
                            id="ntlm-domain"
                            v-model="model.authDomain"
                            type="text"
                            class="form-control"
                            :placeholder="$t('Domain')"
                        />
                    </div>

                    <div class="my-3">
                        <label for="ntlm-workstation" class="form-label">
                            {{ $t("Workstation") }}
                        </label>
                        <input
                            id="ntlm-workstation"
                            v-model="model.authWorkstation"
                            type="text"
                            class="form-control"
                            :placeholder="$t('Workstation')"
                        />
                    </div>
                </template>
            </template>
        </template>
    </template>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    name: "HttpOptionsFields",

    components: {
        HiddenInput,
    },

    props: {
        /**
         * The monitor object being edited. Passed by reference (same reactive
         * object as the parent's), so mutations to its fields propagate back
         * to the parent automatically.
         */
        monitor: {
            type: Object,
            required: true,
        },

        /**
         * Placeholder text for the Body textarea (depends on monitor.httpBodyEncoding).
         */
        bodyPlaceholder: {
            type: String,
            required: true,
        },

        /**
         * Placeholder text for the Headers textarea.
         */
        headersPlaceholder: {
            type: String,
            required: true,
        },
    },

    computed: {
        // Template reads/writes go through this computed alias (rather than
        // directly against the "monitor" prop) since the underlying object is
        // the same reference as the parent's reactive monitor: field mutations
        // (e.g. v-model="monitor.method") still propagate to the parent as if
        // the markup were still inline there.
        model() {
            return this.monitor;
        },
    },
};
</script>
