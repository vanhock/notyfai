import { Router, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/subscriptions/status
 * Returns current subscription/trial status for the authenticated user.
 */
router.get("/status", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const userId = res.locals.userId;

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("status, trial_ends_at, current_period_ends_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to fetch subscription status" });
    return;
  }

  if (!data) {
    // No record yet — create trial entry
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: created, error: createError } = await supabaseAdmin
      .from("subscriptions")
      .insert({ user_id: userId, status: "trial", trial_ends_at: trialEndsAt })
      .select("status, trial_ends_at, current_period_ends_at")
      .single();

    if (createError) {
      res.status(500).json({ error: "Failed to initialize subscription" });
      return;
    }
    res.json(created);
    return;
  }

  // If trial has expired, update status
  if (data.status === "trial" && data.trial_ends_at && new Date(data.trial_ends_at) < new Date()) {
    await supabaseAdmin
      .from("subscriptions")
      .update({ status: "expired" })
      .eq("user_id", userId);
    res.json({ ...data, status: "expired" });
    return;
  }

  res.json(data);
});

/**
 * POST /api/subscriptions/webhook
 * RevenueCat webhook handler.
 * Verifies the shared secret and updates the subscription status in DB.
 */
router.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  const rcSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (rcSecret) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${rcSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const event = req.body as {
    event?: {
      type?: string;
      app_user_id?: string;
      expiration_at_ms?: number;
    };
  };

  const type = event?.event?.type;
  const appUserId = event?.event?.app_user_id;
  const expirationMs = event?.event?.expiration_at_ms;

  if (!appUserId) {
    res.status(400).json({ error: "Missing app_user_id" });
    return;
  }

  console.log("[subscriptions] webhook: type=%s userId=%s", type, appUserId);

  let status: string | undefined;
  switch (type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "PRODUCT_CHANGE":
      status = "active";
      break;
    case "CANCELLATION":
    case "EXPIRATION":
      status = "expired";
      break;
    case "BILLING_ISSUE":
      status = "billing_issue";
      break;
  }

  if (status) {
    const updates: Record<string, unknown> = { status };
    if (expirationMs) {
      updates.current_period_ends_at = new Date(expirationMs).toISOString();
    }

    await supabaseAdmin
      .from("subscriptions")
      .upsert({ user_id: appUserId, ...updates }, { onConflict: "user_id" });
  }

  res.json({ ok: true });
});

export default router;
