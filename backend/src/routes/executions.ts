import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/executions
 * Query params: instance_id?, limit? (default 20), offset? (default 0)
 * Returns paginated agent executions with their events embedded, ordered by started_at DESC.
 */
router.get("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? "20", 10) || 20, 50);
  const offset = parseInt(req.query.offset as string ?? "0", 10) || 0;

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
    res.json({ executions: [], total: 0, limit, offset });
    return;
  }

  const { data: executions, error, count } = await supabaseAdmin
    .from("agent_executions")
    .select("id, instance_id, generation_id, conversation_id, status, started_at, updated_at", { count: "exact" })
    .in("instance_id", instanceIds)
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(500).json({ error: "Failed to fetch executions" });
    return;
  }

  if (!executions || executions.length === 0) {
    res.json({ executions: [], total: count ?? 0, limit, offset });
    return;
  }

  // Fetch events for all returned executions in one query
  const executionIds = executions.map((e: { id: string }) => e.id);
  const { data: events, error: eventsError } = await supabaseAdmin
    .from("cursor_events")
    .select("id, instance_id, execution_id, event_type, semantic_type, payload, created_at")
    .in("execution_id", executionIds)
    .order("created_at", { ascending: true });

  if (eventsError) {
    res.status(500).json({ error: "Failed to fetch execution events" });
    return;
  }

  // Group events by execution_id
  const eventsByExecution = new Map<string, unknown[]>();
  for (const event of events ?? []) {
    const eid = (event as { execution_id: string }).execution_id;
    if (!eventsByExecution.has(eid)) eventsByExecution.set(eid, []);
    eventsByExecution.get(eid)!.push(event);
  }

  const result = executions.map((exec: { id: string }) => ({
    ...exec,
    events: eventsByExecution.get(exec.id) ?? [],
  }));

  res.json({ executions: result, total: count ?? 0, limit, offset });
});

/**
 * DELETE /api/executions/:id
 * Deletes an execution and all its events (cascade). Verifies ownership.
 */
router.delete("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { id } = req.params;

  const { data: execution, error: fetchError } = await supabaseAdmin
    .from("agent_executions")
    .select("id, instance_id")
    .eq("id", id)
    .single();

  if (fetchError || !execution) {
    res.status(404).json({ error: "Execution not found" });
    return;
  }

  // Verify ownership via user-scoped client
  const { data: inst, error: instError } = await supabase
    .from("cursor_instances")
    .select("id")
    .eq("id", (execution as { instance_id: string }).instance_id)
    .single();

  if (instError || !inst) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { error: deleteError } = await supabaseAdmin
    .from("agent_executions")
    .delete()
    .eq("id", id);

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete execution" });
    return;
  }

  res.status(204).send();
});

/**
 * DELETE /api/executions
 * Bulk-delete all executions for the user (or scoped to an instance).
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
    .from("agent_executions")
    .delete({ count: "exact" })
    .in("instance_id", instanceIds);

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete executions" });
    return;
  }

  res.json({ deleted: count ?? 0 });
});

export default router;
