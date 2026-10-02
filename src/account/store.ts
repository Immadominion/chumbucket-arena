/**
 * AccountStore — the signed-in person's own account: profile edits, friends
 * added by wallet, and push tokens.
 *
 * Every method takes a canonical `public.users.id` that the ROUTER resolved
 * from a verified Supabase session. Nothing here accepts a wallet or a user id
 * as proof of anything; the SQL functions it calls are service-role only and
 * refuse a row nobody has signed in to (20261002170000).
 *
 * The Supabase store holds the service-role key through `Pgrest`, which
 * registers it for redaction and never puts it in a URL.
 */

import { Pgrest, type FetchImpl, type PgrestConfig } from "../prediction/pgrest.ts";

/** The five avatars the app ships (assets/images/ai_gen/profile_images/{1..5}). */
export const AVATAR_IDS = [1, 2, 3, 4, 5] as const;
export const isAvatarId = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= AVATAR_IDS.length;

export interface OwnProfile {
  userId: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  avatarId: number | null;
  /** The person's OWN primary wallet. Only ever returned to that person. */
  walletAddress: string | null;
}

export interface ProfilePatch {
  displayName?: string;
  /** "" clears the bio. */
  bio?: string;
  avatarId?: number;
}

export type ProfileRefusal = "unknown_user" | "invalid_name" | "invalid_bio" | "invalid_avatar" | "nothing_to_change";
export type UpdateProfileResult = { ok: true; profile: OwnProfile } | { ok: false; reason: ProfileRefusal | "store_error" };

export type FriendRefusal = "unknown_user" | "invalid_wallet" | "invalid_nickname" | "self";
export type AddFriendResult =
  | { ok: true; friendUserId: string; createdPlaceholder: boolean; alreadyFriends: boolean }
  | { ok: false; reason: FriendRefusal | "store_error" };

export type PushPlatform = "android" | "ios";
export interface PushTokenRow {
  token: string;
  userId: string;
  platform: PushPlatform;
}

export interface AccountStore {
  readonly enabled: boolean;
  getOwnProfile(userId: string): Promise<OwnProfile | null>;
  updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UpdateProfileResult>;
  addWalletFriend(userId: string, wallet: string, nickname: string | null): Promise<AddFriendResult>;
  /** A device token belongs to whoever registered it last. */
  registerPushToken(userId: string, token: string, platform: PushPlatform): Promise<void>;
  /** Removes the token only if it is this person's. */
  unregisterPushToken(userId: string, token: string): Promise<void>;
  pushTokensFor(userId: string): Promise<PushTokenRow[]>;
  /** Service housekeeping: FCM said the token is dead. */
  forgetPushToken(token: string): Promise<void>;
}

/** No Supabase project configured: every write is refused, honestly. */
export class UnconfiguredAccountStore implements AccountStore {
  readonly enabled = false;
  async getOwnProfile(): Promise<OwnProfile | null> {
    return null;
  }
  async updateOwnProfile(): Promise<UpdateProfileResult> {
    return { ok: false, reason: "store_error" };
  }
  async addWalletFriend(): Promise<AddFriendResult> {
    return { ok: false, reason: "store_error" };
  }
  async registerPushToken(): Promise<void> {
    throw new Error("account store is not configured");
  }
  async unregisterPushToken(): Promise<void> {}
  async pushTokensFor(): Promise<PushTokenRow[]> {
    return [];
  }
  async forgetPushToken(): Promise<void> {}
}

interface UserRow {
  id: string;
  handle: string | null;
  full_name: string | null;
  bio: string | null;
  profile_image_id: number | null;
  wallet_address: string | null;
}

const toProfile = (row: UserRow): OwnProfile => ({
  userId: row.id,
  handle: row.handle,
  displayName: row.full_name,
  bio: row.bio,
  avatarId: isAvatarId(row.profile_image_id) ? row.profile_image_id : null,
  walletAddress: row.wallet_address,
});

const PROFILE_REFUSALS: readonly string[] = ["unknown_user", "invalid_name", "invalid_bio", "invalid_avatar", "nothing_to_change"];
const FRIEND_REFUSALS: readonly string[] = ["unknown_user", "invalid_wallet", "invalid_nickname", "self"];

export class SupabaseAccountStore implements AccountStore {
  readonly enabled = true;
  private readonly pg: Pgrest;

  constructor(config: PgrestConfig, fetchImpl?: FetchImpl) {
    this.pg = new Pgrest(config, fetchImpl);
  }

