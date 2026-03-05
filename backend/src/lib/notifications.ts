import { getMessaging } from "firebase-admin/messaging";
import { supabaseAdmin } from "./supabase.js";
import { getFirebaseApp } from "./firebase.js";
import type { CursorHookPayload, SemanticEventType } from "../types/cursor.js";

type NotificationContent = { title: string; body: string };

function truncate(str: string, max: number): string {
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function getNotificationContent(
  semanticType: SemanticEventType,
  payload: CursorHookPayload,
  instanceName: string | null,
  prompt?: string | null
): NotificationContent {
  const name = instanceName ?? "Cursor";

  let title: string;
  let body: string;

  switch (semanticType) {
    case "agentBlocked": {
      title = "Agent waiting";
      const toolName = payload.tool_name as string | undefined;
      const cmd = typeof payload.command === "string" ? payload.command : undefined;
      const context = toolName ?? (cmd ? truncate(cmd, 40) : null) ?? "tool";
      body = `${context} — ${name}`;
      break;
    }

    case "agentStopped": {
      const stopStatus = typeof payload.status === "string" ? payload.status : "";
      const label =
        stopStatus === "aborted"
          ? "Aborted"
          : stopStatus === "error"
            ? "Error"
            : "Completed";
      title = "Agent stopped";
      body = `${label} — ${name}`;
      break;
    }

    default:
      title = "Cursor event";
      body = name;
  }

  // Use original prompt as notification title when available (thread title).
  // Skip for agentBlocked so the title stays "Agent waiting" instead of user message text.
  if (semanticType !== "agentBlocked" && prompt != null && prompt.trim() !== "") {
    return { title: truncate(prompt.trim(), 80), body };
  }
  return { title, body };
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
  instanceId: string,
  executionId?: string,
  threadId?: string
): Promise<void> {
  const throttleKey = threadId ?? executionId ?? userId;
  const last = lastNotificationSentAt.get(throttleKey);
  if (last !== undefined && Date.now() - last < NOTIFICATION_THROTTLE_MS) {
    console.log("[notifications] throttled push for %s (last sent %dms ago)", throttleKey, Date.now() - last);
    return;
  }
  lastNotificationSentAt.set(throttleKey, Date.now());

  let prompt: string | null = null;
  let resolvedThreadId: string | null = null;
  if (executionId) {
    const { data: execRow } = await supabaseAdmin
      .from("agent_executions")
      .select("thread_id")
      .eq("id", executionId)
      .single();
    if (execRow) {
      resolvedThreadId = (execRow as { thread_id: string }).thread_id;
      const { data: threadRow } = await supabaseAdmin
        .from("threads")
        .select("prompt")
        .eq("id", resolvedThreadId)
        .single();
      if (threadRow?.prompt != null) prompt = threadRow.prompt as string;
    }
  }
  const effectiveThreadId = threadId ?? resolvedThreadId;

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

  const { title, body } = getNotificationContent(semanticType, payload, instanceName, prompt);
  const messaging = getMessaging(getFirebaseApp());
  const staleIds: string[] = [];

  console.log("[notifications] sending push to", tokens.length, "device(s) for user", userId, "semantic:", semanticType);

  await Promise.allSettled(
    tokens.map(async ({ id, token, platform }: { id: string; token: string; platform: string }) => {
      try {
        const data: Record<string, string> = { instance_id: instanceId };
        if (effectiveThreadId) data.thread_id = effectiveThreadId;
        if (executionId) data.execution_id = executionId;

        await messaging.send({
          token,
          notification: { title, body },
          data,
          apns: {
            headers: { "apns-thread-id": instanceId },
            payload: {
              aps: {
                sound: "default",
                "summary-arg": instanceName ?? "Cursor",
              },
            },
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
