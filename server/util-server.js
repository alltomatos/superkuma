// Barrel file for server/util-server/ submodules.
// This file preserves the exact public API previously exported by
// server/util-server.js. Node resolves this .js file before the
// server/util-server/ folder, so every existing require("./util-server")
// continues to work unchanged.

const auth = require("./util-server/auth");
const network = require("./util-server/network");
const tls = require("./util-server/tls");
const externalClients = require("./util-server/external-clients");
const format = require("./util-server/format");
const misc = require("./util-server/misc");

Object.assign(module.exports, auth, network, tls, externalClients, format, misc);

// For unit test, export functions
if (process.env.TEST_BACKEND) {
    module.exports.__test = {
        parseCertificateInfo: tls.__test.parseCertificateInfo,
    };
    module.exports.__getPrivateFunction = (functionName) => {
        return module.exports.__test[functionName];
    };
}
