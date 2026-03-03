#!/usr/bin/env bash
# Setup Notyfai Cursor hooks at project level (hooks only; URL is set separately via command).
# Usage:
#   From project root:  ./setup-notyfai-hooks.sh
#   From anywhere:       ./setup-notyfai-hooks.sh /path/to/project
# Then save your hook URL:  echo 'YOUR_HOOK_URL' > .cursor/notyfai-url  (from project root)

set -e

PROJECT_ROOT="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve project root to absolute path
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

if [ ! -d "$PROJECT_ROOT/.git" ] 2>/dev/null && [ -z "${NOTYFAI_SKIP_GIT_CHECK:-}" ]; then
  echo "Warning: $PROJECT_ROOT does not look like a git repo. Use a project root for Cursor hooks." >&2
fi

mkdir -p "$PROJECT_ROOT/.cursor/hooks"

# Install notyfai-send.sh (from this repo's docs or inline)
SEND_SCRIPT="$PROJECT_ROOT/.cursor/hooks/notyfai-send.sh"
if [ -f "$SCRIPT_DIR/notyfai-send.sh" ]; then
  cp "$SCRIPT_DIR/notyfai-send.sh" "$SEND_SCRIPT"
else
  cat > "$SEND_SCRIPT" << 'NOTYFAI_SEND_EOF'
#!/usr/bin/env bash
# Notyfai Cursor hook: read JSON from stdin, POST to hook URL.
# URL lookup order: NOTYFAI_HOOK_URL env var → .cursor/notyfai-url (project) → ~/.cursor/notyfai-url (global fallback)
HOOK_URL="${NOTYFAI_HOOK_URL:-$(cat "${CURSOR_PROJECT_DIR:-.}/.cursor/notyfai-url" 2>/dev/null)}"
HOOK_URL="${HOOK_URL:-$(cat ~/.cursor/notyfai-url 2>/dev/null)}"
if [ -z "$HOOK_URL" ]; then
  echo "Notyfai: run setup from the app in your project root, or set NOTYFAI_HOOK_URL" >&2
  exit 1
fi
curl -s -X POST -H "Content-Type: application/json" -d @- "$HOOK_URL"
NOTYFAI_SEND_EOF
fi
chmod +x "$SEND_SCRIPT"
echo "Wrote .cursor/hooks/notyfai-send.sh (executable)"

# Create project-level hooks.json
HOOKS_JSON="$PROJECT_ROOT/.cursor/hooks.json"
cat > "$HOOKS_JSON" << 'NOTYFAI_HOOKS_EOF'
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "sessionEnd": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "beforeSubmitPrompt": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "afterAgentResponse": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "beforeShellExecution": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "afterShellExecution": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "beforeMCPExecution": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "afterMCPExecution": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "preToolUse": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "postToolUse": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "postToolUseFailure": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "subagentStart": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "subagentStop": [{ "command": ".cursor/hooks/notyfai-send.sh" }],
    "stop": [{ "command": ".cursor/hooks/notyfai-send.sh" }]
  }
}
NOTYFAI_HOOKS_EOF
echo "Wrote .cursor/hooks.json"

echo ""
echo "Done. Set the hook URL from the app (copy command), then restart Cursor."
echo "Tip: add .cursor/notyfai-url to .gitignore so your hook URL is not committed."
