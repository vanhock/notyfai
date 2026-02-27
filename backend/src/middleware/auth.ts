import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

export interface AuthLocals {
  userId: string;
  /** User's JWT for Supabase RLS (use with publishable key client) */
  accessToken: string;
}

export async function requireAuth(
  req: Request,
  res: Response<{ error: string }, AuthLocals>,
  next: NextFunction
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    console.log("[requireAuth] %s %s: no Bearer token in Authorization header", req.method, req.path);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!supabaseUrl || !supabasePublishableKey) {
    console.log("[requireAuth] %s %s: SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY missing", req.method, req.path);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, supabasePublishableKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error) {
    console.log("[requireAuth] %s %s: getUser error status=%s message=%s", req.method, req.path, error.status ?? "?", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  if (!user) {
    console.log("[requireAuth] %s %s: getUser returned no user (token may be expired or invalid)", req.method, req.path);
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  console.log("[requireAuth] %s %s: ok userId=%s", req.method, req.path, user.id);
  res.locals.userId = user.id;
  res.locals.accessToken = token;
  next();
}
