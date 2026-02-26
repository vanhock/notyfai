import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
}

/**
 * Supabase client with Publishable API key only (no user session).
 * Use for auth flows that don't have a user yet (e.g. OTP send/verify).
 */
export function getSupabaseAuth(): SupabaseClient {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false },
  });
}

/**
 * Supabase client with Publishable API key and user JWT.
 * Use for all user-scoped operations so RLS applies (instances list/create/read).
 * See: https://supabase.com/docs/guides/api/api-keys
 */
export function getSupabaseForUser(accessToken: string): SupabaseClient {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Secret key client — use only where there is no user context (e.g. webhook).
 * Uses the Secret key (Dashboard → Secret keys); bypasses RLS. Keep server-side only.
 */
export const supabaseAdmin: SupabaseClient = (() => {
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required for webhook handler");
  }
  return createClient(url!, secretKey, {
    auth: { persistSession: false },
  });
})();
