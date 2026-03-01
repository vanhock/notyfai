import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { supabaseAdmin } from "../lib/supabase.js";
import { verifyAndGetInstanceId } from "../lib/token.js";
import {
  normalizeEventType,
  toSemanticType,
  type CursorHookPayload,
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
  max: 60,
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

/** Keyed by execution_id — debounced push for agentBlocked events. */
const pendingNotifications = new Map<string, NodeJS.Timeout>();

function cancelPending(executionId: string): void {
  const existing = pendingNotifications.get(executionId);
  if (existing) {
    clearTimeout(existing);
    pendingNotifications.delete(executionId);
  }
}

/**
 * Upsert an agent_execution row for the given (instance_id, generation_id).
 * Returns { executionId, isNew }.
 */
async function upsertExecution(
  instanceId: string,
  generationId: string,
  conversationId: string | undefined,
  status: string
): Promise<{ executionId: string; isNew: boolean }> {
  // Try insert first (most common path)
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("agent_executions")
    .insert({
      instance_id: instanceId,
      generation_id: generationId,
      conversation_id: conversationId ?? null,
      status: "running",
    })
    .select("id")
    .single();

  if (!insertError && inserted) {
    return { executionId: inserted.id as string, isNew: true };
  }

  // Row already exists — fetch it and update status if needed
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("agent_executions")
    .select("id, status")
    .eq("instance_id", instanceId)
    .eq("generation_id", generationId)
    .single();

  if (fetchError || !existing) {
    throw new Error(`[hooks] failed to upsert execution: ${fetchError?.message ?? "unknown"}`);
  }

  const executionId = existing.id as string;

  // Only advance status forward: running → blocked → stopped
  const rank: Record<string, number> = { running: 0, blocked: 1, stopped: 2 };
  if ((rank[status] ?? -1) > (rank[existing.status as string] ?? -1)) {
    await supabaseAdmin
      .from("agent_executions")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", executionId);
  }

  return { executionId, isNew: false };
}

function executionStatusForSemantic(semanticType: SemanticEventType): string {
  switch (semanticType) {
    case "agentBlocked":
      return "blocked";
    case "agentStopped":
      return "stopped";
    default:
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
  const semanticType = toSemanticType(eventType);

  // Use generation_id from payload; fall back to a stable UUID derived from conversation+session for grouping
  const generationId = (payload.generation_id as string | undefined) ?? randomUUID();
  const conversationId = payload.conversation_id as string | undefined;

  console.log(
    "[hooks] event received instanceId=%s userId=%s eventType=%s semanticType=%s generationId=%s",
    instanceId,
    instance.user_id,
    eventType,
    semanticType,
    generationId
  );

  // Upsert the execution thread
  let executionId: string;
  let isNewExecution: boolean;
  try {
    const result = await upsertExecution(
      instanceId,
      generationId,
      conversationId,
      executionStatusForSemantic(semanticType)
    );
    executionId = result.executionId;
    isNewExecution = result.isNew;
  } catch (err) {
    console.error("[hooks] execution upsert failed:", err);
    res.status(500).json({ error: "Failed to track execution" });
    return;
  }

  // If this is a new execution and the first event isn't already agentStart, insert a synthetic agentStart
  if (isNewExecution && semanticType !== "agentStart") {
    await supabaseAdmin.from("cursor_events").insert({
      instance_id: instanceId,
      execution_id: executionId,
      event_type: "sessionStart",
      semantic_type: "agentStart",
      payload: {
        hook_event_name: "sessionStart",
        generation_id: generationId,
        conversation_id: conversationId ?? null,
      },
    });
  }

  // Insert the actual event
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

  // Notification filter check (only applies to push-eligible types)
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
    const timeout = setTimeout(() => {
      pendingNotifications.delete(executionId);
      sendPushNotification(instance.user_id, semanticType, payload, instance.name, executionId).catch((err) => {
        console.error("[hooks] sendPushNotification (debounced) error:", err);
      });
    }, 15_000);
    pendingNotifications.set(executionId, timeout);
  }
});

export default router;
