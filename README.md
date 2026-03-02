# Notyfai

**Notyfai** is an open-source solution for quick hooks setup for instant status notifications from your Cursor agent. 

Whenever your agent is **blocked** (waiting for shell, MCP, or file approval) or **stops** (run finished), Notyfai forwards the event status to your private endpoint. 

Stay updated on your agent's progress without keeping Cursor in the foreground. Get notified on your phone, Telegram, Slack, or any service of your choice—as soon as the agent needs you or has finished its work.

## Install

1. **Install from the Cursor Marketplace**  
   Open the marketplace in Cursor, search for **Notyfai**, and install the plugin.

2. **Get the Notyfai app**  
   Install the Notyfai mobile app and sign in. From the app you get a unique hook URL for your account.

3. **Configure the hook URL**  
   The plugin script needs your hook URL. Choose one:

   - **Global (recommended):** Run in a terminal (use the copy command from the app):
     ```bash
     echo 'YOUR_HOOK_URL' > ~/.cursor/notyfai-url
     ```
   - **Environment variable:** In `~/.zshrc` or `~/.bashrc`:
     ```bash
     export NOTYFAI_HOOK_URL='YOUR_HOOK_URL'
     ```
   - **Per project:** From the project root:
     ```bash
     echo 'YOUR_HOOK_URL' > .cursor/notyfai-url
     ```
     Add `.cursor/notyfai-url` to `.gitignore` so the URL is not committed.

4. **Restart Cursor** so it loads the plugin and hooks.

## What triggers notifications

- **Agent blocked** — The agent is waiting for permission (e.g. shell command, MCP call, file read with "ask" or "deny"). A push is sent after a short debounce (about 15 seconds).
- **Agent stopped** — The agent run finished (`stop` event). You get an immediate notification.

All other hook events (session start/end, tool use, file edits, etc.) are sent to the backend for execution tracking and history; they do not trigger push notifications by themselves.

## Full setup and troubleshooting

For manual setup without the plugin, localhost notes, and troubleshooting (no notifications, token issues, push not received), see [docs/configure-hook.md](docs/configure-hook.md).

## Repository layout

- **Plugin (Cursor Marketplace):** `.cursor-plugin/`, `hooks/`, `scripts/`, `assets/`, this README.
- **Backend:** `backend/` — API that receives hook events, stores them, and sends FCM push notifications.
- **Docs:** `docs/` — Configuration and setup scripts.

## License

MIT. See [LICENSE](LICENSE).
