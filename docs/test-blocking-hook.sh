#!/usr/bin/env bash
# Send a test "blocking" hook event (agent waiting for user — tool denied or awaiting approval).
# Blocking only when permission is explicitly "ask" or "deny". This script sends permission "ask".
#
# Usage:
#   HOOK_URL='http://localhost:3000/api/hooks/cursor?token=YOUR_JWT' ./docs/test-blocking-hook.sh
#   Or set NOTYFAI_HOOK_URL or have ~/.cursor/notyfai-url / .cursor/notyfai-url with the URL.
#
# Expect in backend logs:
#   [hooks] BLOCKING | ... eventType=beforeMCPExecution permission=ask → semanticType=agentBlocked
#   [hooks] execution status → blocked ...; [hooks] BLOCKING: scheduling push notification in 15s ...

set -e

HOOK_URL="${NOTYFAI_HOOK_URL:-${HOOK_URL:-$(cat .cursor/notyfai-url 2>/dev/null || cat ~/.cursor/notyfai-url 2>/dev/null)}}"
if [ -z "$HOOK_URL" ]; then
  echo "Set HOOK_URL or NOTYFAI_HOOK_URL, or create .cursor/notyfai-url or ~/.cursor/notyfai-url with your hook URL (e.g. http://localhost:3000/api/hooks/cursor?token=JWT)" >&2
  exit 1
fi

# Unique generation_id so we don't reuse an existing execution
GEN_ID="test-blocking-$(date +%s)"

# Blocking: beforeMCPExecution with permission "ask" (or "deny") → semanticType=agentBlocked. Undefined/allow → NOT blocking.
BODY=$(cat <<EOF
{
  "hook_event_name": "beforeMCPExecution",
  "generation_id": "$GEN_ID",
  "conversation_id": "test-conv-1",
  "tool_name": "test_tool",
  "tool_input": {"key": "value"},
  "permission": "ask"
}
EOF
)

echo "Sending blocking event (beforeMCPExecution, permission=ask) to hook..."
echo "$BODY" | curl -s -X POST -H "Content-Type: application/json" -d @- "$HOOK_URL"
echo ""
echo "Check backend logs for: [hooks] BLOCKING | ..."
echo "To see NOT BLOCKING: send same event with permission=allow or omit permission."
