import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import { signInstanceId } from "../lib/token.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();
const BASE_URL = process.env.BASE_URL || "https://api.notyfai.com";

const INSTANCE_FIELDS = "id, created_at, revoked, name, last_event_at, notification_filters, token_version";

type InstanceRow = {
  id: string;
  created_at: string;
  revoked: boolean;
  name: string | null;
  last_event_at: string | null;
  notification_filters: string[] | null;
  token_version: number;
};

router.get("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

router.post("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { name } = (req.body as { name?: string }) ?? {};

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

router.patch("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { id } = req.params;
  const { name, notification_filters } = (req.body as { name?: string; notification_filters?: string[] | null }) ?? {};

  const { data: existing, error: checkError } = await supabase
    .from("cursor_instances")
    .select("id")
    .eq("id", id)
    .single();

  if (checkError || !existing) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const updates: Partial<InstanceRow> = {};
  if (name !== undefined) updates.name = name || null;
  if (notification_filters !== undefined) updates.notification_filters = notification_filters;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const { data, error } = await supabaseAdmin
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

router.delete("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

  await supabaseAdmin.from("cursor_events").delete().eq("instance_id", id);
  const { error: deleteError } = await supabaseAdmin.from("cursor_instances").delete().eq("id", id);

  if (deleteError) {
    res.status(500).json({ error: deleteError.message });
    return;
  }
  res.status(204).send();
});

router.get("/:id/hook-setup", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

  const { token_version: version } = instance as { id: string; token_version: number };
  const signedToken = signInstanceId(instance.id, version);
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

router.post("/:id/regenerate-token", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
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

  const newVersion = (instance as { id: string; token_version: number }).token_version + 1;

  const { error: updateError } = await supabaseAdmin
    .from("cursor_instances")
    .update({ token_version: newVersion })
    .eq("id", id);

  if (updateError) {
    res.status(500).json({ error: "Failed to regenerate token" });
    return;
  }

  const signedToken = signInstanceId(id, newVersion);
  const hookUrl = `${BASE_URL}/api/hooks/cursor?token=${encodeURIComponent(signedToken)}`;
  res.json({ hook_url: hookUrl, token_version: newVersion });
});

export default router;