  async getOwnProfile(userId: string): Promise<OwnProfile | null> {
    const rows = await this.pg.select<UserRow>(
      "users",
      new URLSearchParams({
        id: `eq.${userId}`,
        select: "id,handle,full_name,bio,profile_image_id,wallet_address",
        limit: "1",
      }),
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UpdateProfileResult> {
    const out = await this.pg.rpc<{ ok?: unknown; reason?: unknown }>("update_own_profile_v1", {
      p_user_id: userId,
      p_display_name: patch.displayName ?? null,
      p_bio: patch.bio ?? null,
      p_avatar_id: patch.avatarId ?? null,
    });
    if (out?.ok === true) {
      const profile = await this.getOwnProfile(userId);
      return profile ? { ok: true, profile } : { ok: false, reason: "store_error" };
    }
    const reason = typeof out?.reason === "string" && PROFILE_REFUSALS.includes(out.reason) ? out.reason : "store_error";
    return { ok: false, reason: reason as ProfileRefusal | "store_error" };
  }

  async addWalletFriend(userId: string, wallet: string, nickname: string | null): Promise<AddFriendResult> {
    const out = await this.pg.rpc<Record<string, unknown>>("add_wallet_friend_v1", {
      p_user_id: userId,
      p_friend_wallet: wallet,
      p_nickname: nickname,
    });
    if (out?.ok === true && typeof out.friend_user_id === "string") {
      return {
        ok: true,
        friendUserId: out.friend_user_id,
        createdPlaceholder: out.created_placeholder === true,
        alreadyFriends: out.already_friends === true,
      };
    }
    const reason = typeof out?.reason === "string" && FRIEND_REFUSALS.includes(out.reason) ? out.reason : "store_error";
    return { ok: false, reason: reason as FriendRefusal | "store_error" };
  }

  async registerPushToken(userId: string, token: string, platform: PushPlatform): Promise<void> {
    const now = new Date().toISOString();
    await this.pg.insert(
      "push_tokens",
      [{ token, user_id: userId, platform, updated_at: now }],
      { onConflict: "token" },
    );
  }

  async unregisterPushToken(userId: string, token: string): Promise<void> {
    await this.pg.remove("push_tokens", new URLSearchParams({ token: `eq.${token}`, user_id: `eq.${userId}` }));
  }

  async pushTokensFor(userId: string): Promise<PushTokenRow[]> {
    const rows = await this.pg.select<{ token: string; user_id: string; platform: PushPlatform }>(
      "push_tokens",
      new URLSearchParams({ user_id: `eq.${userId}`, select: "token,user_id,platform", order: "updated_at.desc", limit: "10" }),
    );
    return rows.map((r) => ({ token: r.token, userId: r.user_id, platform: r.platform }));
  }

  async forgetPushToken(token: string): Promise<void> {
    await this.pg.remove("push_tokens", new URLSearchParams({ token: `eq.${token}` }));
  }
}

/**
 * The SQL contract, in memory, for tests and a server with no database. Same
 * refusals as update_own_profile_v1 / add_wallet_friend_v1.
 */
export class InMemoryAccountStore implements AccountStore {
  readonly enabled = true;
  readonly profiles = new Map<string, OwnProfile & { bound: boolean }>();
  readonly tokens = new Map<string, PushTokenRow>();
  readonly friends: { userId: string; friendUserId: string; nickname: string | null }[] = [];
  private seq = 0;

  seed(profile: Partial<OwnProfile> & { userId: string; bound?: boolean }): void {
    this.profiles.set(profile.userId, {
      handle: null, displayName: null, bio: null, avatarId: 1, walletAddress: null, bound: true, ...profile,
    });
  }

  async getOwnProfile(userId: string): Promise<OwnProfile | null> {
    const p = this.profiles.get(userId);
    if (!p) return null;
    const { bound: _b, ...profile } = p;
    return profile;
  }

  async updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UpdateProfileResult> {
    const p = this.profiles.get(userId);
    if (patch.displayName === undefined && patch.bio === undefined && patch.avatarId === undefined) {
      return { ok: false, reason: "nothing_to_change" };
    }
    const name = patch.displayName?.trim();
    // eslint-disable-next-line no-control-regex
    if (name !== undefined && (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name))) {
      return { ok: false, reason: "invalid_name" };
    }
    const bio = patch.bio?.trim();
    // eslint-disable-next-line no-control-regex
    if (bio !== undefined && (bio.length > 280 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(bio))) {
      return { ok: false, reason: "invalid_bio" };
    }
    if (patch.avatarId !== undefined && !isAvatarId(patch.avatarId)) return { ok: false, reason: "invalid_avatar" };
    if (!p || !p.bound) return { ok: false, reason: "unknown_user" };
    if (name !== undefined) p.displayName = name;
    if (bio !== undefined) p.bio = bio === "" ? null : bio;
    if (patch.avatarId !== undefined) p.avatarId = patch.avatarId;
    return { ok: true, profile: (await this.getOwnProfile(userId))! };
  }

  async addWalletFriend(userId: string, wallet: string, nickname: string | null): Promise<AddFriendResult> {
    const me = this.profiles.get(userId);
    if (!me?.bound) return { ok: false, reason: "unknown_user" };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return { ok: false, reason: "invalid_wallet" };
    let friend = [...this.profiles.values()].find((p) => p.walletAddress === wallet);
    let created = false;
    if (!friend) {
      const id = `placeholder-${++this.seq}`;
      this.seed({ userId: id, walletAddress: wallet, bound: false, avatarId: null });
      friend = this.profiles.get(id)!;
      created = true;
    }
    if (friend.userId === userId) return { ok: false, reason: "self" };
    const already = this.friends.some(
      (f) =>
        (f.userId === userId && f.friendUserId === friend!.userId) ||
        (f.userId === friend!.userId && f.friendUserId === userId),
    );
    const mine = this.friends.find((f) => f.userId === userId && f.friendUserId === friend!.userId);
    if (mine) mine.nickname = nickname ?? mine.nickname;
    else this.friends.push({ userId, friendUserId: friend.userId, nickname });
    if (!this.friends.some((f) => f.userId === friend!.userId && f.friendUserId === userId)) {
      this.friends.push({ userId: friend.userId, friendUserId: userId, nickname: null });
    }
    return { ok: true, friendUserId: friend.userId, createdPlaceholder: created, alreadyFriends: already };
  }

  async registerPushToken(userId: string, token: string, platform: PushPlatform): Promise<void> {
    this.tokens.set(token, { token, userId, platform });
  }

  async unregisterPushToken(userId: string, token: string): Promise<void> {
    if (this.tokens.get(token)?.userId === userId) this.tokens.delete(token);
  }

  async pushTokensFor(userId: string): Promise<PushTokenRow[]> {
    return [...this.tokens.values()].filter((t) => t.userId === userId);
  }

  async forgetPushToken(token: string): Promise<void> {
    this.tokens.delete(token);
  }
}
