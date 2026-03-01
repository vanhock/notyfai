"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_js_1 = require("./middleware/auth.js");
const auth_js_2 = __importDefault(require("./routes/auth.js"));
const hooks_js_1 = __importDefault(require("./routes/hooks.js"));
const instances_js_1 = __importDefault(require("./routes/instances.js"));
const devices_js_1 = __importDefault(require("./routes/devices.js"));
const events_js_1 = __importDefault(require("./routes/events.js"));
const executions_js_1 = __importDefault(require("./routes/executions.js"));
const account_js_1 = __importDefault(require("./routes/account.js"));
const subscriptions_js_1 = __importDefault(require("./routes/subscriptions.js"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
app.use("/api/auth", auth_js_2.default);
app.use("/api/hooks", hooks_js_1.default);
app.use("/api/instances", auth_js_1.requireAuth, instances_js_1.default);
app.use("/api/devices", auth_js_1.requireAuth, devices_js_1.default);
app.use("/api/events", auth_js_1.requireAuth, events_js_1.default);
app.use("/api/executions", auth_js_1.requireAuth, executions_js_1.default);
app.use("/api/account", auth_js_1.requireAuth, account_js_1.default);
app.use("/api/subscriptions/webhook", subscriptions_js_1.default);
app.use("/api/subscriptions", auth_js_1.requireAuth, subscriptions_js_1.default);
app.listen(PORT, () => {
    console.log(`Notyfai backend listening on port ${PORT}`);
});
