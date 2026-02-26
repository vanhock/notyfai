export const CURSOR_EVENT_TYPES = ["stop", "beforeShellExecution", "beforeMCPExecution"] as const;
export type CursorEventType = (typeof CURSOR_EVENT_TYPES)[number];

export interface CursorHookPayload {
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  hook_event_name?: string;
  cursor_version?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  transcript_path?: string | null;
  [key: string]: unknown;
}

export function normalizeEventType(raw: string | undefined): CursorEventType | "unknown" {
  if (!raw) return "unknown";
  if (CURSOR_EVENT_TYPES.includes(raw as CursorEventType)) return raw as CursorEventType;
  return "unknown";
}
