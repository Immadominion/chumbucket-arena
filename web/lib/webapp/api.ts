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
import type { LinkMethod, LinkPreview, LinkTicket, SignInMethods } from "./linking";
import type {
  ActivityItem,
  CardDeposit,
  CardOrder,
  ClaimPrepared,
  ClaimView,
  DepositOptions,
  MoneyCallStatus,
  MoneyCallView,
  MoneyStatus,
  MoneyWallet,
  PrepareCallInput,
  PrepareCallResult,
  RetryResult,
  TopUpOrder,
  TopUpResult,
  TransferPrepareResult,
  TransferView,
  Winnings,
} from "./money";
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

/** Drops absent optional keys: every money input is strict, and an explicit undefined is still a key. */
function present<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T;
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
    claimPrepare: (orderId: string, idempotencyKey: string) => m<ClaimPrepared>("pantaTrading.claimPrepare", { orderId, idempotencyKey }),
    claimSubmit: (claimId: string, signedTransaction: string) => m<ClaimView>("pantaTrading.claimSubmit", { claimId, signedTransaction }),
    claim: (claimId: string) => m<ClaimView>("pantaTrading.claim", { claimId }),
    /** A gasless USDC → SOL swap for one of the account's own wallets (`wallet` only selects). */
    topUpOrder: (wallet: string, amountBaseUnits: string) => m<TopUpOrder>("solTopUp.order", { wallet, amountBaseUnits }),
    topUpExecute: (requestId: string, signedTransaction: string) => m<TopUpResult>("solTopUp.execute", { requestId, signedTransaction }),
    /** Card / Apple Pay (Crossmint): the order and its checkout page. */
    cardDeposit: (amountUsd: string, idempotencyKey: string) => m<CardDeposit>("deposits.create", { amountUsd, idempotencyKey }),
    cardOrder: (orderId: string) => m<{ orderId: string } & CardOrder>("deposits.order", { orderId }),

    // ── calls with money (docs/money-api.md; POST: private, session-keyed) ──
    moneyStatus: () => m<MoneyStatus>("money.status", {}),
    prepareCall: (input: PrepareCallInput) =>
      m<PrepareCallResult>(
        "money.prepareCall",
        present({
          ...(input.kind === "own" ? { kind: input.kind, marketId: input.marketId, side: input.side } : { kind: input.kind, targetCallId: input.targetCallId }),
          amountBaseUnits: input.amountBaseUnits,
          idempotencyKey: input.idempotencyKey,
          thesis: input.thesis || undefined,
          visibility: input.visibility,
        }),
      ),
    moneyCallStatus: (callId: string) => m<MoneyCallStatus>("money.callStatus", { callId }),
    retryCall: (callId: string) => m<RetryResult>("money.retry", { callId }),
    keepFree: (callId: string) => m<{ moneyCall: MoneyCallView; call: CallFeedEntry }>("money.keepFree", { callId }),
    discardCall: (callId: string) => m<{ moneyCall: MoneyCallView }>("money.discard", { callId }),
    pendingCalls: () => m<{ calls: Array<{ moneyCall: MoneyCallView; call: CallFeedEntry }> }>("money.pending", {}),
    moneyWallet: () => m<MoneyWallet>("money.wallet", {}),
    moneyActivity: (limit = 20) => m<{ items: ActivityItem[] }>("money.activity", { limit }),
    winnings: () => m<Winnings>("money.winnings", {}),
    depositOptions: (amountBaseUnits?: string | null) =>
      m<DepositOptions>("money.depositOptions", amountBaseUnits ? { amountBaseUnits } : {}),
    cashOutPrepare: (input: { destination: string; amountBaseUnits: string; idempotencyKey: string }) =>
      m<TransferPrepareResult>("money.cashOutPrepare", input),
    depositFromWalletPrepare: (input: { fromWallet: string; amountBaseUnits: string; idempotencyKey: string }) =>
      m<TransferPrepareResult>("money.depositFromWalletPrepare", input),
    transferSubmit: (transferId: string, signedTransaction: string) =>
      m<TransferView>("money.transferSubmit", { transferId, signedTransaction }),
    transferStatus: (transferId: string) => m<TransferView>("money.transferStatus", { transferId }),

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
    /**
     * A SIWS link proof onto this account: a browser wallet from Settings →
     * Sign-in methods, or the Chumbucket wallet (`walletType: "chumbucket"`).
     */
    linkWallet: (
      supabaseAccessToken: string,
      input: { address: string; message: string; signature: string; walletType?: "chumbucket" },
    ) => m<{ userId: string; address: string; outcome: string }>("auth.linkWallet", { supabaseAccessToken, ...input, purpose: "link_wallet" }),
    usernameStatus: (handle: string) => q<{ handle: string; status: UsernameStatus }>("auth.usernameStatus", { handle }),

    // ── sign-in methods (Settings). preview/complete take the OTHER side's token ──
    signInMethods: (supabaseAccessToken: string) => m<SignInMethods>("auth.signInMethods", { supabaseAccessToken }),
    unlinkSignIn: (supabaseAccessToken: string, ref: string) =>
      m<{ signIns: number; wallets: number }>("auth.unlinkSignIn", { supabaseAccessToken, ref }),
    startSignInLink: (supabaseAccessToken: string, method: LinkMethod) =>
      m<LinkTicket>("auth.startSignInLink", { supabaseAccessToken, method }),
    previewSignInLink: (otherAccessToken: string, ticket: string) =>
      m<LinkPreview>("auth.previewSignInLink", { supabaseAccessToken: otherAccessToken, ticket }),
    completeSignInLink: (
      otherAccessToken: string,
      ticket: string,
      expect: { outcome: LinkPreview["outcome"]; otherUserId: string | null },
    ) =>
      m<{ outcome: "already" | "linked" | "folded"; userId: string }>("auth.completeSignInLink", {
        supabaseAccessToken: otherAccessToken,
        ticket,
        expect,
      }),
    requestWalletNonce: (supabaseAccessToken: string, address: string, domain: string, uri: string) =>
      m<{ message: string; expiresAt: string }>("auth.requestWalletNonce", { supabaseAccessToken, address, domain, uri }),
  };
}

export type Api = ReturnType<typeof makeApi>;
