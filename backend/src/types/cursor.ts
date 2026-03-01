export const CURSOR_EVENT_TYPES = [
  "sessionStart",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "afterShellExecution",
  "afterMCPExecution",
  "afterAgentResponse",
  "stop",
] as const;

export type CursorEventType = (typeof CURSOR_EVENT_TYPES)[number];

export const SEMANTIC_EVENT_TYPES = [
  "agentStart",
  "agentBlocked",
  "agentStopped",
  "toolResult",
  "agentMessage",
] as const;

export type SemanticEventType = (typeof SEMANTIC_EVENT_TYPES)[number];

export function toSemanticType(eventType: CursorEventType | "unknown"): SemanticEventType {
  switch (eventType) {
    case "sessionStart":
      return "agentStart";
    case "beforeShellExecution":
    case "beforeMCPExecution":
      return "agentBlocked";
    case "afterShellExecution":
    case "afterMCPExecution":
      return "toolResult";
    case "afterAgentResponse":
      return "agentMessage";
    case "stop":
    default:
      return "agentStopped";
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

  // preToolUse
  tool_use_id?: string;
  agent_message?: string;

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

  // afterAgentResponse
  text?: string;

  // stop
  status?: string;
  loop_count?: number;

  [key: string]: unknown;
}

export function normalizeEventType(raw: string | undefined): CursorEventType | "unknown" {
  if (!raw) return "unknown";
  if (CURSOR_EVENT_TYPES.includes(raw as CursorEventType)) return raw as CursorEventType;
  return "unknown";
}
