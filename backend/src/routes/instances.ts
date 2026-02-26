import { Router, Request, Response } from "express";
import { getSupabaseForUser } from "../lib/supabase.js";
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
    hook_url: hookUrl,
    hooks_json: hooksJson,
    copy_command: copyCommand,
    env_var: `NOTYFAI_HOOK_URL='${hookUrl}'`,
  });
});

export default router;
