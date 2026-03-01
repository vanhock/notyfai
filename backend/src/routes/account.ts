import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/account/change-password
 * Body: { password: string }
 * Changes the authenticated user's password.
 */
router.post("/change-password", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    console.log("[account] POST /change-password error: %s", error.message);
    res.status(400).json({ error: error.message });
    return;
  }

  console.log("[account] POST /change-password: success userId=%s", res.locals.userId);
  res.json({ ok: true });
});

/**
 * DELETE /api/account/data
 * Deletes all events and instances for the authenticated user.
 * Leaves the user account intact.
 */
router.delete("/data", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const userId = res.locals.userId;

  // Get all instance IDs for this user
  const { data: instances, error: instError } = await supabase
    .from("cursor_instances")
    .select("id");

  if (instError) {
    res.status(500).json({ error: "Failed to fetch instances" });
    return;
  }

  const instanceIds = (instances ?? []).map((i: { id: string }) => i.id);

  // Delete all events
  if (instanceIds.length > 0) {
    const { error: eventsError } = await supabaseAdmin
      .from("cursor_events")
      .delete()
      .in("instance_id", instanceIds);

    if (eventsError) {
      console.warn("[account] DELETE /data: error deleting events for user %s: %s", userId, eventsError.message);
    }
  }

  // Delete all instances
  const { error: deleteInstancesError } = await supabaseAdmin
    .from("cursor_instances")
    .delete()
    .eq("user_id", userId);

  if (deleteInstancesError) {
    res.status(500).json({ error: "Failed to delete instances" });
    return;
  }

  console.log("[account] DELETE /data: cleared %d instance(s) for user %s", instanceIds.length, userId);
  res.json({ ok: true, instances_deleted: instanceIds.length });
});

/**
 * DELETE /api/account
 * Deletes all user data and removes the auth account entirely.
 */
router.delete("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const userId = res.locals.userId;

  // Get all instance IDs
  const { data: instances } = await supabase
    .from("cursor_instances")
    .select("id");

  const instanceIds = (instances ?? []).map((i: { id: string }) => i.id);

  // Delete events
  if (instanceIds.length > 0) {
    await supabaseAdmin.from("cursor_events").delete().in("instance_id", instanceIds);
  }

  // Delete instances
  await supabaseAdmin.from("cursor_instances").delete().eq("user_id", userId);

  // Delete push tokens
  await supabaseAdmin.from("push_tokens").delete().eq("user_id", userId);

  // Delete the auth user
  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    console.error("[account] DELETE /: failed to delete auth user %s: %s", userId, deleteUserError.message);
    res.status(500).json({ error: "Failed to delete account" });
    return;
  }

  console.log("[account] DELETE /: account deleted for user %s", userId);
  res.json({ ok: true });
});

export default router;
