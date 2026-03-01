import { getMessaging } from "firebase-admin/messaging";
import { supabaseAdmin } from "./supabase.js";
import { getFirebaseApp } from "./firebase.js";
import type { CursorEventType } from "../types/cursor.js";

type NotificationContent = { title: string; body: string };

function getNotificationContent(
  eventType: CursorEventType | "unknown",
  instanceName: string | null
): NotificationContent {
  const body = instanceName || "Cursor";
  switch (eventType) {
    case "stop":
      return { title: "Cursor stopped", body };
    case "beforeShellExecution":
    case "beforeMCPExecution":
      return { title: "Cursor awaiting for action", body };
    default:
      return { title: "Cursor event", body };
  }
}

/** Tracks the last time a notification was sent per instance (for throttling). */
const lastNotificationSentAt = new Map<string, number>();

/** Minimum ms between push notifications for the same instance. */
const NOTIFICATION_THROTTLE_MS = 5_000;

export async function sendPushNotification(
  userId: string,
  eventType: CursorEventType | "unknown",
  instanceName: string | null,
  instanceId?: string
): Promise<void> {
  // Throttle: skip FCM if a notification was sent too recently for this instance
  if (instanceId) {
    const last = lastNotificationSentAt.get(instanceId);
    if (last !== undefined && Date.now() - last < NOTIFICATION_THROTTLE_MS) {
      console.log("[notifications] throttled push for instance %s (last sent %dms ago)", instanceId, Date.now() - last);
      return;
    }
    lastNotificationSentAt.set(instanceId, Date.now());
  }

  const { data: tokens, error } = await supabaseAdmin
    .from("push_tokens")
    .select("id, token, platform")
    .eq("user_id", userId);

  if (error) {
    console.warn("[notifications] push_tokens lookup failed for user", userId, error.message);
    return;
  }
  if (!tokens || tokens.length === 0) {
    console.warn("[notifications] no push tokens for user", userId, "- register a device in the app to receive notifications");
    return;
  }

  const { title, body } = getNotificationContent(eventType, instanceName);
  const messaging = getMessaging(getFirebaseApp());
  const staleIds: string[] = [];

  console.log("[notifications] sending push to", tokens.length, "device(s) for user", userId, "event:", eventType);

  await Promise.allSettled(
    tokens.map(async ({ id, token, platform }: { id: string; token: string; platform: string }) => {
      try {
        await messaging.send({
          token,
          notification: { title, body },
          apns: platform === "ios" ? { payload: { aps: { sound: "default" } } } : undefined,
          android: platform === "android" ? { notification: { sound: "default" } } : undefined,
        });
      } catch (err: unknown) {
        const code = (err as { errorInfo?: { code?: string } })?.errorInfo?.code;
        if (code === "messaging/registration-token-not-registered") {
          staleIds.push(id);
        } else {
          console.error("[notifications] FCM send error for token %s: %o", token.slice(0, 20), err);
        }
      }
    })
  );

  if (staleIds.length > 0) {
    await supabaseAdmin.from("push_tokens").delete().in("id", staleIds);
    console.log("[notifications] Removed %d stale token(s)", staleIds.length);
  }
}
