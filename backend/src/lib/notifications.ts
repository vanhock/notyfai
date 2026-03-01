import { getMessaging } from "firebase-admin/messaging";
import { supabaseAdmin } from "./supabase.js";
import { getFirebaseApp } from "./firebase.js";
import type { CursorHookPayload, SemanticEventType } from "../types/cursor.js";

type NotificationContent = { title: string; body: string };

function truncate(str: string, max: number): string {
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function getMcpServer(payload: CursorHookPayload): string {
  const urlOrCmd = (payload.url ?? payload.command) as string | undefined;
  if (!urlOrCmd) return "";
  // For URL-based servers show just the host; for command-based show the binary name
  try {
    return new URL(urlOrCmd).host;
  } catch {
    return urlOrCmd.split(/[\s/\\]/).find(Boolean) ?? urlOrCmd;
  }
}

function getNotificationContent(
  semanticType: SemanticEventType,
  payload: CursorHookPayload,
  instanceName: string | null
): NotificationContent {
  const name = instanceName ?? "Cursor";

  switch (semanticType) {
    case "agentBlocked": {
      if (payload.hook_event_name === "beforeMCPExecution" || payload.tool_name) {
        const tool = (payload.tool_name as string | undefined) ?? "MCP tool";
        const server = getMcpServer(payload);
        return {
          title: `Awaiting: ${tool}`,
          body: server ? `${server} — ${name}` : name,
        };
      }
      // beforeShellExecution
      const cmd = typeof payload.command === "string" ? payload.command : "";
      return {
        title: "Awaiting shell action",
        body: cmd ? `${truncate(cmd, 60)} — ${name}` : name,
      };
    }

    case "agentStopped": {
      const stopStatus = typeof payload.status === "string" ? payload.status : "";
      const label =
        stopStatus === "aborted"
          ? "Aborted"
          : stopStatus === "error"
            ? "Error"
            : "Completed";
      return { title: "Agent stopped", body: `${label} — ${name}` };
    }

    default:
      return { title: "Cursor event", body: name };
  }
}

/** Tracks the last time a notification was sent per execution (for throttling). */
const lastNotificationSentAt = new Map<string, number>();

/** Minimum ms between push notifications for the same execution. */
const NOTIFICATION_THROTTLE_MS = 5_000;

export async function sendPushNotification(
  userId: string,
  semanticType: SemanticEventType,
  payload: CursorHookPayload,
  instanceName: string | null,
  executionId?: string
): Promise<void> {
  const throttleKey = executionId ?? userId;
  const last = lastNotificationSentAt.get(throttleKey);
  if (last !== undefined && Date.now() - last < NOTIFICATION_THROTTLE_MS) {
    console.log("[notifications] throttled push for execution %s (last sent %dms ago)", throttleKey, Date.now() - last);
    return;
  }
  lastNotificationSentAt.set(throttleKey, Date.now());

  const { data: tokens, error } = await supabaseAdmin
    .from("push_tokens")
    .select("id, token, platform")
    .eq("user_id", userId);

  if (error) {
    console.warn("[notifications] push_tokens lookup failed for user", userId, error.message);
    return;
  }
  if (!tokens || tokens.length === 0) {
    console.warn("[notifications] no push tokens for user", userId, "- register a device in the app");
    return;
  }

  const { title, body } = getNotificationContent(semanticType, payload, instanceName);
  const messaging = getMessaging(getFirebaseApp());
  const staleIds: string[] = [];

  console.log("[notifications] sending push to", tokens.length, "device(s) for user", userId, "semantic:", semanticType);

  await Promise.allSettled(
    tokens.map(async ({ id, token, platform }: { id: string; token: string; platform: string }) => {
      try {
        await messaging.send({
          token,
          notification: { title, body },
          apns: {
            headers: executionId ? { "apns-thread-id": executionId } : undefined,
            payload: { aps: { sound: "default" } },
          },
          android: {
            notification: {
              tag: executionId,
              sound: "default",
            },
          },
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
    console.log("[notifications] removed %d stale token(s)", staleIds.length);
  }
}
