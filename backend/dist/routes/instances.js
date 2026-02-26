"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_js_1 = require("../lib/supabase.js");
const token_js_1 = require("../lib/token.js");
const router = (0, express_1.Router)();
const BASE_URL = process.env.BASE_URL || "https://api.notyfai.com";
router.get("/", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { data, error } = await supabase
        .from("cursor_instances")
        .select("id, created_at, revoked, name, last_event_at")
        .order("created_at", { ascending: false });
    if (error) {
        res.status(500).json({ error: "Failed to list instances" });
        return;
    }
    res.json(data);
});
router.post("/", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { name } = req.body || {};
    const { data: instance, error } = await supabase
        .from("cursor_instances")
        .insert({ user_id: res.locals.userId, name: name || null })
        .select("id, created_at, revoked, name, last_event_at")
        .single();
    if (error) {
        res.status(500).json({ error: "Failed to create instance" });
        return;
    }
    res.status(201).json(instance);
});
router.get("/:id/hook-setup", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { id } = req.params;
    const { data: instance, error } = await supabase
        .from("cursor_instances")
        .select("id")
        .eq("id", id)
        .single();
    if (error || !instance) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    const signedToken = (0, token_js_1.signInstanceId)(instance.id);
    const hookUrl = `${BASE_URL}/api/hooks/cursor?token=${encodeURIComponent(signedToken)}`;
    const hooksJson = {
        version: 1,
        hooks: {
            stop: [{ command: "./scripts/notyfai-send.sh" }],
            beforeShellExecution: [{ command: "./scripts/notyfai-send.sh" }],
            beforeMCPExecution: [{ command: "./scripts/notyfai-send.sh" }],
        },
    };
    const copyCommand = `echo '${hookUrl}' > ~/.cursor/notyfai-url`;
    res.json({
        hook_url: hookUrl,
        hooks_json: hooksJson,
        copy_command: copyCommand,
        env_var: `NOTYFAI_HOOK_URL='${hookUrl}'`,
    });
});
exports.default = router;
