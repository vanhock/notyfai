import { Router, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

router.post("/token", async (req: Request, res: Response<unknown, AuthLocals>): Promise<void> => {
  const userId = res.locals.userId;
  console.log("[devices] POST /token received for user", userId);

  const { token, platform } = (req.body ?? {}) as { token?: string; platform?: string };

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" });
    return;
  }
  if (platform !== "ios" && platform !== "android") {
    res.status(400).json({ error: "platform must be ios or android" });
    return;
  }

  const { error } = await supabaseAdmin
    .from("push_tokens")
    .upsert(
      { user_id: res.locals.userId, token, platform },
      { onConflict: "user_id,token" }
    );

  if (error) {
    console.error("[devices] POST /token error:", error.message);
    res.status(500).json({ error: "Failed to register device token" });
    return;
  }

  console.log("[devices] push token registered for user", userId, "platform:", platform);
  res.status(204).send();
});

export default router;
