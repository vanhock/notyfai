import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { supabaseAdmin } from "../lib/supabase.js";
import { verifyAndGetInstanceId } from "../lib/token.js";
import {
  normalizeEventType,
  toSemanticType,
  PERMISSION_BEARING_HOOKS,
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

const hookRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 150,
  keyGenerator: (req) => {
    const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (token && typeof token === "string") {
      const verified = verifyAndGetInstanceId(token);
      if (verified) return `instance:${verified.instanceId}`;
    }
    return ipKeyGenerator(req.ip ?? "0.0.0.0");
  },
  handler: (_req, res) => {
    console.warn("[hooks] rate limit exceeded");
    res.status(429).json({ error: "Too many requests. Slow down." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const requestCounts = new Map<string, { count: number; windowStart: number }>();
const ABUSE_WINDOW_MS = 60 * 60 * 1000;
const ABUSE_THRESHOLD = 200;

function trackAndCheckAbuse(instanceId: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(instanceId);
  if (!entry || now - entry.windowStart > ABUSE_WINDOW_MS) {
    requestCounts.set(instanceId, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > ABUSE_THRESHOLD;
}

/** Debounce window (ms) before sending push for permission-based agentBlocked. */
const BLOCKING_PUSH_DEBOUNCE_MS = 15_000;

/** If a tool run has no follow-up event for this long, treat as blocking and notify. */
const TOOL_RUN_BLOCKING_THRESHOLD_MS = 5 * 60 * 1000;

/** Keyed by execution_id — debounced push for agentBlocked events. */
const pendingNotifications = new Map<string, NodeJS.Timeout>();

/** Keyed by execution_id — timeout to treat long-running tool (no after* in 5 min) as blocking. */
const pendingStaleBlockingTimeouts = new Map<string, NodeJS.Timeout>();

function cancelPending(executionId: string): void {
  const existing = pendingNotifications.get(executionId);
  if (existing) {
    clearTimeout(existing);
    pendingNotifications.delete(executionId);
  }
}

function cancelStaleBlockingTimeout(executionId: string): void {
  const existing = pendingStaleBlockingTimeouts.get(executionId);
  if (existing) {
    clearTimeout(existing);
    pendingStaleBlockingTimeouts.delete(executionId);
  }
}

/**
 * Resolves the semantic type for an event, applying the permission override
 * for hooks that carry a permission field (before*Execution, beforeReadFile, etc.).
 * Blocking (agentBlocked) only when permission is explicitly "deny" or "ask".
 * - permission "ask" | "deny" → agentBlocked (blocking, push)
 * - permission "allow" | undefined (not specified) → toolStart (not blocking)
 */
function resolveSemanticType(
  eventType: CursorEventType | "unknown",
  payload: CursorHookPayload
): SemanticEventType {
  const base = toSemanticType(eventType);
  if (base === "agentBlocked" && PERMISSION_BEARING_HOOKS.has(eventType as CursorEventType)) {
    const perm = payload.permission;
    if (perm === "ask" || perm === "deny") return "agentBlocked";
    return "toolStart"; // allow or undefined
  }
  return base;
}

/** Returns true if this event is a "blocking" one (agent waiting for user action). */
function isBlockingEvent(semanticType: SemanticEventType): boolean {
  return semanticType === "agentBlocked";
}

/** Before* hooks: agent is in a blocking window until matching after* or stop. */
const BEFORE_BLOCKING_HOOKS = new Set<CursorEventType>([
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeTabFileRead",
]);

/** After* hooks: end the blocking window for the current tool call. */
const AFTER_BLOCKING_HOOKS = new Set<CursorEventType>([
  "afterShellExecution",
  "afterMCPExecution",
  "afterFileEdit",
  "afterTabFileEdit",
]);

function blockingToolNameFromPayload(
  eventType: CursorEventType | "unknown",
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

  // Forward-only: pending(0) → running(1) → blocked(2) → stopped(3)
  const rank: Record<string, number> = { pending: 0, running: 1, blocked: 2, stopped: 3 };
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

function executionStatusForSemantic(semanticType: SemanticEventType): string {
  switch (semanticType) {
    case "agentBlocked":
      return "blocked";
    case "agentStopped":
      return "stopped";
    case "agentStart":
      return "running";
    default:
      // toolStart, toolResult, agentMessage — no status change (keep running)
      return "running";
  }
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

  if (trackAndCheckAbuse(instanceId)) {
    console.warn("[hooks] auto-revoking instance %s (abuse threshold exceeded)", instanceId);
    await supabaseAdmin.from("cursor_instances").update({ revoked: true }).eq("id", instanceId);
    sendPushNotification(
      instance.user_id,
      "agentStopped",
      { status: "error", hook_event_name: "stop" },
      `Security alert: hook URL for "${instance.name ?? instanceId.slice(0, 8)}" disabled due to suspicious activity.`
    ).catch(() => {});
    res.status(429).json({ error: "Instance auto-revoked due to excessive requests." });
    return;
  }

  const body = req.body as CursorHookPayload | undefined;
  const payload = body && typeof body === "object" ? body : ({} as CursorHookPayload);
  const eventType = normalizeEventType(
    payload.hook_event_name ?? (req.headers["x-cursor-event"] as string)
  );
  const semanticType = resolveSemanticType(eventType, payload);
  const blocking = isBlockingEvent(semanticType);
  const perm = payload.permission as string | undefined;
  const conversationId = payload.conversation_id as string | undefined;

  // Log with clear BLOCKING vs NOT BLOCKING and reason
  const blockingLabel = blocking ? "BLOCKING" : "NOT BLOCKING";
  const reason = PERMISSION_BEARING_HOOKS.has(eventType as CursorEventType)
    ? `eventType=${eventType} permission=${perm ?? "(undefined)"} → semanticType=${semanticType}`
    : `eventType=${eventType} → semanticType=${semanticType}`;
  console.log(
    "[hooks] %s | instanceId=%s userId=%s | %s",
    blockingLabel,
    instanceId,
    instance.user_id,
    reason
  );

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
  const generationId = payload.generation_id as string | undefined;

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

  let targetStatus = executionStatusForSemantic(semanticType);
  // subagentStop is a sub-thread ending, not the main agent stop — never set execution to stopped
  if (eventType === "subagentStop" && targetStatus === "stopped") {
    targetStatus = "running";
  }
  // Blocking window: before* → status=blocked and set timer; after* or stop → clear timer
  if (BEFORE_BLOCKING_HOOKS.has(eventType as CursorEventType)) {
    targetStatus = "blocked";
  } else if (AFTER_BLOCKING_HOOKS.has(eventType as CursorEventType)) {
    targetStatus = "running";
  }
  if (eventType === "stop") {
    targetStatus = "stopped";
  }
  if (targetStatus === "blocked") {
    console.log("[hooks] execution status → blocked (before* window); push will be sent after debounce if permission ask/deny");
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
      targetStatus,
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

  // Blocking timer: set blocked_since on before*; clear on after* or stop
  if (BEFORE_BLOCKING_HOOKS.has(eventType as CursorEventType)) {
    const blockingToolName = blockingToolNameFromPayload(eventType as CursorEventType, payload);
    await supabaseAdmin
      .from("agent_executions")
      .update({
        blocked_since: new Date().toISOString(),
        blocking_event_type: eventType,
        blocking_tool_name: blockingToolName,
      })
      .eq("id", executionId);

    // If not already permission-based blocking, treat long tool run (no after* in 5 min) as blocking
    if (semanticType !== "agentBlocked") {
      cancelStaleBlockingTimeout(executionId);
      const timeout = setTimeout(async () => {
        pendingStaleBlockingTimeouts.delete(executionId);
        const { data: row } = await supabaseAdmin
          .from("agent_executions")
          .select("id, blocked_since, blocking_event_type, blocking_tool_name")
          .eq("id", executionId)
          .single();
        if (row?.blocked_since) {
          await supabaseAdmin.from("agent_executions").update({ status: "blocked" }).eq("id", executionId);
          console.log("[hooks] tool run > 5 min with no follow-up → marking blocked and sending push executionId=%s", executionId);
          const stalePayload: CursorHookPayload = {
            ...payload,
            hook_event_name: row.blocking_event_type,
            tool_name: (row.blocking_tool_name ?? payload.tool_name) as string | undefined,
            permission: "ask",
          };
          sendPushNotification(instance.user_id, "agentBlocked", stalePayload, instance.name, executionId).catch((err) => {
            console.error("[hooks] sendPushNotification (stale blocking) error:", err);
          });
        }
      }, TOOL_RUN_BLOCKING_THRESHOLD_MS);
      pendingStaleBlockingTimeouts.set(executionId, timeout);
    }
  } else if (AFTER_BLOCKING_HOOKS.has(eventType as CursorEventType) || eventType === "stop") {
    cancelStaleBlockingTimeout(executionId);
    const clearUpdate: { blocked_since: null; blocking_event_type: null; blocking_tool_name: null; status?: string } = {
      blocked_since: null,
      blocking_event_type: null,
      blocking_tool_name: null,
    };
    // After* ends the block and returns to running; stop is already set by upsertExecution
    if (AFTER_BLOCKING_HOOKS.has(eventType as CursorEventType)) {
      clearUpdate.status = "running";
    }
    await supabaseAdmin.from("agent_executions").update(clearUpdate).eq("id", executionId);
  }

  await supabaseAdmin
    .from("cursor_instances")
    .update({ last_event_at: new Date().toISOString() })
    .eq("id", instanceId);

  res.status(202).json({ ok: true });

  // Notification filter check
  const filters = instance.notification_filters;
  if (filters !== null && !filters.includes(eventType) && !filters.includes(semanticType)) {
    console.log("[hooks] notification suppressed by filter for event type: %s", eventType);
    return;
  }

  cancelPending(executionId);

  if (semanticType === "agentStopped") {
    sendPushNotification(instance.user_id, semanticType, payload, instance.name, executionId).catch((err) => {
      console.error("[hooks] sendPushNotification error:", err);
    });
  } else if (semanticType === "agentBlocked") {
    console.log("[hooks] BLOCKING: scheduling push notification in 15s for executionId=%s", executionId);
    const timeout = setTimeout(() => {
      pendingNotifications.delete(executionId);
      sendPushNotification(instance.user_id, semanticType, payload, instance.name, executionId).catch((err) => {
        console.error("[hooks] sendPushNotification (debounced) error:", err);
      });
    }, BLOCKING_PUSH_DEBOUNCE_MS);
    pendingNotifications.set(executionId, timeout);
  }
});

export default router;
