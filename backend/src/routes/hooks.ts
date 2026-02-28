import { Router, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { verifyAndGetInstanceId } from "../lib/token.js";
import { normalizeEventType, type CursorHookPayload } from "../types/cursor.js";
import { sendPushNotification } from "../lib/notifications.js";

const router = Router();

router.post("/cursor", async (req: Request, res: Response): Promise<void> => {
  console.log("[hooks] POST /cursor received");
  const rawToken = req.query.token ?? req.headers["x-notyfai-token"];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  if (!token || typeof token !== "string") {
    console.warn("[hooks] POST /cursor: missing token");
    res.status(401).json({ error: "Missing token" });
    return;
  }

  const instanceId = verifyAndGetInstanceId(token);
  if (!instanceId) {
    console.warn("[hooks] POST /cursor: invalid token (bad signature or format)");
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const { data: instance, error: fetchError } = await supabaseAdmin
    .from("cursor_instances")
    .select("id, revoked, user_id, name")
    .eq("id", instanceId)
    .single();

  if (fetchError || !instance) {
    console.warn("[hooks] POST /cursor: instance not found", { instanceId, fetchError: fetchError?.message });
    res.status(404).json({ error: "Instance not found" });
    return;
  }
  if (instance.revoked) {
    console.warn("[hooks] POST /cursor: instance revoked", { instanceId });
    res.status(410).json({ error: "Instance revoked" });
    return;
  }

  const body = req.body as CursorHookPayload | undefined;
  const payload = body && typeof body === "object" ? body : {};
  const eventType = normalizeEventType(
    payload.hook_event_name ?? req.headers["x-cursor-event"] as string
  );

  console.log("[hooks] cursor event received", {
    instanceId,
    userId: instance.user_id,
    eventType,
    hasBody: Boolean(body && typeof body === "object"),
  });

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

  // Fire-and-forget: send push notification to all user's devices
  sendPushNotification(instance.user_id, eventType, instance.name ?? null).catch((err) => {
    console.error("[hooks] sendPushNotification error:", err);
  });
});

export default router;
