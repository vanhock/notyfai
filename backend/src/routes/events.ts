import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/events
 * Query params: instance_id?, limit? (default 50), offset? (default 0)
 * Returns paginated events for all instances owned by the user (or filtered by instance).
 */
router.get("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? "50", 10) || 50, 100);
  const offset = parseInt(req.query.offset as string ?? "0", 10) || 0;

  // Get user's instance IDs first (RLS ensures ownership)
  let instanceIds: string[];
  if (instanceId) {
    // Verify user owns this instance
    const { data: inst, error: instError } = await supabase
      .from("cursor_instances")
      .select("id")
      .eq("id", instanceId)
      .single();
    if (instError || !inst) {
      res.status(404).json({ error: "Instance not found" });
      return;
    }
    instanceIds = [instanceId];
  } else {
    const { data: instances, error: instError } = await supabase
      .from("cursor_instances")
      .select("id");
    if (instError) {
      res.status(500).json({ error: "Failed to fetch instances" });
      return;
    }
    instanceIds = (instances ?? []).map((i: { id: string }) => i.id);
  }

  if (instanceIds.length === 0) {
    res.json({ events: [], total: 0, limit, offset });
    return;
  }

  const { data: events, error, count } = await supabaseAdmin
    .from("cursor_events")
    .select("id, instance_id, event_type, payload, created_at", { count: "exact" })
    .in("instance_id", instanceIds)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(500).json({ error: "Failed to fetch events" });
    return;
  }

  res.json({ events: events ?? [], total: count ?? 0, limit, offset });
});

/**
 * DELETE /api/events/:id
 * Deletes a single event. Verifies ownership via instance → user.
 */
router.delete("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { id } = req.params;

  // Look up the event to get instance_id
  const { data: event, error: fetchError } = await supabaseAdmin
    .from("cursor_events")
    .select("id, instance_id")
    .eq("id", id)
    .single();

  if (fetchError || !event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // Verify ownership via user-scoped client
  const { data: inst, error: instError } = await supabase
    .from("cursor_instances")
    .select("id")
    .eq("id", event.instance_id)
    .single();

  if (instError || !inst) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { error: deleteError } = await supabaseAdmin
    .from("cursor_events")
    .delete()
    .eq("id", id);

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete event" });
    return;
  }

  res.status(204).send();
});

/**
 * DELETE /api/events
 * Deletes all events for the user (optionally scoped to an instance).
 * Query param: instance_id?
 */
router.delete("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;

  let instanceIds: string[];
  if (instanceId) {
    const { data: inst, error: instError } = await supabase
      .from("cursor_instances")
      .select("id")
      .eq("id", instanceId)
      .single();
    if (instError || !inst) {
      res.status(404).json({ error: "Instance not found" });
      return;
    }
    instanceIds = [instanceId];
  } else {
    const { data: instances, error: instError } = await supabase
      .from("cursor_instances")
      .select("id");
    if (instError) {
      res.status(500).json({ error: "Failed to fetch instances" });
      return;
    }
    instanceIds = (instances ?? []).map((i: { id: string }) => i.id);
  }

  if (instanceIds.length === 0) {
    res.json({ deleted: 0 });
    return;
  }

  const { error: deleteError, count } = await supabaseAdmin
    .from("cursor_events")
    .delete({ count: "exact" })
    .in("instance_id", instanceIds);

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete events" });
    return;
  }

  res.json({ deleted: count ?? 0 });
});

export default router;
