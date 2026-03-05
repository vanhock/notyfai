import { Router, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { supabaseAdmin } from "../lib/supabase.js";
import { verifyAndGetInstanceId } from "../lib/token.js";
import {
  normalizeEventType,
  toSemanticType,
  type CursorHookPayload,
  type CursorEventType,
  type SemanticEventType,
} from "../types/cursor.js";
import { sendPushNotification } from "../lib/notifications.js";

const router = Router();

type HookInstance = {
  id: string;
  revoked: boolean;
  user_id: string;
  name: string | null;
  token_version: number;
  notification_filters: string[] | null;
};

const HOOK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const HOOK_RATE_LIMIT_MAX = 2000;

const hookRateLimit = rateLimit({
  windowMs: HOOK_RATE_LIMIT_WINDOW_MS,
  max: HOOK_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (token && typeof token === "string") {
      const verified = verifyAndGetInstanceId(token);
      if (verified) return `instance:${verified.instanceId}`;
    }
    return ipKeyGenerator(req.ip ?? "0.0.0.0");
  },
  handler: (req, res) => {
    const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    let key = "ip:" + (req.ip ?? "0.0.0.0");
    if (token && typeof token === "string") {
      const verified = verifyAndGetInstanceId(token);
      if (verified) key = `instance:${verified.instanceId}`;
    }
    const windowMin = HOOK_RATE_LIMIT_WINDOW_MS / 60000;
    console.warn(
      "[hooks] RATE LIMIT EXCEEDED | key=%s | limit=%d requests per %d min | window resets in ~%d min, then requests will be accepted again",
      key,
      HOOK_RATE_LIMIT_MAX,
      windowMin,
      windowMin
    );
    res.status(429).json({
      error: "Too many requests. Slow down.",
      retry_after_minutes: windowMin,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** If no hook activity for this long, treat execution as blocking and notify. */
const TOOL_RUN_BLOCKING_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * Event types that count as "activity" for the blocking timer.
 * Only these events reset the 3-min inactivity timer; other events are ignored for blocking.
 * Should align with the hooks you send from Cursor (e.g. .cursor/hooks.json).
 */
const BLOCKING_ACTIVITY_EVENT_TYPES = new Set<CursorEventType | "unknown">([
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
]);

function isBlockingActivityEvent(eventType: CursorEventType | "unknown"): boolean {
  return BLOCKING_ACTIVITY_EVENT_TYPES.has(eventType);
}

function blockingToolNameFromPayload(
  _eventType: CursorEventType | "unknown",
  payload: CursorHookPayload
): string | null {
  const toolName = payload.tool_name;
  if (typeof toolName === "string" && toolName.length > 0) return toolName;
  const command = payload.command;
  if (typeof command === "string" && command.length > 0) return command;
  const filePath = payload.file_path;
  if (typeof filePath === "string" && filePath.length > 0) return filePath;
  return null;
}

/**
 * Schedules a blocking check in the DB (blocking_check_at = now + 3 min).
 * A background worker picks up due executions and sends the push; survives restarts.
 */
async function scheduleBlockingCheck(
  executionId: string,
  _userId: string,
  _instanceId: string,
  _instanceName: string | null,
  eventType: CursorEventType | "unknown",
  payload: CursorHookPayload
): Promise<void> {
  const toolName = blockingToolNameFromPayload(eventType, payload);
  const checkAt = new Date(Date.now() + TOOL_RUN_BLOCKING_THRESHOLD_MS).toISOString();
  await supabaseAdmin
    .from("agent_executions")
    .update({
      blocking_check_at: checkAt,
      blocking_event_type: eventType as string,
      blocking_tool_name: toolName,
      blocking_payload: payload as Record<string, unknown>,
    })
    .eq("id", executionId);
}

type ExecutionMetadata = {
  prompt?: string;
  model?: string;
  workspace_roots?: string[] | null;
};

/**
 * Upsert an agent_execution row for (instance_id, generation_id).
 * sessionId (Cursor session_id, same as conversation_id) groups all turns in one composer conversation.
 * Returns { executionId, isNew }.
 * initialStatus is only used on INSERT; existing rows advance forward-only.
 * metadata: prompt/model/workspace_roots stored on INSERT; on UPDATE, only backfill null columns.
 */
async function upsertExecution(
  instanceId: string,
  generationId: string,
  conversationId: string | undefined,
  status: string,
  initialStatus: string = "running",
  sessionId?: string,
  metadata?: ExecutionMetadata
): Promise<{ executionId: string; isNew: boolean }> {
  const effectiveSessionId = sessionId ?? conversationId ?? null;
  const insertRow: Record<string, unknown> = {
    instance_id: instanceId,
    generation_id: generationId,
    conversation_id: conversationId ?? null,
    session_id: effectiveSessionId,
    status: initialStatus,
  };
  if (metadata?.prompt !== undefined) insertRow.prompt = metadata.prompt;
  if (metadata?.model !== undefined) insertRow.model = metadata.model;
  if (metadata?.workspace_roots !== undefined) insertRow.workspace_roots = metadata.workspace_roots;

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("agent_executions")
    .insert(insertRow)
    .select("id")
    .single();

  if (!insertError && inserted) {
    return { executionId: inserted.id as string, isNew: true };
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("agent_executions")
    .select("id, status, prompt, model, workspace_roots")
    .eq("instance_id", instanceId)
    .eq("generation_id", generationId)
    .single();

  if (fetchError || !existing) {
    throw new Error(`[hooks] failed to upsert execution: ${fetchError?.message ?? "unknown"}`);
  }

  const executionId = existing.id as string;

  // Forward-only: pending(0) → running(1) → stopped(2); blocked is a temporary state, not ranked
  const rank: Record<string, number> = { pending: 0, running: 1, stopped: 2 };
  const updates: {
    status?: string;
    updated_at: string;
    session_id?: string | null;
    model?: string;
    workspace_roots?: string[] | null;
  } = {
    updated_at: new Date().toISOString(),
  };
  if (effectiveSessionId !== null) updates.session_id = effectiveSessionId;
  if ((rank[status] ?? -1) > (rank[existing.status as string] ?? -1)) {
    updates.status = status;
  }
  // Backfill metadata only when still null
  if (metadata?.model != null && existing.model == null) updates.model = metadata.model;
  if (metadata?.workspace_roots != null && existing.workspace_roots == null) {
    updates.workspace_roots = metadata.workspace_roots;
  }
  await supabaseAdmin.from("agent_executions").update(updates).eq("id", executionId);

  return { executionId, isNew: false };
}


router.post("/cursor", hookRateLimit, async (req: Request, res: Response): Promise<void> => {
  const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  if (!token || typeof token !== "string") {
    res.status(401).json({ error: "Missing token" });
    return;
  }

  const verified = verifyAndGetInstanceId(token);
  if (!verified) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const { instanceId, tokenVersion } = verified;

  const { data, error: fetchError } = await supabaseAdmin
    .from("cursor_instances")
    .select("id, revoked, user_id, name, token_version, notification_filters")
    .eq("id", instanceId)
    .single();

  if (fetchError || !data) {
    console.warn("[hooks] instance not found", instanceId);
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const instance = data as HookInstance;

  if (instance.revoked) {
    res.status(410).json({ error: "Instance revoked" });
    return;
  }

  if (tokenVersion !== instance.token_version) {
    console.warn("[hooks] stale token version (token=%d db=%d)", tokenVersion, instance.token_version);
    res.status(401).json({ error: "Token has been rotated. Please update your hook URL." });
    return;
  }

  const body = req.body as CursorHookPayload | undefined;
  const payload = body && typeof body === "object" ? body : ({} as CursorHookPayload);
  const rawEventName = (payload.hook_event_name ?? req.headers["x-cursor-event"]) as string | undefined;
  if (
    rawEventName === "beforeReadFile" ||
    rawEventName === "beforeTabFileRead" ||
    rawEventName === "afterFileEdit"
  ) {
    res.status(202).json({ ok: true });
    return;
  }
  const eventType = normalizeEventType(rawEventName);
  const semanticType = toSemanticType(eventType);
  const conversationId = payload.conversation_id as string | undefined;
  const generationId = payload.generation_id as string | undefined;

  console.log(
    "[hooks] instanceId=%s userId=%s | eventType=%s semanticType=%s | conv=%s gen=%s",
    instanceId,
    instance.user_id,
    eventType,
    semanticType,
    conversationId ?? "(none)",
    generationId ?? "(none)"
  );

  // ——— subagentStart / subagentStop or tool events: associate with parent, don't create new row ———
  const isSubagentOrToolEvent = [
    "subagentStart",
    "subagentStop",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "afterAgentThought",
  ].includes(eventType);

  if (isSubagentOrToolEvent) {
    // Find the most recently updated active execution for this instance
    const { data: parentExec } = await supabaseAdmin
      .from("agent_executions")
      .select("id")
      .eq("instance_id", instanceId)
      .in("status", ["running", "blocked"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (parentExec) {
      console.log("[hooks] associating %s with parent executionId=%s", eventType, parentExec.id);
      
      await supabaseAdmin.from("cursor_events").insert({
        instance_id: instanceId,
        execution_id: parentExec.id,
        event_type: eventType,
        semantic_type: semanticType,
        payload,
      });

      await supabaseAdmin
        .from("cursor_instances")
        .update({ last_event_at: new Date().toISOString() })
        .eq("id", instanceId);

      if (isBlockingActivityEvent(eventType)) {
        scheduleBlockingCheck(parentExec.id, instance.user_id, instanceId, instance.name, eventType, payload);
      }

      res.status(202).json({ ok: true });
      return;
    } else {
      console.log("[hooks] %s: no active parent found — storing as orphan", eventType);
      await supabaseAdmin.from("cursor_events").insert({
        instance_id: instanceId,
        execution_id: null,
        event_type: eventType,
        semantic_type: semanticType,
        payload,
      });
      res.status(202).json({ ok: true });
      return;
    }
  }

  // ——— sessionStart: create a pending session slot (session_id from Cursor = one composer conversation)
  if (eventType === "sessionStart") {
    const sessionId = payload.session_id as string | undefined;
    if (!sessionId) {
      console.warn("[hooks] sessionStart missing session_id — skipping");
      res.status(202).json({ ok: true });
      return;
    }
    // One row per session: generation_id = session_id so (instance_id, generation_id) is unique
    try {
      await upsertExecution(
        instanceId,
        sessionId,
        sessionId,
        "pending",
        "pending",
        sessionId
      );
    } catch (err) {
      console.error("[hooks] sessionStart upsert failed:", err);
      res.status(500).json({ error: "Failed to track execution" });
      return;
    }

    await supabaseAdmin
      .from("cursor_instances")
      .update({ last_event_at: new Date().toISOString() })
      .eq("id", instanceId);

    res.status(202).json({ ok: true });
    return;
  }

  // ——— sessionEnd: mark all executions in this session as ended ———
  if (eventType === "sessionEnd") {
    const sessionId = payload.session_id as string | undefined;
    if (sessionId) {
      await supabaseAdmin
        .from("agent_executions")
        .update({ session_ended_at: new Date().toISOString() })
        .eq("instance_id", instanceId)
        .eq("session_id", sessionId);
    }
    await supabaseAdmin
      .from("cursor_instances")
      .update({ last_event_at: new Date().toISOString() })
      .eq("id", instanceId);
    res.status(202).json({ ok: true });
    return;
  }

  // ——— All other events require generation_id to associate with a thread ———

  if (!generationId) {
    console.warn("[hooks] %s missing generation_id — storing orphan event", eventType);
    await supabaseAdmin.from("cursor_events").insert({
      instance_id: instanceId,
      execution_id: null,
      event_type: eventType,
      semantic_type: semanticType,
      payload,
    });
    res.status(202).json({ ok: true });
    return;
  }

  // Tab events (afterTabFileEdit): no reaction — do not store or update.
  if (eventType === "afterTabFileEdit") {
    console.log("[hooks] %s — tab event, no reaction", eventType);
    res.status(202).json({ ok: true });
    return;
  }

  // ——— beforeSubmitPrompt: advance thread pending→running, insert agentStart ———
  if (eventType === "beforeSubmitPrompt") {
    const prompt =
      typeof payload.prompt === "string" ? payload.prompt : undefined;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    const workspaceRoots = Array.isArray(payload.workspace_roots)
      ? payload.workspace_roots
      : undefined;
    let executionId: string;
    try {
      const result = await upsertExecution(
        instanceId,
        generationId,
        conversationId,
        "running",
        "running",
        conversationId,
        { prompt, model, workspace_roots: workspaceRoots }
      );
      executionId = result.executionId;
    } catch (err) {
      console.error("[hooks] beforeSubmitPrompt upsert failed:", err);
      res.status(500).json({ error: "Failed to track execution" });
      return;
    }

    await supabaseAdmin.from("cursor_events").insert({
      instance_id: instanceId,
      execution_id: executionId,
      event_type: eventType,
      semantic_type: "agentStart",
      payload,
    });

    await supabaseAdmin
      .from("cursor_instances")
      .update({ last_event_at: new Date().toISOString() })
      .eq("id", instanceId);

    if (isBlockingActivityEvent(eventType)) {
      scheduleBlockingCheck(executionId, instance.user_id, instanceId, instance.name, eventType, payload);
    }
    res.status(202).json({ ok: true });
    return;
  }

  // ——— All other events: upsert thread, insert cursor_event ———

  // Tab events (beforeTabFileRead, afterTabFileEdit) and any event without a conversation_id
  // are not part of an agent session — store the cursor_event only, no execution row.
  if (!conversationId) {
    console.log("[hooks] %s missing conversation_id — storing orphan event (no execution row)", eventType);
    await supabaseAdmin.from("cursor_events").insert({
      instance_id: instanceId,
      execution_id: null,
      event_type: eventType,
      semantic_type: semanticType,
      payload,
    });
    await supabaseAdmin
      .from("cursor_instances")
      .update({ last_event_at: new Date().toISOString() })
      .eq("id", instanceId);
    res.status(202).json({ ok: true });
    return;
  }

  // stop is handled here: cancel inactivity timer, mark stopped, send push
  if (eventType === "stop") {
    let executionId: string;
    try {
      const result = await upsertExecution(
        instanceId, generationId, conversationId, "stopped", "running", conversationId
      );
      executionId = result.executionId;
    } catch (err) {
      console.error("[hooks] stop upsert failed:", err);
      res.status(500).json({ error: "Failed to track execution" });
      return;
    }
    await supabaseAdmin
      .from("agent_executions")
      .update({
        blocked_since: null,
        blocking_event_type: null,
        blocking_tool_name: null,
        blocking_check_at: null,
        blocking_payload: null,
      })
      .eq("id", executionId);
    await supabaseAdmin.from("cursor_events").insert({
      instance_id: instanceId,
      execution_id: executionId,
      event_type: eventType,
      semantic_type: semanticType,
      payload,
    });
    await supabaseAdmin
      .from("cursor_instances")
      .update({ last_event_at: new Date().toISOString() })
      .eq("id", instanceId);
    res.status(202).json({ ok: true });
    const filters = instance.notification_filters;
    if (filters !== null && !filters.includes(eventType) && !filters.includes(semanticType)) {
      console.log("[hooks] notification suppressed by filter for event type: %s", eventType);
      return;
    }
    const stopStatus = typeof payload.status === "string" ? payload.status : "";
    const finalStatus = typeof payload.final_status === "string" ? payload.final_status : "";
    const isAborted =
      stopStatus.toLowerCase() === "aborted" || finalStatus.toLowerCase() === "aborted";
    if (!isAborted) {
      sendPushNotification(instance.user_id, "agentStopped", payload, instance.name, instanceId, executionId).catch((err) => {
        console.error("[hooks] sendPushNotification error:", err);
      });
    }
    return;
  }

  const model = typeof payload.model === "string" ? payload.model : undefined;
  const workspaceRoots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots
    : undefined;
  const metadata: ExecutionMetadata = {};
  if (model != null) metadata.model = model;
  if (workspaceRoots != null) metadata.workspace_roots = workspaceRoots;

  let executionId: string;
  try {
    const result = await upsertExecution(
      instanceId,
      generationId,
      conversationId,
      "running",
      "running",
      conversationId,
      Object.keys(metadata).length > 0 ? metadata : undefined
    );
    executionId = result.executionId;
  } catch (err) {
    console.error("[hooks] execution upsert failed:", err);
    res.status(500).json({ error: "Failed to track execution" });
    return;
  }

  // Clear any stale blocking state — execution is active again
  await supabaseAdmin
    .from("agent_executions")
    .update({
      status: "running",
      blocked_since: null,
      blocking_event_type: null,
      blocking_tool_name: null,
      blocking_check_at: null,
      blocking_payload: null,
    })
    .eq("id", executionId)
    .neq("status", "stopped");

  const { error: insertError } = await supabaseAdmin.from("cursor_events").insert({
    instance_id: instanceId,
    execution_id: executionId,
    event_type: eventType,
    semantic_type: semanticType,
    payload,
  });

  if (insertError) {
    console.error("[hooks] cursor_events insert error:", insertError);
    res.status(500).json({ error: "Failed to store event" });
    return;
  }

  await supabaseAdmin
    .from("cursor_instances")
    .update({ last_event_at: new Date().toISOString() })
    .eq("id", instanceId);

  res.status(202).json({ ok: true });

  // Reset 3-min inactivity timer only for configured blocking-activity events
  if (isBlockingActivityEvent(eventType)) {
    scheduleBlockingCheck(executionId, instance.user_id, instanceId, instance.name, eventType, payload);
  }
});

export default router;
