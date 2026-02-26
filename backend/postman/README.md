# Postman collection for Notyfai API

1. **Import**  
   In Postman: File → Import → select `Notyfai-API.postman_collection.json`.

2. **Set collection variables**  
   Open the collection → Variables. Set at least:
   - `supabase_url` — e.g. `https://xxxx.supabase.co`
   - `supabase_publishable_key` — from Supabase Dashboard → API
   - `test_email` / `test_password` — a user created in Supabase (Auth → Users → Add user)
   - `base_url` — `http://localhost:3000` (or your backend URL)

3. **Run order (OTP flow)**  
   - **Health check** — confirm backend is up.
   - **Auth → Send OTP** — sends 6-digit code to `test_email`. In Supabase Dashboard set the Magic Link email template to include `{{ .Token }}` for OTP.
   - Set variable `otp_token` to the code you received (e.g. `123456`).
   - **Auth → Verify OTP** — exchanges email + code for session; saves `access_token`.
   - **Instances → Create instance** — saves `instance_id`.
   - **Instances → Get hook-setup** — saves `hook_url`.
   - **Webhook → Send test event** — sends a sample payload.

   **Alternative (password):** use **Auth → Login (get JWT)** if you have a password user; then run Instances and Webhook as above.
   - **Instances → Get hook-setup** — saves `hook_url` and returns copy-command.
   - **Webhook → Send test event** — sends a sample Cursor payload to the hook URL.

If **Login** fails (e.g. 400), ensure the user exists and "Email" auth with password is enabled. You can also obtain a JWT from Supabase Dashboard (Auth → Users → user → ...) or from your app and paste it into the `access_token` variable.
