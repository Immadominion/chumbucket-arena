/**
 * Account/social queries against the shared Supabase project — a direct port of
 * the mobile app's query code, not a reinterpretation of it. Every function here
 * has a named mobile source so a future change to either side can be diffed:
 *
 *  - syncSupabaseUser      <- chumbucket/lib/features/authentication/providers/auth_provider.dart (_syncUserWithSupabase)
 *  - fetchSupabaseProfile  <- chumbucket/lib/features/profile/providers/profile_provider.dart (fetchUserProfile)
 *  - updateSupabaseProfile <- .../profile_provider.dart (updateUserProfile) — used by edit_profile_screen.dart
 *  - setSupabaseProfileImage <- chumbucket/lib/features/profile/data/persistent_profile_picture_service.dart (_saveToSupabase)
 *      NOTE: mobile defines an `update_user_profile_with_pfp` RPC but never calls it live (the one call site,
 *      auth_provider.dart:348, is commented out). The picture picker that IS wired up
 *      (widgets/profile_picture_selection_modal.dart -> setUserPfp) does a plain
 *      `users` table update of `profile_image_id` instead. This mirrors that REAL path, not the dead RPC.
 *      There's also no Supabase Storage bucket for pfps on mobile — `profile_image_id` just indexes into
 *      5 bundled preset images (mirrored here under /public/img/profile/{1..5}.png), it isn't a free upload.
 *  - listSupabaseFriends / addSupabaseFriend <- chumbucket/lib/shared/services/unified_database_service.dart
 *      (getUserFriends / addFriend) — addFriend writes TWO rows (a<->b), both status 'accepted'.
 */

import { supabase, type SupaFriendRow, type SupaUser } from "./supabase";

/** Call immediately after a successful Privy login — creates/links the `users` row. */
export async function syncSupabaseUser(privyId: string, email: string): Promise<void> {
  const { error } = await supabase.rpc("sync_user", { p_privy_id: privyId, p_email: email });
  if (error) throw error;
}

export async function fetchSupabaseProfile(privyId: string): Promise<SupaUser | null> {
  const { data, error } = await supabase
    .rpc("fetch_user_profile", { p_privy_id: privyId })
    .maybeSingle();
  if (error) throw error;
  return (data as SupaUser | null) ?? null;
}

export async function updateSupabaseProfile(
  privyId: string,
  fullName: string,
  bio: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_user_profile", {
    p_privy_id: privyId,
    p_full_name: fullName,
    p_bio: bio,
  });
  if (error) throw error;
}

export async function setSupabaseProfileImage(privyId: string, imageId: number): Promise<void> {
  const { error } = await supabase.from("users").update({ profile_image_id: imageId }).eq("privy_id", privyId);
  if (error) throw error;
}

export type FriendRow = {
  name: string;
  walletAddress: string;
  profileImageId: number | null;
};

export async function listSupabaseFriends(privyId: string): Promise<FriendRow[]> {
  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("id")
    .eq("privy_id", privyId)
    .maybeSingle();
  if (meErr) throw meErr;
  if (!me) return [];

  const { data, error } = await supabase
    .from("friends")
    .select("friend_id, users!friends_friend_id_fkey(full_name, profile_image_id, wallet_address)")
    .eq("user_id", me.id)
    .eq("status", "accepted");
  if (error) throw error;

  const rows = (data ?? []) as unknown as SupaFriendRow[];
  return rows
    .filter((r) => !!r.users?.wallet_address)
    .map((r) => ({
      name: r.users!.full_name || "Unknown Friend",
      walletAddress: r.users!.wallet_address!,
      profileImageId: r.users!.profile_image_id,
    }));
}

export async function addSupabaseFriend(opts: {
  privyId: string;
  friendWalletAddress: string;
  friendName: string;
}): Promise<{ alreadyFriends: boolean }> {
  const { privyId, friendWalletAddress, friendName } = opts;

  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("id")
    .eq("privy_id", privyId)
    .maybeSingle();
  if (meErr) throw meErr;
  if (!me) throw new Error("Your account isn't set up yet — try again in a moment.");
  const userId = me.id as string;

  const { data: existingFriend, error: friendLookupErr } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("wallet_address", friendWalletAddress)
    .maybeSingle();
  if (friendLookupErr) throw friendLookupErr;

  let friendId: string;
  if (!existingFriend) {
    // Mirrors unified_database_service.dart addFriend(): create a minimal
    // placeholder user for a wallet that hasn't signed in yet.
    const { data: created, error: createErr } = await supabase
      .from("users")
      .insert({
        privy_id: `wallet_${friendWalletAddress.slice(0, 8)}`,
        email: `wallet_${friendWalletAddress.slice(0, 8)}@temp.com`,
        full_name: friendName,
        wallet_address: friendWalletAddress,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (createErr) throw createErr;
    friendId = created.id as string;
  } else {
    friendId = existingFriend.id as string;
    if (!existingFriend.full_name) {
      await supabase.from("users").update({ full_name: friendName }).eq("id", friendId);
    }
  }

  if (friendId === userId) throw new Error("That's your own wallet address.");

  const { data: existingFriendship, error: friendshipErr } = await supabase
    .from("friends")
    .select()
    .or(`and(user_id.eq.${userId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${userId})`)
    .maybeSingle();
  if (friendshipErr) throw friendshipErr;
  if (existingFriendship) return { alreadyFriends: true };

  const nowIso = new Date().toISOString();
  const { error: insertErr } = await supabase.from("friends").insert([
    { user_id: userId, friend_id: friendId, status: "accepted", created_at: nowIso },
    { user_id: friendId, friend_id: userId, status: "accepted", created_at: nowIso },
  ]);
  if (insertErr) throw insertErr;

  return { alreadyFriends: false };
}
