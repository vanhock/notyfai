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
