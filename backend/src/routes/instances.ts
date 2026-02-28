import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import { signInstanceId } from "../lib/token.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();
const BASE_URL = process.env.BASE_URL || "https://api.notyfai.com";

router.get("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

router.post("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { name } = req.body as { name?: string } || {};

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

router.delete("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  try {
    const supabase = getSupabaseForUser(res.locals.accessToken);
    const { id } = req.params;

    console.log("[instances] DELETE /%s: user=%s", id, res.locals.userId);

    // 1. Verify ownership using user client
    const { data: instance, error: checkError } = await supabase
      .from("cursor_instances")
      .select("id")
      .eq("id", id)
      .single();

    if (checkError || !instance) {
      console.log("[instances] DELETE /%s: instance not found or access denied", id);
      res.status(404).json({ error: "Instance not found" });
      return;
    }

    // 2. Delete related events using admin client (bypasses RLS and handles potential foreign key issues)
    const { error: eventsError } = await supabaseAdmin
      .from("cursor_events")
      .delete()
      .eq("instance_id", id);

    if (eventsError) {
      console.log("[instances] DELETE /%s: warning - error deleting events: %s", id, eventsError.message);
    }

    // 3. Delete the instance using admin client
    const { error: deleteError } = await supabaseAdmin
      .from("cursor_instances")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.log("[instances] DELETE /%s: error: %s", id, deleteError.message);
      res.status(500).json({ error: deleteError.message });
      return;
    }
    
    console.log("[instances] DELETE /%s: success", id);
    res.status(204).send();
  } catch (err: any) {
    console.log("[instances] DELETE handler crash: %s", err.message);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/:id/hook-setup", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

  const signedToken = signInstanceId(instance.id);
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
    instance_id: instance.id,
    hook_url: hookUrl,
    hooks_json: hooksJson,
    copy_command: copyCommand,
    env_var: `NOTYFAI_HOOK_URL='${hookUrl}'`,
  });
});

export default router;
