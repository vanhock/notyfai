"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERMISSION_BEARING_HOOKS = exports.SEMANTIC_EVENT_TYPES = exports.CURSOR_EVENT_TYPES = void 0;
exports.toSemanticType = toSemanticType;
exports.normalizeEventType = normalizeEventType;
/**
 * All Cursor hook event types from https://cursor.com/docs/agent/hooks
 * (Agent: sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure,
 *  subagentStart, subagentStop, beforeShellExecution, afterShellExecution,
 *  beforeMCPExecution, afterMCPExecution, beforeReadFile, afterFileEdit,
 *  beforeSubmitPrompt, preCompact, stop, afterAgentResponse, afterAgentThought;
 *  Tab: beforeTabFileRead, afterTabFileEdit)
 */
exports.CURSOR_EVENT_TYPES = [
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
];
exports.SEMANTIC_EVENT_TYPES = [
    "agentStart",
    "agentBlocked",
    "agentStopped",
    "toolStart",
    "toolResult",
    "agentMessage",
];
/**
 * Maps a raw Cursor event type to its default semantic type.
 * Permission-bearing hooks (before*Execution, beforeReadFile, beforeTabFileRead)
 * default to agentBlocked here; callers in hooks.ts use resolveSemanticType()
 * to treat only permission "ask" | "deny" as blocking, and "allow" | undefined as toolStart.
 * Only "stop" maps to agentStopped; eventType "unknown" is never treated as agentStopped.
 */
function toSemanticType(eventType) {
    switch (eventType) {
        case "sessionStart":
        case "beforeSubmitPrompt":
            return "agentStart";
        case "subagentStart":
        case "preToolUse":
            return "toolStart";
        case "beforeShellExecution":
        case "beforeMCPExecution":
        case "beforeReadFile":
        case "beforeTabFileRead":
            return "agentBlocked";
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
function normalizeEventType(raw) {
    if (!raw)
        return "unknown";
    const exact = exports.CURSOR_EVENT_TYPES.includes(raw);
    if (exact)
        return raw;
    // Case-insensitive match so e.g. "subAgentStop" from Cursor is not treated as "unknown" → agentStopped
    const canonical = exports.CURSOR_EVENT_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
    return canonical ?? "unknown";
}
/** Set of permission-bearing hook types that require a permission check. */
exports.PERMISSION_BEARING_HOOKS = new Set([
    "beforeShellExecution",
    "beforeMCPExecution",
    "beforeReadFile",
    "beforeTabFileRead",
]);
