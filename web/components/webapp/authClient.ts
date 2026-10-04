/**
 * The web app's Supabase Auth client: the same project the Android app signs
 * in to, so a person has one account on both. Unlike the Arena-era
 * `lib/supabase.ts` (anon key only, no session), this one keeps a real
 * session in the browser and refreshes it, because the calls BFF verifies a
 * Supabase session on every request, exactly as it does for the app.
 *
 * PKCE for Google and X: the provider returns to the page that started the
 * sign-in with a one-time `code`, which the client exchanges for a session.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let client: SupabaseClient | null = null;

export function authClient(): SupabaseClient {
  if (!client) {
    client = createClient(URL || "https://unconfigured.invalid", KEY || "unconfigured", {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storageKey: "cb.web.auth",
      },
    });
  }
  return client;
}

/** The current access token, or null. Local and cheap; the client refreshes it before it expires. */
export async function accessToken(): Promise<string | null> {
  try {
    const { data } = await authClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
