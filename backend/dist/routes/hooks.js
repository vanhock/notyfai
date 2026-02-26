"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_js_1 = require("../lib/supabase.js");
const token_js_1 = require("../lib/token.js");
const cursor_js_1 = require("../types/cursor.js");
const router = (0, express_1.Router)();
router.post("/cursor", async (req, res) => {
    const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (!token || typeof token !== "string") {
        res.status(401).json({ error: "Missing token" });
        return;
    }
    const instanceId = (0, token_js_1.verifyAndGetInstanceId)(token);
    if (!instanceId) {
        res.status(401).json({ error: "Invalid token" });
        return;
    }
    const { data: instance, error: fetchError } = await supabase_js_1.supabaseAdmin
        .from("cursor_instances")
        .select("id, revoked")
        .eq("id", instanceId)
        .single();
    if (fetchError || !instance) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    if (instance.revoked) {
        res.status(410).json({ error: "Instance revoked" });
        return;
    }
    const body = req.body;
    const payload = body && typeof body === "object" ? body : {};
    const eventType = (0, cursor_js_1.normalizeEventType)(payload.hook_event_name ?? req.headers["x-cursor-event"]);
    const { error: insertError } = await supabase_js_1.supabaseAdmin.from("cursor_events").insert({
        instance_id: instanceId,
        event_type: eventType,
        payload,
    });
    if (insertError) {
        console.error("cursor_events insert error:", insertError);
        res.status(500).json({ error: "Failed to store event" });
        return;
    }
    await supabase_js_1.supabaseAdmin
        .from("cursor_instances")
        .update({ last_event_at: new Date().toISOString() })
        .eq("id", instanceId);
    res.status(202).json({ ok: true });
});
exports.default = router;
