/**
 * All Cursor hook event types from https://cursor.com/docs/agent/hooks
 * (Agent: sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure,
 *  subagentStart, subagentStop, beforeShellExecution, afterShellExecution,
 *  beforeMCPExecution, afterMCPExecution, beforeReadFile, afterFileEdit,
 *  beforeSubmitPrompt, preCompact, stop, afterAgentResponse, afterAgentThought;
 *  Tab: beforeTabFileRead, afterTabFileEdit)
 */
export const CURSOR_EVENT_TYPES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeReadFile",
  "afterFileEdit",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "afterAgentResponse",
  "afterAgentThought",
  "preCompact",
  "stop",
] as const;

export type CursorEventType = (typeof CURSOR_EVENT_TYPES)[number];

export const SEMANTIC_EVENT_TYPES = [
  "agentStart",
  "agentBlocked",
  "agentStopped",
  "toolStart",
  "toolResult",
  "agentMessage",
] as const;

export type SemanticEventType = (typeof SEMANTIC_EVENT_TYPES)[number];

/**
 * Maps a raw Cursor event type to its default semantic type.
 * before* hooks map to toolStart (start of a tool call).
 * Blocking is determined purely by inactivity: if no hook fires for 3 min, the execution is marked blocked.
 * Only "stop" maps to agentStopped; eventType "unknown" is never treated as agentStopped.
 */
export function toSemanticType(eventType: CursorEventType | "unknown"): SemanticEventType {
  switch (eventType) {
    case "sessionStart":
    case "beforeSubmitPrompt":
      return "agentStart";
    case "subagentStart":
    case "preToolUse":
    case "beforeShellExecution":
    case "beforeMCPExecution":
    case "beforeReadFile":
    case "beforeTabFileRead":
      return "toolStart";
    case "afterShellExecution":
    case "afterMCPExecution":
    case "postToolUse":
    case "postToolUseFailure":
    case "subagentStop":
    case "afterFileEdit":
    case "afterTabFileEdit":
    case "preCompact":
      return "toolResult";
    case "afterAgentResponse":
    case "afterAgentThought":
      return "agentMessage";
    case "sessionEnd":
      // Session lifecycle only; do not treat as agent stop (avoid duplicate execution/stop logs)
      return "toolResult";
    case "stop":
      return "agentStopped";
    default:
      // unknown or future event types: do not treat as agentStopped (no push, no status=stopped)
      return "toolResult";
  }
}

export interface CursorHookPayload {
  // Common fields (sent with every hook)
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  hook_event_name?: string;
  cursor_version?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  transcript_path?: string | null;

  // sessionStart
  session_id?: string;
  composer_mode?: string;
  is_background_agent?: boolean;

  // preToolUse / postToolUse / postToolUseFailure
  tool_use_id?: string;
  agent_message?: string;
  is_error?: boolean;
  tool_use_result?: string;
  // postToolUseFailure
  failure_type?: "error" | "timeout" | "permission_denied";
  is_interrupt?: boolean;
  tool_output?: string;

  // beforeShellExecution / afterShellExecution
  command?: string;
  cwd?: string;
  output?: string;
  duration?: number;

  // beforeMCPExecution / afterMCPExecution
  tool_name?: string;
  tool_input?: string | Record<string, unknown>;
  url?: string;
  result_json?: string;

  // beforeReadFile / beforeTabFileRead / afterFileEdit / afterTabFileEdit
  file_path?: string;
  edits?: Array<{ old_string?: string; new_string?: string; range?: unknown }>;

  // subagentStart / subagentStop
  subagent_id?: string;
  subagent_description?: string;
  subagent_type?: string;

  // afterAgentResponse / afterAgentThought / sessionEnd
  text?: string;
  duration_ms?: number;
  reason?: string;
  final_status?: string;
  error_message?: string;

  // stop
  status?: string;
  loop_count?: number;

  // preCompact
  trigger?: string;
  context_usage_percent?: number;
  context_tokens?: number;
  message_count?: number;

  // beforeSubmitPrompt: user's initial message (agent description/title)
  prompt?: string;

  // Permission field sent by before* hooks (not used for blocking logic)
  permission?: "allow" | "deny" | "ask";
  user_message?: string;

  [key: string]: unknown;
}

export function normalizeEventType(raw: string | undefined): CursorEventType | "unknown" {
  if (!raw) return "unknown";
  const exact = CURSOR_EVENT_TYPES.includes(raw as CursorEventType);
  if (exact) return raw as CursorEventType;
  // Case-insensitive match so e.g. "subAgentStop" from Cursor is not treated as "unknown" → agentStopped
  const canonical = CURSOR_EVENT_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  return canonical ?? "unknown";
}
