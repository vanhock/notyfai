import { supabaseAdmin } from "./supabase.js";
import { sendPushNotification } from "./notifications.js";
import type { CursorHookPayload } from "../types/cursor.js";

/** Interval between runs (ms). */
const BLOCKING_CHECK_INTERVAL_MS = 30_000;

/**
 * Finds executions that are due for a blocking check (blocking_check_at <= now),
 * whose thread is still running/blocked. Sends agentBlocked push, marks execution and thread blocked.
 */
async function runBlockingCheck(): Promise<void> {
  const now = new Date().toISOString();

  const { data: activeThreads, error: threadsError } = await supabaseAdmin
    .from("threads")
    .select("id")
    .in("status", ["running", "blocked"]);

  if (threadsError || !activeThreads?.length) return;

  const threadIds = activeThreads.map((t: { id: string }) => t.id);

  const { data: rows, error } = await supabaseAdmin
    .from("agent_executions")
    .select(
      "id, thread_id, instance_id, blocking_event_type, blocking_tool_name, blocking_payload, cursor_instances!inner(user_id, name)"
    )
    .in("thread_id", threadIds)
    .not("blocking_check_at", "is", null)
    .lte("blocking_check_at", now);

  if (error) {
    console.error("[blockingCheckWorker] query error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  for (const row of rows) {
    const executionId = row.id as string;
    const threadId = row.thread_id as string;
    const instanceId = row.instance_id as string;
    const raw = row.cursor_instances as { user_id: string; name: string | null } | { user_id: string; name: string | null }[] | null;
    const instance = Array.isArray(raw) ? raw[0] : raw;
    if (!instance) continue;
    const userId = instance.user_id;
    const instanceName = instance.name ?? null;
    const payload = (row.blocking_payload ?? {}) as CursorHookPayload;

    try {
      await sendPushNotification(userId, "agentBlocked", payload, instanceName, instanceId, executionId, threadId);
    } catch (err) {
      console.error("[blockingCheckWorker] sendPushNotification error for executionId=%s:", executionId, err);
    }

    await supabaseAdmin
      .from("agent_executions")
      .update({
        blocked_since: now,
        blocking_check_at: null,
        blocking_payload: null,
      })
      .eq("id", executionId);

    await supabaseAdmin
      .from("threads")
      .update({ status: "blocked", updated_at: now })
      .eq("id", threadId);

    console.log("[blockingCheckWorker] marked blocked executionId=%s threadId=%s", executionId, threadId);
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
