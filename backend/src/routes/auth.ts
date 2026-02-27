import { Router, Request, Response } from "express";
import { getSupabaseAuth } from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/auth/otp/send
 * Request body: { email: string }
 * Sends a 6-digit OTP to the email via Supabase.
 * Configure the Magic Link email template in Supabase to include {{ .Token }} for OTP instead of a link.
 */
router.post("/otp/send", async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email) {
    console.log("[auth] POST /otp/send: missing email");
    res.status(400).json({ error: "email is required" });
    return;
  }
  console.log("[auth] POST /otp/send: email=***@%s", email.split("@")[1] ?? "?");
  const supabase = getSupabaseAuth();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) {
    console.log("[auth] POST /otp/send error: %s", error.message);
    const isRateLimit =
      /rate limit|limit exceeded/i.test(error.message) ||
      error.message?.toLowerCase().includes("too many");
    if (isRateLimit) {
      res.status(429).json({
        error: error.message,
        code: "email_limit_exceeded",
      });
      return;
    }
    res.status(400).json({ error: error.message });
    return;
  }
  console.log("[auth] POST /otp/send: OTP sent successfully");
  res.status(200).json({ message: "OTP sent to email" });
});

/**
 * POST /api/auth/otp/verify
 * Request body: { email: string, token: string }
 * Verifies the 6-digit OTP and returns the session (access_token, refresh_token, user).
 */
router.post("/otp/verify", async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!email || !token) {
    console.log("[auth] POST /otp/verify: missing email or token");
    res.status(400).json({ error: "email and token are required" });
    return;
  }
  console.log("[auth] POST /otp/verify: email=***@%s tokenLen=%d", email.split("@")[1] ?? "?", token.length);
  const supabase = getSupabaseAuth();
  console.log("otp token: ", token);
  console.log("email: ", email);
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  if (error) {
    console.log("[auth] POST /otp/verify error: %s", error.message);
    res.status(400).json({ error: error.message });
    return;
  }
  if (!data.session) {
    console.log("[auth] POST /otp/verify: no session in response");
    res.status(400).json({ error: "No session returned" });
    return;
  }
  const session = data.session;
  console.log("[auth] POST /otp/verify: success userId=%s expires_in=%ds access_token prefix=%s", session.user?.id ?? "?", session.expires_in ?? 0, session.access_token?.slice(0, 20) ?? "?");
  res.status(200).json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    user: data.user,
  });
});

export default router;
