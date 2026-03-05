import { supabaseAdmin } from "./supabase.js";
import { sendPushNotification } from "./notifications.js";
import type { CursorHookPayload } from "../types/cursor.js";

/** Interval between runs (ms). */
const BLOCKING_CHECK_INTERVAL_MS = 30_000;

/**
 * Finds executions that are due for a blocking check (blocking_check_at <= now),
 * sends agentBlocked push, and marks them blocked. Survives process restarts.
 */
async function runBlockingCheck(): Promise<void> {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("agent_executions")
    .select(
      "id, instance_id, blocking_event_type, blocking_tool_name, blocking_payload, cursor_instances!inner(user_id, name)"
    )
    .in("status", ["running", "blocked"])
    .not("blocking_check_at", "is", null)
    .lte("blocking_check_at", now);

  if (error) {
    console.error("[blockingCheckWorker] query error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  for (const row of rows) {
    const executionId = row.id as string;
    const instanceId = row.instance_id as string;
    const raw = row.cursor_instances as { user_id: string; name: string | null } | { user_id: string; name: string | null }[] | null;
    const instance = Array.isArray(raw) ? raw[0] : raw;
    if (!instance) continue;
    const userId = instance.user_id;
    const instanceName = instance.name ?? null;
    const payload = (row.blocking_payload ?? {}) as CursorHookPayload;

    try {
      await sendPushNotification(userId, "agentBlocked", payload, instanceName, instanceId, executionId);
    } catch (err) {
      console.error("[blockingCheckWorker] sendPushNotification error for executionId=%s:", executionId, err);
    }

    const { error: updateError } = await supabaseAdmin
      .from("agent_executions")
      .update({
        status: "blocked",
        blocked_since: now,
        blocking_check_at: null,
        blocking_payload: null,
      })
      .eq("id", executionId);

    if (updateError) {
      console.error("[blockingCheckWorker] update error for executionId=%s:", executionId, updateError.message);
    } else {
      console.log("[blockingCheckWorker] marked blocked executionId=%s", executionId);
    }
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic blocking-check worker. Call once at server startup.
 */
export function startBlockingCheckWorker(): void {
  if (intervalId != null) return;
  runBlockingCheck();
  intervalId = setInterval(runBlockingCheck, BLOCKING_CHECK_INTERVAL_MS);
  console.log("[blockingCheckWorker] started (interval %ds)", BLOCKING_CHECK_INTERVAL_MS / 1000);
}
