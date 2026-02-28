# Configure Cursor hook for Notyfai

After you get a `hook-setup` response from the API (or from the app), use one of the options below.

## Option A: One-time setup with copy_command

1. **Save your webhook URL** so the script can read it. Run in terminal (use the `copy_command` from the API response, or run this with your URL):

   ```bash
   echo 'YOUR_HOOK_URL' > ~/.cursor/notyfai-url
   ```

   Example (replace with your actual URL from the response):

   ```bash
   echo 'http://localhost:3000/api/hooks/cursor?token=YOUR_TOKEN' > ~/.cursor/notyfai-url
   ```

2. **Create the script** Cursor will run on each event. Create `~/.cursor/scripts/notyfai-send.sh`:

   ```bash
   #!/usr/bin/env bash
   HOOK_URL="${NOTYFAI_HOOK_URL:-$(cat ~/.cursor/notyfai-url 2>/dev/null)}"
   if [ -z "$HOOK_URL" ]; then
     echo "Notyfai: set NOTYFAI_HOOK_URL or run: echo 'YOUR_HOOK_URL' > ~/.cursor/notyfai-url" >&2
     exit 1
   fi
   curl -s -X POST -H "Content-Type: application/json" -d @- "$HOOK_URL"
   ```

   Make it executable:

   ```bash
   chmod +x ~/.cursor/scripts/notyfai-send.sh
   ```

3. **Create hooks config.** Create or replace `~/.cursor/hooks.json` with:

   ```json
   {
     "version": 1,
     "hooks": {
       "stop": [{ "command": "./scripts/notyfai-send.sh" }],
       "beforeShellExecution": [{ "command": "./scripts/notyfai-send.sh" }],
       "beforeMCPExecution": [{ "command": "./scripts/notyfai-send.sh" }]
     }
   }
   ```

   (Paths are relative to `~/.cursor/` when the file is at `~/.cursor/hooks.json`.)

4. **Restart Cursor** so it loads the new hooks.

After that, when Cursor fires `stop`, `beforeShellExecution`, or `beforeMCPExecution`, it will run the script with the event JSON on stdin, and the script will POST it to your hook URL.

## Option B: Use environment variable instead of file

If you prefer not to use `~/.cursor/notyfai-url`, set the URL in your shell profile:

```bash
# In ~/.zshrc or ~/.bashrc
export NOTYFAI_HOOK_URL='http://localhost:3000/api/hooks/cursor?token=YOUR_TOKEN'
```

Then create `~/.cursor/scripts/notyfai-send.sh` and `~/.cursor/hooks.json` as in option A. The script reads `NOTYFAI_HOOK_URL` first, then falls back to the file.

## Localhost note

If your backend runs on `localhost`, Cursor (and the script) must be able to reach it. For a backend on your machine, `http://localhost:3000` is fine. For a backend on another machine or in the cloud, use that host in the hook URL instead.

## Troubleshooting: no notifications

1. **Backend running and reachable**  
   With the backend running, trigger a Cursor hook (e.g. run a command). In the backend logs you should see:
   - `[hooks] POST /cursor received` — the request reached the server.
   - If you never see this, the hook URL may be wrong or the backend not running. Test from a terminal:
     ```bash
     curl -s -X POST -H "Content-Type: application/json" -d '{"hook_event_name":"stop"}' 'YOUR_HOOK_URL'
     ```
     Use the same URL as in `~/.cursor/notyfai-url` or `NOTYFAI_HOOK_URL`.

2. **Token and instance**  
   If you see `missing token` or `invalid token`, fix the hook URL (include `?token=...`) or ensure `HOOK_SECRET` in the backend matches the secret used when the token was created. If you see `instance not found`, the token’s instance is not in this backend’s database.

3. **Events stored**  
   When the backend accepts the hook it logs: `[hooks] cursor event received` with `instanceId`, `userId`, `eventType`. Then it stores the event and tries to send a push.

4. **Push not sent**  
   If you see `[notifications] no push tokens for user ... - register a device in the app to receive notifications`, open the Notyfai app on your device, log in, and ensure the app has registered the device (e.g. via the devices/notification flow). Push tokens are created when the app calls `POST /api/devices/token`.

5. **Push sent**  
   If you see `[notifications] sending push to N device(s) ...`, the backend sent the notification to FCM. If it still doesn’t appear on the device, check device notification permissions, app in foreground/background, and FCM configuration (e.g. Firebase project, `google-services.json` / `GoogleService-Info.plist`).
