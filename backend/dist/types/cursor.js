"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURSOR_EVENT_TYPES = void 0;
exports.normalizeEventType = normalizeEventType;
exports.CURSOR_EVENT_TYPES = ["stop", "beforeShellExecution", "beforeMCPExecution"];
function normalizeEventType(raw) {
    if (!raw)
        return "unknown";
    if (exports.CURSOR_EVENT_TYPES.includes(raw))
        return raw;
    return "unknown";
}
