/**
 * Every BFF procedure the web app uses, typed, over one caller. The same
 * procedures, with the same inputs, the Android app calls (see
 * `bff_calls_repository.dart` and friends). No input ever names a viewer, a
 * user id or a wallet as identity: the BFF reads who is asking from the
 * session, and its schemas are strict.
 */

import type {
  CallDetail,
  CallFeedEntry,
  CallResponseResult,
  CallVisibility,
  CatalogPage,
  FeedPage,
  Leaderboard,
  Market,
  MarketDetail,
  NotificationPage,
  OwnProfile,
  PersonCard,
  PersonDetail,
  PersonLookup,
  ResponseKind,
  Side,
  SuggestedPeople,
  ThesisUpdate,
} from "./types";
import type { PreparedTrade, TradeOrder } from "./trade";
import { LINK_DOMAIN, LINK_URI } from "./chumbucketLink";

export type Caller = <T>(path: string, input: unknown, kind: "query" | "mutation") => Promise<T>;

export interface Whoami {
  userId: string;
  authUserId: string;
  /** null: the account has no @username yet. Absent: it could not be read. */
  handle?: string | null;
}

export type UsernameStatus = "available" | "invalid" | "reserved" | "taken";

/** `wallet.status`: whether this server runs the Chumbucket wallet, and the account's wallets. */
export interface WalletStatus {
  enabled: boolean;
  account: {
    tradingWallet: { address: string; walletType: string } | null;
    chumbucketWallet: string | null;
  } | null;
}

/** `wallet.balance`: the trading wallet's real mainnet balance, as integer strings. */
export interface WalletBalance {
  wallet: string;
  walletType: string;
  lamports: string;
  usdcBaseUnits: string;
}

export function makeApi(call: Caller) {
  const q = <T>(path: string, input: unknown = {}) => call<T>(path, input, "query");
  const m = <T>(path: string, input: unknown = {}) => call<T>(path, input, "mutation");
  return {
    // ── calls ──
    feed: (mode: "following" | "global", cursor?: string | null) =>
      q<FeedPage>("calls.feed", { mode, limit: 20, ...(cursor ? { cursor } : {}) }),
    call: (callId: string) => q<CallDetail>("calls.get", { callId }),
    createCall: (input: { marketId: string; side: Side; thesis?: string | null; visibility?: CallVisibility }) =>
      m<CallFeedEntry>("calls.create", {
        marketId: input.marketId,
        side: input.side,
        ...(input.thesis ? { thesis: input.thesis } : {}),
        visibility: input.visibility ?? "public",
      }),
    respond: (input: { targetCallId: string; kind: ResponseKind; thesis?: string | null; note?: string | null }) =>
      m<CallResponseResult>("calls.respond", {
        targetCallId: input.targetCallId,
        kind: input.kind,
        ...(input.thesis ? { thesis: input.thesis } : {}),
        ...(input.note ? { note: input.note } : {}),
      }),
    addUpdate: (callId: string, body: string) => m<ThesisUpdate>("calls.addUpdate", { callId, body }),

    // ── markets ──
    catalog: (input: Record<string, unknown>) => q<CatalogPage>("predictions.catalog", input),
    openMarkets: () => q<Market[]>("markets.open", {}),
    market: (marketId: string) => q<MarketDetail>("markets.detail", { marketId }),

    // ── people ──
    person: (personRef: string) => q<PersonDetail>("people.get", { personRef: personRef.replace(/^@+/, "") }),
    follow: (personRef: string) => m<unknown>("people.follow", { personRef }),
    unfollow: (personRef: string) => m<unknown>("people.unfollow", { personRef }),
    following: () => q<{ people: PersonCard[] }>("people.following", {}),
    suggested: () => q<SuggestedPeople>("people.suggested", { limit: 20 }),
    leaderboard: (window: "7d" | "30d" | "all") => q<Leaderboard>("people.leaderboard", { window, limit: 50 }),
    /** A mutation so a wallet in the query travels in a body, never a URL. */
    find: (query: string) => m<PersonLookup>("people.find", { query }),

    // ── inbox ──
    inbox: (cursor?: string | null) => q<NotificationPage>("inbox.list", { limit: 30, ...(cursor ? { cursor } : {}) }),
    unread: () => q<{ unread: number }>("inbox.unreadCount", {}),
    markAllRead: () => m<{ marked: number; unread: number }>("inbox.markRead", {}),

    // ── account ──
    me: () => q<{ profile: OwnProfile }>("account.me", {}),
    updateProfile: (patch: { displayName?: string; bio?: string; avatarId?: number }) =>
      m<{ profile: OwnProfile }>("account.updateProfile", patch),

    // ── trading and the Chumbucket wallet (POST: private, session-keyed) ──
    walletStatus: () => m<WalletStatus>("wallet.status", {}),
    walletBalance: () => m<WalletBalance>("wallet.balance", {}),
    /** The account's ten-minute token for Privy (sub = the account, not the sign-in). */
    privyToken: () => m<{ token: string; expiresAt: number }>("wallet.privyToken", {}),
    prepareTrade: (input: { callId: string; wallet: string; amountBaseUnits: string; idempotencyKey: string; maxSlippageBps: number }) =>
      m<PreparedTrade>("pantaTrading.prepare", input),
    submitTrade: (orderId: string, signedTransaction: string) => m<TradeOrder>("pantaTrading.submit", { orderId, signedTransaction }),
    tradeOrder: (orderId: string) => m<TradeOrder>("pantaTrading.order", { orderId }),
    callOrder: (callId: string) => m<{ order: TradeOrder | null }>("pantaTrading.callOrder", { callId }),

    // ── identity (the token is an input here, so these are POSTs) ──
    whoami: (supabaseAccessToken: string) => m<Whoami>("auth.whoami", { supabaseAccessToken }),
    completeProfile: (supabaseAccessToken: string, displayName: string, handle: string) =>
      m<{ userId: string }>("auth.completeProfile", { supabaseAccessToken, displayName, handle }),
    claimUsername: (supabaseAccessToken: string, handle: string) =>
      m<{ userId: string; handle: string }>("auth.claimUsername", { supabaseAccessToken, handle }),
    /** A link challenge for the account's own wallet (the Chumbucket wallet). */
    requestWalletLink: (supabaseAccessToken: string, address: string) =>
      m<{ message: string }>("auth.requestWalletNonce", {
        supabaseAccessToken,
        address,
        domain: LINK_DOMAIN,
        uri: LINK_URI,
        purpose: "link_wallet",
      }),
    linkWallet: (
      supabaseAccessToken: string,
      input: { address: string; message: string; signature: string; walletType: "chumbucket" },
    ) => m<{ userId: string; address: string; outcome: string }>("auth.linkWallet", { supabaseAccessToken, ...input, purpose: "link_wallet" }),
    usernameStatus: (handle: string) => q<{ handle: string; status: UsernameStatus }>("auth.usernameStatus", { handle }),
  };
}

export type Api = ReturnType<typeof makeApi>;
