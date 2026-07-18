/**
 * Supabase client — the SAME project the ChumBucket mobile app (Flutter) uses,
 * so accounts, friends and profiles are shared between web and mobile. There's
 * no formal schema file; this mirrors the mobile app's query code exactly
 * (see chumbucket/lib/features/authentication/providers/auth_provider.dart,
 * chumbucket/lib/features/profile/providers/profile_provider.dart and
 * chumbucket/lib/shared/services/unified_database_service.dart).
 *
 * Auth model: neither platform uses Supabase Auth — every request goes out
 * under the public anon key, and rows are scoped by `privy_id` (the Privy user
 * id) instead of a Supabase session. That's a deliberate match to mobile's
 * existing behavior, not a web-side choice.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Don't throw at import time (this module is pulled into client bundles) —
  // just warn loudly so a missing .env.local is obvious in the console.
  console.warn(
    "[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set — " +
      "account sync, friends and profile features will fail.",
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

/** The mobile app's `users` table. NOTE: `id` is a UUID (verified live against the
 * project — `SELECT id FROM users LIMIT 1` returned e.g.
 * "71ad1954-51af-4c1b-8c94-6f7aedc00150"), NOT the int the reverse-engineered
 * schema notes assumed. friends.user_id/friend_id are UUID FKs to this column. */
export type SupaUser = {
  id: string;
  privy_id: string;
  email: string | null;
  full_name: string | null;
  bio: string | null;
  wallet_address: string | null;
  profile_image_id: number | null;
  created_at?: string;
  updated_at?: string;
};

/** One row of the mobile app's `friends` table, embedding the friend's user row. */
export type SupaFriendRow = {
  friend_id: string;
  users: Pick<SupaUser, "full_name" | "profile_image_id" | "wallet_address"> | null;
};

/** The 5 bundled preset avatars mobile ships in assets/images/ai_gen/profile_images —
 * mirrored into web/public/img/profile so both platforms render the same picture
 * for a given profile_image_id. There is no free-form photo upload on mobile today
 * (no Supabase Storage bucket is used for pfps) — `profile_image_id` just indexes
 * into this fixed set. */
export const PROFILE_IMAGE_IDS = [1, 2, 3, 4, 5] as const;
export const profileImageUrl = (id: number | null | undefined) =>
  id && PROFILE_IMAGE_IDS.includes(id as (typeof PROFILE_IMAGE_IDS)[number])
    ? `/img/profile/${id}.png`
    : null;
