#!/usr/bin/env bash
# Notyfai Cursor hook: read JSON from stdin, POST to hook URL.
# URL from NOTYFAI_HOOK_URL or ~/.cursor/notyfai-url
HOOK_URL="${NOTYFAI_HOOK_URL:-$(cat ~/.cursor/notyfai-url 2>/dev/null)}"
if [ -z "$HOOK_URL" ]; then
  echo "Notyfai: set NOTYFAI_HOOK_URL or run: echo 'YOUR_HOOK_URL' > ~/.cursor/notyfai-url" >&2
  exit 1
fi
curl -s -X POST -H "Content-Type: application/json" -d @- "$HOOK_URL"
