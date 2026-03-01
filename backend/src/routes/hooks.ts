import { Router, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { supabaseAdmin } from "../lib/supabase.js";
import { verifyAndGetInstanceId } from "../lib/token.js";
import { normalizeEventType, type CursorHookPayload } from "../types/cursor.js";
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

const pendingNotifications = new Map<string, NodeJS.Timeout>();

function cancelPending(instanceId: string): void {
  const existing = pendingNotifications.get(instanceId);
  if (existing) {
    clearTimeout(existing);
    pendingNotifications.delete(instanceId);
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
      "unknown",
      `Security alert: hook URL for "${instance.name ?? instanceId.slice(0, 8)}" was disabled due to suspicious activity.`,
      instanceId
    ).catch(() => {});
    res.status(429).json({ error: "Instance auto-revoked due to excessive requests." });
    return;
  }

  const body = req.body as CursorHookPayload | undefined;
  const payload = body && typeof body === "object" ? body : {};
  const eventType = normalizeEventType(
    payload.hook_event_name ?? (req.headers["x-cursor-event"] as string)
  );

  console.log("[hooks] event received instanceId=%s userId=%s eventType=%s", instanceId, instance.user_id, eventType);

  const { error: insertError } = await supabaseAdmin.from("cursor_events").insert({
    instance_id: instanceId,
    event_type: eventType,
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

  const filters = instance.notification_filters;
  if (filters !== null && !filters.includes(eventType)) {
    console.log("[hooks] notification suppressed by filter for event type: %s", eventType);
    return;
  }

  cancelPending(instanceId);

  if (eventType === "stop") {
    sendPushNotification(instance.user_id, eventType, instance.name, instanceId).catch((err) => {
      console.error("[hooks] sendPushNotification error:", err);
    });
  } else if (eventType === "beforeShellExecution" || eventType === "beforeMCPExecution") {
    const timeout = setTimeout(() => {
      pendingNotifications.delete(instanceId);
      sendPushNotification(instance.user_id, eventType, instance.name, instanceId).catch((err) => {
        console.error("[hooks] sendPushNotification (debounced) error:", err);
      });
    }, 15_000);
    pendingNotifications.set(instanceId, timeout);
  } else {
    sendPushNotification(instance.user_id, eventType, instance.name, instanceId).catch((err) => {
      console.error("[hooks] sendPushNotification error:", err);
    });
  }
});

export default router;
