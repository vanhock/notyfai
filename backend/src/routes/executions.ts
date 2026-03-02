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

  // ——— Paginate by session (conversation_id / session_id), not by individual turn rows ———
  //
  // Each Cursor composer conversation = one session_id = one thread in the app.
  // A session can have many turns (one agent_executions row per generation_id),
  // so naively paginating rows gives unfair results for long conversations.
  //
  // Strategy:
  //   1. Fetch a discovery batch ordered by updated_at DESC, exclude pending placeholders.
  //   2. Deduplicate in JS to get the N most-recently-active sessions for this page.
  //   3. Re-fetch ALL execution rows for those sessions (all turns).
  //   4. Fetch all events for all of those execution rows.
  //   5. Merge events per session into one response object per session.
  //      The client receives one merged row per thread and does not need to re-group.

  type ExecRow = {
    id: string;
    instance_id: string;
    generation_id: string | null;
    conversation_id: string | null;
    session_id: string | null;
    session_ended_at: string | null;
    status: string;
    started_at: string;
    updated_at: string;
    prompt: string | null;
    model: string | null;
    workspace_roots: string[] | null;
    blocked_since: string | null;
    blocking_event_type: string | null;
    blocking_tool_name: string | null;
  };

  // ——— Step 1: Discover most-recent sessions via a JS-side dedup ———
  // Fetch up to limit*20 rows (capped at 500) so we can reliably find limit distinct sessions
  // even when individual sessions have many turns.
  const DISCOVERY_BATCH = Math.min(limit * 20, 500);

  const { data: discoveryRows, error: discoveryError } = await supabaseAdmin
    .from("agent_executions")
    .select("id, instance_id, session_id, conversation_id, updated_at, status")
    .in("instance_id", instanceIds)
    .neq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(DISCOVERY_BATCH);

  if (discoveryError) {
    res.status(500).json({ error: "Failed to fetch executions" });
    return;
  }

  if (!discoveryRows || discoveryRows.length === 0) {
    res.json({ executions: [], total: 0, limit, offset });
    return;
  }

  // Deduplicate: first occurrence per session key wins (rows are updated_at DESC).
  const seenKeys = new Set<string>();
  const sessionReps: Array<{ id: string; session_id: string | null; conversation_id: string | null }> = [];
  for (const row of discoveryRows as Array<{ id: string; session_id: string | null; conversation_id: string | null }>) {
    const key = row.session_id ?? row.conversation_id ?? row.id;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      sessionReps.push(row);
    }
  }

  const total = sessionReps.length;
  const pageReps = sessionReps.slice(offset, offset + limit);

  if (pageReps.length === 0) {
    res.json({ executions: [], total, limit, offset });
    return;
  }

  // ——— Step 2: Fetch ALL execution rows for each session in the page ———
  const pageSessionIds = [
    ...new Set(pageReps.map((r) => r.session_id).filter((s): s is string => s !== null)),
  ];
  const orphanIds = pageReps.filter((r) => !r.session_id).map((r) => r.id);

  const allSessionExecs: ExecRow[] = [];

  if (pageSessionIds.length > 0) {
    const { data: sessExecs, error: sessExecsError } = await supabaseAdmin
      .from("agent_executions")
      .select("id, instance_id, generation_id, conversation_id, session_id, session_ended_at, status, started_at, updated_at, prompt, model, workspace_roots, blocked_since, blocking_event_type, blocking_tool_name")
      .in("instance_id", instanceIds)
      .in("session_id", pageSessionIds)
      .order("started_at", { ascending: true });
    if (sessExecsError) {
      res.status(500).json({ error: "Failed to fetch session executions" });
      return;
    }
    allSessionExecs.push(...((sessExecs ?? []) as ExecRow[]));
  }

  if (orphanIds.length > 0) {
    const { data: orphanExecs, error: orphanError } = await supabaseAdmin
      .from("agent_executions")
      .select("id, instance_id, generation_id, conversation_id, session_id, session_ended_at, status, started_at, updated_at, prompt, model, workspace_roots, blocked_since, blocking_event_type, blocking_tool_name")
      .in("id", orphanIds);
    if (orphanError) {
      res.status(500).json({ error: "Failed to fetch orphan executions" });
      return;
    }
    allSessionExecs.push(...((orphanExecs ?? []) as ExecRow[]));
  }

  // ——— Step 3: Fetch all events for all of those execution rows ———
  const allExecIds = allSessionExecs.map((e) => e.id);
  const { data: events, error: eventsError } = await supabaseAdmin
    .from("cursor_events")
    .select("id, instance_id, execution_id, event_type, semantic_type, payload, created_at")
    .in("execution_id", allExecIds)
    .order("created_at", { ascending: true });

  if (eventsError) {
    res.status(500).json({ error: "Failed to fetch execution events" });
    return;
  }

  // ——— Step 4: Group events by execution_id ———
  const eventsByExecution = new Map<string, unknown[]>();
  for (const event of events ?? []) {
    const eid = (event as { execution_id: string }).execution_id;
    if (!eventsByExecution.has(eid)) eventsByExecution.set(eid, []);
    eventsByExecution.get(eid)!.push(event);
  }

  // ——— Step 5: Merge all execution rows + events per session into one response object ———
  // Returns one merged row per session/thread. The client receives one object per thread
  // with all events already combined and sorted, and started_at set to the earliest turn.
  const result = pageReps
    .map((rep) => {
      const sessionKey = rep.session_id ?? rep.conversation_id ?? rep.id;
      const sessionExecs = allSessionExecs.filter((e) => (e.session_id ?? e.conversation_id ?? e.id) === sessionKey);

      if (sessionExecs.length === 0) {
        // Avoid returning incomplete rep (missing started_at, etc.) which would break the client.
        return null;
      }

      // Most-recently-updated execution provides the authoritative status / updated_at
      const latest = sessionExecs.reduce((l, e) => (e.updated_at > l.updated_at ? e : l), sessionExecs[0]);
      // Earliest started_at is the session start
      const startedAt = sessionExecs.reduce(
        (min, e) => (e.started_at < min ? e.started_at : min),
        sessionExecs[0].started_at
      );

      // Collect and chronologically sort all events from all turns in the session
      const mergedEvents = sessionExecs
        .flatMap((e) => (eventsByExecution.get(e.id) ?? []) as Array<{ created_at: string }>)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      return {
        ...latest,
        started_at: startedAt,
        events: mergedEvents,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  res.json({ executions: result, total, limit, offset });
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
 * Bulk-delete: all for user, or scoped to instance_id, or to session_id (+ instance_id).
 * Query: instance_id?, session_id? (session_id requires instance_id).
 */
router.delete("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;

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

  let query = supabaseAdmin
    .from("agent_executions")
    .delete({ count: "exact" })
    .in("instance_id", instanceIds);
  if (sessionId != null) {
    query = query.eq("session_id", sessionId);
  }
  const { error: deleteError, count } = await query;

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete executions" });
    return;
  }

  res.json({ deleted: count ?? 0 });
});

export default router;
