import { Router, Request, Response } from "express";
import { getSupabaseForUser, supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/executions
 * Query params: instance_id?, limit? (default 20), offset? (default 0)
 * Returns paginated threads (one per Cursor conversation) with embedded events.
 * Response shape compatible with AgentExecution model; id is thread.id.
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

  type ThreadRow = {
    id: string;
    instance_id: string;
    conversation_id: string;
    status: string;
    prompt: string | null;
    session_ended_at: string | null;
    started_at: string;
    updated_at: string;
  };

  type ExecRow = {
    id: string;
    thread_id: string;
    instance_id: string;
    generation_id: string;
    started_at: string;
    updated_at: string;
    blocked_since: string | null;
    blocking_event_type: string | null;
    blocking_tool_name: string | null;
  };

  // Fetch threads (paginated, exclude pending placeholders)
  const { data: threads, error: threadsError } = await supabaseAdmin
    .from("threads")
    .select("id, instance_id, conversation_id, status, prompt, session_ended_at, started_at, updated_at")
    .in("instance_id", instanceIds)
    .neq("status", "pending")
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (threadsError) {
    res.status(500).json({ error: "Failed to fetch threads" });
    return;
  }

  if (!threads || threads.length === 0) {
    res.json({ executions: [], total: 0, limit, offset });
    return;
  }

  // Total count for pagination (without fetching all)
  const { count: totalCount, error: countError } = await supabaseAdmin
    .from("threads")
    .select("id", { count: "exact", head: true })
    .in("instance_id", instanceIds)
    .neq("status", "pending");

  if (countError) {
    res.status(500).json({ error: "Failed to count threads" });
    return;
  }

  const total = totalCount ?? threads.length;
  const threadIds = threads.map((t) => t.id);

  // Fetch all executions for these threads
  const { data: executions, error: execsError } = await supabaseAdmin
    .from("agent_executions")
    .select("id, thread_id, instance_id, generation_id, started_at, updated_at, blocked_since, blocking_event_type, blocking_tool_name")
    .in("thread_id", threadIds)
    .order("started_at", { ascending: true });

  if (execsError) {
    res.status(500).json({ error: "Failed to fetch executions" });
    return;
  }

  const allExecs = (executions ?? []) as ExecRow[];
  const allExecIds = allExecs.map((e) => e.id);

  if (allExecIds.length === 0) {
    const result = (threads as ThreadRow[]).map((t) => ({
      id: t.id,
      instance_id: t.instance_id,
      generation_id: null,
      conversation_id: t.conversation_id,
      session_id: t.conversation_id,
      session_ended_at: t.session_ended_at,
      status: t.status,
      started_at: t.started_at,
      updated_at: t.updated_at,
      prompt: t.prompt,
      model: null,
      workspace_roots: null,
      blocked_since: null,
      blocking_event_type: null,
      blocking_tool_name: null,
      events: [],
    }));
    res.json({ executions: result, total, limit, offset });
    return;
  }

  // Fetch all events for these executions
  const { data: events, error: eventsError } = await supabaseAdmin
    .from("cursor_events")
    .select("id, instance_id, execution_id, event_type, semantic_type, payload, created_at")
    .in("execution_id", allExecIds)
    .order("created_at", { ascending: true });

  if (eventsError) {
    res.status(500).json({ error: "Failed to fetch execution events" });
    return;
  }

  const eventsByExecution = new Map<string, unknown[]>();
  for (const event of events ?? []) {
    const eid = (event as { execution_id: string }).execution_id;
    if (!eventsByExecution.has(eid)) eventsByExecution.set(eid, []);
    eventsByExecution.get(eid)!.push(event);
  }

  // Build one response object per thread
  const result = (threads as ThreadRow[]).map((t) => {
    const threadExecs = allExecs.filter((e) => e.thread_id === t.id);
    const latestExec = threadExecs.reduce(
      (l, e) => (e.updated_at > l.updated_at ? e : l),
      threadExecs[0]
    );
    const startedAt = threadExecs.reduce(
      (min, e) => (e.started_at < min ? e.started_at : min),
      threadExecs[0].started_at
    );
    const mergedEvents = threadExecs
      .flatMap((e) => (eventsByExecution.get(e.id) ?? []) as Array<{ created_at: string }>)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    return {
      id: t.id,
      instance_id: t.instance_id,
      generation_id: latestExec?.generation_id ?? null,
      conversation_id: t.conversation_id,
      session_id: t.conversation_id,
      session_ended_at: t.session_ended_at,
      status: t.status,
      started_at: startedAt,
      updated_at: t.updated_at,
      prompt: t.prompt,
      model: null,
      workspace_roots: null,
      blocked_since: latestExec?.blocked_since ?? null,
      blocking_event_type: latestExec?.blocking_event_type ?? null,
      blocking_tool_name: latestExec?.blocking_tool_name ?? null,
      events: mergedEvents,
    };
  });

  res.json({ executions: result, total, limit, offset });
});

/**
 * DELETE /api/executions/:id
 * Deletes a thread by id (cascades to executions and events). Verifies ownership.
 */
router.delete("/:id", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const { id } = req.params;

  const { data: thread, error: fetchError } = await supabaseAdmin
    .from("threads")
    .select("id, instance_id")
    .eq("id", id)
    .single();

  if (fetchError || !thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const { data: inst, error: instError } = await supabase
    .from("cursor_instances")
    .select("id")
    .eq("id", (thread as { instance_id: string }).instance_id)
    .single();

  if (instError || !inst) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { error: deleteError } = await supabaseAdmin
    .from("threads")
    .delete()
    .eq("id", id);

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete thread" });
    return;
  }

  res.status(204).send();
});

/**
 * DELETE /api/executions
 * Bulk-delete: all for user, or scoped to instance_id, or to conversation_id (+ instance_id).
 * Query: instance_id?, conversation_id? (conversation_id requires instance_id).
 */
router.delete("/", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const supabase = getSupabaseForUser(res.locals.accessToken);
  const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;
  const conversationId = typeof req.query.conversation_id === "string" ? req.query.conversation_id : undefined;
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
  const effectiveConversationId = conversationId ?? sessionId;

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
    .from("threads")
    .delete({ count: "exact" })
    .in("instance_id", instanceIds);
  if (effectiveConversationId != null) {
    query = query.eq("conversation_id", effectiveConversationId);
  }
  const { error: deleteError, count } = await query;

  if (deleteError) {
    res.status(500).json({ error: "Failed to delete threads" });
    return;
  }

  res.json({ deleted: count ?? 0 });
});

export default router;
