"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_js_1 = require("../lib/supabase.js");
const token_js_1 = require("../lib/token.js");
const router = (0, express_1.Router)();
const BASE_URL = process.env.BASE_URL || "https://api.notyfai.com";
const INSTANCE_FIELDS = "id, created_at, revoked, name, last_event_at, notification_filters, token_version";
router.get("/", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { data, error } = await supabase
        .from("cursor_instances")
        .select(INSTANCE_FIELDS)
        .order("created_at", { ascending: false });
    if (error) {
        res.status(500).json({ error: "Failed to list instances" });
        return;
    }
    res.json(data ?? []);
});
router.post("/", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { name } = req.body ?? {};
    const { data: instance, error } = await supabase
        .from("cursor_instances")
        .insert({ user_id: res.locals.userId, name: name || null })
        .select(INSTANCE_FIELDS)
        .single();
    if (error) {
        res.status(500).json({ error: "Failed to create instance" });
        return;
    }
    res.status(201).json(instance);
});
router.patch("/:id", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { id } = req.params;
    const { name, notification_filters } = req.body ?? {};
    const { data: existing, error: checkError } = await supabase
        .from("cursor_instances")
        .select("id")
        .eq("id", id)
        .single();
    if (checkError || !existing) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    const updates = {};
    if (name !== undefined)
        updates.name = name || null;
    if (notification_filters !== undefined)
        updates.notification_filters = notification_filters;
    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No fields to update" });
        return;
    }
    const { data, error } = await supabase_js_1.supabaseAdmin
        .from("cursor_instances")
        .update(updates)
        .eq("id", id)
        .select(INSTANCE_FIELDS)
        .single();
    if (error) {
        res.status(500).json({ error: "Failed to update instance" });
        return;
    }
    res.json(data);
});
router.delete("/:id", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { id } = req.params;
    const { data: instance, error: checkError } = await supabase
        .from("cursor_instances")
        .select("id")
        .eq("id", id)
        .single();
    if (checkError || !instance) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    await supabase_js_1.supabaseAdmin.from("cursor_events").delete().eq("instance_id", id);
    const { error: deleteError } = await supabase_js_1.supabaseAdmin.from("cursor_instances").delete().eq("id", id);
    if (deleteError) {
        res.status(500).json({ error: deleteError.message });
        return;
    }
    res.status(204).send();
});
router.get("/:id/hook-setup", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { id } = req.params;
    const { data: instance, error } = await supabase
        .from("cursor_instances")
        .select("id, token_version")
        .eq("id", id)
        .single();
    if (error || !instance) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    const { token_version: version } = instance;
    const signedToken = (0, token_js_1.signInstanceId)(instance.id, version);
    const hookUrl = `${BASE_URL}/api/hooks/cursor?token=${encodeURIComponent(signedToken)}`;
    const hookEntry = [{ command: ".cursor/hooks/notyfai-send.sh" }];
    res.json({
        instance_id: instance.id,
        hook_url: hookUrl,
        hooks_json: {
            version: 1,
            hooks: {
                sessionStart: hookEntry,
                sessionEnd: hookEntry,
                beforeSubmitPrompt: hookEntry,
                subagentStart: hookEntry,
                subagentStop: hookEntry,
                preToolUse: hookEntry,
                postToolUse: hookEntry,
                postToolUseFailure: hookEntry,
                beforeReadFile: hookEntry,
                afterFileEdit: hookEntry,
                beforeTabFileRead: hookEntry,
                afterTabFileEdit: hookEntry,
                beforeShellExecution: hookEntry,
                afterShellExecution: hookEntry,
                beforeMCPExecution: hookEntry,
                afterMCPExecution: hookEntry,
                afterAgentResponse: hookEntry,
                afterAgentThought: hookEntry,
                preCompact: hookEntry,
                stop: hookEntry,
            },
        },
        copy_command: `mkdir -p .cursor/hooks && echo '${hookUrl}' > .cursor/notyfai-url`,
        env_var: `NOTYFAI_HOOK_URL='${hookUrl}'`,
    });
});
router.post("/:id/regenerate-token", async (req, res) => {
    const supabase = (0, supabase_js_1.getSupabaseForUser)(res.locals.accessToken);
    const { id } = req.params;
    const { data: instance, error: checkError } = await supabase
        .from("cursor_instances")
        .select("id, token_version")
        .eq("id", id)
        .single();
    if (checkError || !instance) {
        res.status(404).json({ error: "Instance not found" });
        return;
    }
    const newVersion = instance.token_version + 1;
    const { error: updateError } = await supabase_js_1.supabaseAdmin
        .from("cursor_instances")
        .update({ token_version: newVersion })
        .eq("id", id);
    if (updateError) {
        res.status(500).json({ error: "Failed to regenerate token" });
        return;
    }
    const signedToken = (0, token_js_1.signInstanceId)(id, newVersion);
    const hookUrl = `${BASE_URL}/api/hooks/cursor?token=${encodeURIComponent(signedToken)}`;
    res.json({ hook_url: hookUrl, token_version: newVersion });
});
exports.default = router;
