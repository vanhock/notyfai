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
  if (!token || !supabaseUrl || !supabasePublishableKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const supabase = createClient(supabaseUrl!, supabasePublishableKey!);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  res.locals.userId = user.id;
  res.locals.accessToken = token;
  next();
}
