/**
 * AccountLinkService — one account, many sign-ins (Settings → Sign-in methods).
 *
 * What it serves, all keyed by VERIFIED Supabase sessions and nothing a
 * client names:
 *
 *   signInMethods   every way into the caller's account (wallet, X, Google),
 *                   which one this session used, and how each can be unlinked
 *   unlink          an additional sign-in or a linked wallet; never the one in
 *                   use, never the account's own first sign-in
 *   startLink       a single-use, 10-minute ticket the account issues itself
 *                   before the person proves the other side
 *   previewLink     what completing that ticket with the other side's session
 *                   would do: nothing (same account), add a sign-in, or fold
 *                   the other account in (and whether that is refused)
 *   completeLink    do it
 *
 * Linking X/Google to the current account is Supabase's own manual identity
 * linking, done by the client; this service is for what Supabase cannot do:
 * an identity that already belongs to another sign-in, and wallets. The two
 * sides are proven by two sessions: the account's own (it issues the ticket)
 * and the other side's (an OAuth or wallet sign-in made only for this, which
 * completes it). Neither alone is enough, and both are re-checked in SQL.
 *
 * The ticket plaintext exists only in the issuing response and the client's
 * memory; only its sha-256 is stored.
 */

import { randomBytes } from "node:crypto";
import { codeForStoreReason, failAuth } from "./AuthIdentityError.ts";
import type { AccountLinkStore, AccountSignIns, LinkMethod } from "./AccountLinkStore.ts";
import type { SupabaseJwtVerifier, SupabaseSession } from "./SupabaseJwt.ts";
import { hashNonce, isSolanaAddress, type WalletLinkService } from "./WalletLinkService.ts";
import { CHUMBUCKET_WALLET_TYPE } from "../wallet/tradingWallet.ts";

export type MethodKind = "wallet" | "x" | "google";

export type UnlinkRoute = { mode: "native"; identityId: string } | { mode: "server"; ref: string };

export interface SignInMethodRow {
  /** Stable per row: the identity id, or `w:<address>` for a wallet with no sign-in yet. */
  id: string;
  kind: MethodKind;
  /** X username (no @), Google email, or wallet address. */
  label: string | null;
  /** The way this session signed in. */
  current: boolean;
  /**
   * How to unlink it: "native" is supabase.auth.unlinkIdentity on this
   * session (the identity is on this session's own sign-in, which keeps
   * another); "server" is auth.unlinkSignIn(ref). Null: it can't be unlinked
   * (it is the way in right now, the account's first sign-in, or the last).
   */
  unlink: UnlinkRoute | null;
  /** Other kinds on the same sign-in, which go with it. */
  alsoUnlinks: MethodKind[];
  /**
   * The Chumbucket wallet (wallet_type 'chumbucket'): shown read-only. It
   * follows the account, so it is never unlinked and is not a way in.
   */
  chumbucket: boolean;
}

export interface SignInMethods {
  methods: SignInMethodRow[];
  /** Server switches: Link/Unlink are offered only when linking is on. */
  linking: boolean;
  fold: boolean;
}

export interface LinkTicket {
  ticket: string;
  method: LinkMethod;
  expiresAt: string;
}

export interface AccountSummary {
  userId: string;
  handle: string | null;
  displayName: string | null;
}

export type LinkOutcome = "already" | "link" | "fold";

export type LinkRefusal =
  | "ACCOUNT_HAS_MONEY"
  | "ACCOUNT_FOLD_DISABLED"
  | "ACCOUNT_NOT_FOLDABLE"
  | "FOLD_NEEDS_PRIMARY_SIGN_IN"
  | "FOLD_WALLET_CONFLICT";

export interface LinkPreview {
  /** already: same account. link: a sign-in with no account joins this one. fold: the other account folds in. */
  outcome: LinkOutcome;
  /** What the other side's sign-in proved: shown before Link/Move ("@handle → @account"). */
  proof: { kind: MethodKind; label: string | null };
  into: AccountSummary;
  from: AccountSummary | null;
  /** The account the proof reaches (null: none). Sent back with the confirm. */
  otherUserId: string | null;
  /** Why it can't happen, when it can't. */
  refusal: LinkRefusal | null;
}

/** What the person saw and confirmed; the database refuses if it changed. */
export interface LinkExpectation {
  outcome: LinkOutcome;
  otherUserId: string | null;
}

export interface LinkCompletion {
  outcome: "already" | "linked" | "folded";
  userId: string;
  foldedUserId: string | null;
  /** Follow pairs the fold copied, so a running calls mirror can learn them. */
  follows: [string, string][];
  /** The folded account's devices, to tell them (never returned to a client). */
  notify: { token: string; platform: string }[];
  foldedHandle: string | null;
  intoHandle: string | null;
}

const REFUSALS: Record<string, LinkRefusal> = {
  has_money: "ACCOUNT_HAS_MONEY",
  money_unverifiable: "ACCOUNT_NOT_FOLDABLE",
  already_folded: "ACCOUNT_NOT_FOLDABLE",
  same_account: "ACCOUNT_NOT_FOLDABLE",
  not_primary_sign_in: "FOLD_NEEDS_PRIMARY_SIGN_IN",
  wallet_conflict: "FOLD_WALLET_CONFLICT",
};

interface Deps {
  identity: WalletLinkService;
  links?: AccountLinkStore;
  verifier: SupabaseJwtVerifier;
  linking: boolean;
  fold: boolean;
  /** Override only in tests. Production uses 32 bytes of CSPRNG. */
  makeTicket?: () => string;
}

const TICKET_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_ORDER: Record<MethodKind, number> = { wallet: 0, x: 1, google: 2 };

export function methodKind(provider: string): MethodKind | null {
  if (provider === "web3") return "wallet";
  if (provider === "x" || provider === "twitter") return "x";
  if (provider === "google") return "google";
  return null;
}

/**
 * The rows Settings shows. Pure: every rule about what can be unlinked lives
 * here and in unlink_sign_in_v1, and they agree — the SQL is the authority.
 */
export function signInMethodRows(data: AccountSignIns, session: SupabaseSession): SignInMethodRow[] {
  const own = data.signIns.find((s) => s.authUserId === session.authUserId);
  const primary = data.signIns.find((s) => s.primary);
  const walletsOf = (identities: { provider: string; label: string | null }[]) =>
    new Set(identities.filter((i) => i.provider === "web3" && i.label).map((i) => i.label as string));
  const sessionWallets = walletsOf(own?.identities ?? []);
  const primaryWallets = walletsOf(primary?.identities ?? []);
  const linkedWallets = new Set(data.wallets.map((w) => w.address));
  const chumbucketWallets = chumbucketWalletsOf(data);
  const holdsChumbucket = (identities: { provider: string; label: string | null }[]) =>
    [...walletsOf(identities)].some((a) => chumbucketWallets.has(a));

  // The identity this session signed in with: of the kinds its amr names,
  // the one used most recently on this sign-in.
  const wanted: MethodKind[] =
    session.signInMethod === "web3" ? ["wallet"] : session.signInMethod === "oauth" ? ["x", "google"] : ["wallet", "x", "google"];
  const current = (own?.identities ?? [])
    .filter((i) => {
      const kind = methodKind(i.provider);
      return kind !== null && wanted.includes(kind);
    })
    .sort((a, b) => Date.parse(b.lastSignInAt ?? "") - Date.parse(a.lastSignInAt ?? "") || 0)[0];

  const otherKinds = (identities: { provider: string }[], except: MethodKind): MethodKind[] => [
    ...new Set(
      identities.map((i) => methodKind(i.provider)).filter((k): k is MethodKind => k !== null && k !== except),
    ),
  ];

  const rows: SignInMethodRow[] = [];
  const seenWallets = new Set<string>();
  for (const s of data.signIns) {
    for (const i of s.identities) {
      const kind = methodKind(i.provider);
      if (!kind) continue;
      let unlink: UnlinkRoute | null = null;
      let alsoUnlinks: MethodKind[] = [];
      let chumbucket = false;
      if (kind === "wallet") {
        const address = i.label;
        if (!address || seenWallets.has(address)) continue;
        seenWallets.add(address);
        chumbucket = chumbucketWallets.has(address);
        if (chumbucket || sessionWallets.has(address) || primaryWallets.has(address)) unlink = null;
        else if (linkedWallets.has(address)) unlink = { mode: "server", ref: `w:${address}` };
        else if (!s.primary && s.signInId) unlink = { mode: "server", ref: `s:${s.signInId}` };
        if (unlink && !s.primary) alsoUnlinks = otherKinds(s.identities, "wallet");
      } else if (s.authUserId === session.authUserId) {
        // Supabase unlinks an identity from the session's own sign-in, and
        // only while that sign-in keeps another.
        unlink = s.identities.length >= 2 ? { mode: "native", identityId: i.identityId } : null;
      } else if (!s.primary && s.signInId && !holdsChumbucket(s.identities)) {
        unlink = { mode: "server", ref: `s:${s.signInId}` };
        alsoUnlinks = otherKinds(s.identities, kind);
      }
      rows.push({
        id: i.identityId,
        kind,
        label: i.label,
        current: current?.identityId === i.identityId,
        unlink,
        alsoUnlinks,
        chumbucket,
      });
    }
  }
  // Wallets linked with a SIWS proof that have not signed in yet, and the
  // Chumbucket wallet (it never signs in; it is read-only here).
  for (const w of data.wallets) {
    if (seenWallets.has(w.address)) continue;
    seenWallets.add(w.address);
    const chumbucket = chumbucketWallets.has(w.address);
    rows.push({
      id: `w:${w.address}`,
      kind: "wallet",
      label: w.address,
      current: false,
      unlink: chumbucket ? null : { mode: "server", ref: `w:${w.address}` },
      alsoUnlinks: [],
      chumbucket,
    });
  }
  // The last way in is never removable, whatever else holds. The Chumbucket
  // wallet is not a way in.
  if (rows.filter((r) => !r.chumbucket).length <= 1) for (const r of rows) r.unlink = null;
  return rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The account's Chumbucket wallets: listed read-only, never unlinked. */
function chumbucketWalletsOf(data: AccountSignIns): Set<string> {
  return new Set(data.wallets.filter((w) => w.walletType === CHUMBUCKET_WALLET_TYPE).map((w) => w.address));
}

export class AccountLinkService {
  private readonly makeTicket: () => string;

  constructor(private readonly deps: Deps) {
    this.makeTicket = deps.makeTicket ?? (() => randomBytes(32).toString("hex"));
  }

  private links(): AccountLinkStore {
    if (!this.deps.links) failAuth("IDENTITY_NOT_CONFIGURED");
    return this.deps.links;
  }

  private requireLinking(): void {
    if (!this.deps.linking) failAuth("ACCOUNT_LINKING_DISABLED");
  }

  /** A verified session that need not reach an account yet (the other side). */
  private async otherSide(accessToken: string): Promise<SupabaseSession> {
    const token = (accessToken ?? "").trim();
    if (!token) failAuth("AUTH_TOKEN_MISSING");
    const session = await this.deps.verifier.verify(token);
    if (!session) failAuth("AUTH_TOKEN_INVALID");
    return session;
  }

  async signInMethods(accessToken: string): Promise<SignInMethods> {
    const who = await this.deps.identity.authenticateSession(accessToken);
    const data = await this.links().signIns(who.userId);
    return {
      methods: signInMethodRows(data, who.session),
      linking: this.deps.linking,
      fold: this.deps.linking && this.deps.fold,
    };
  }

  async unlink(accessToken: string, ref: string): Promise<{ signIns: number; wallets: number }> {
    this.requireLinking();
    const who = await this.deps.identity.authenticate(accessToken);
    const signIn = /^s:(.+)$/.exec(ref)?.[1];
    const wallet = /^w:(.+)$/.exec(ref)?.[1];
    if (signIn !== undefined && !UUID.test(signIn)) failAuth("SIGN_IN_NOT_FOUND");
    if (wallet !== undefined && !isSolanaAddress(wallet)) failAuth("SIGN_IN_NOT_FOUND");
    if (signIn === undefined && wallet === undefined) failAuth("SIGN_IN_NOT_FOUND");
    // The Chumbucket wallet follows the account: never unlinked, by itself or
    // with a sign-in that holds it. unlink_sign_in_v1 refuses it too; an
    // unreadable listing refuses here.
    const data = await this.links().signIns(who.userId);
    const kept = chumbucketWalletsOf(data);
    const held = signIn ? data.signIns.find((s) => s.signInId === signIn)?.identities ?? [] : [];
    if ((wallet && kept.has(wallet)) || held.some((i) => i.provider === "web3" && i.label !== null && kept.has(i.label))) {
      failAuth("CHUMBUCKET_WALLET_KEPT");
    }
    const result = await this.links().unlink({
      userId: who.userId,
      sessionAuthUserId: who.authUserId,
      ...(signIn ? { signInId: signIn } : {}),
      ...(wallet ? { wallet } : {}),
    });
    if (!result.ok) {
      if (result.reason === "session_mismatch" || result.reason === "unknown_user") failAuth("AUTH_USER_UNLINKED");
      failAuth(codeForStoreReason(result.reason, "IDENTITY_STORE_ERROR"));
    }
    return {
      signIns: typeof result.sign_ins === "number" ? result.sign_ins : 0,
      wallets: typeof result.wallets === "number" ? result.wallets : 0,
    };
  }

  async startLink(accessToken: string, method: LinkMethod): Promise<LinkTicket> {
    this.requireLinking();
    const who = await this.deps.identity.authenticate(accessToken);
    const ticket = this.makeTicket();
    const issued = await this.links().issueTicket({
      userId: who.userId,
      authUserId: who.authUserId,
      method,
      ticketHash: hashNonce(ticket),
      ttlSeconds: TICKET_TTL_SECONDS,
    });
    if (!issued.ok) {
      if (issued.reason === "rate_limited") failAuth("LINK_RATE_LIMITED");
      if (issued.reason === "session_mismatch") failAuth("AUTH_USER_UNLINKED");
      failAuth("IDENTITY_STORE_ERROR");
    }
    const expiresAt = typeof issued.expires_at === "string" ? new Date(issued.expires_at).toISOString() : "";
    return { ticket, method, expiresAt };
  }

  async previewLink(otherAccessToken: string, ticket: string): Promise<LinkPreview> {
    this.requireLinking();
    const session = await this.otherSide(otherAccessToken);
    const links = this.links();
    const preview = await links.preview(hashNonce(ticket), session.authUserId);
    if (!preview.ok) failAuth(codeForStoreReason(preview.reason, "LINK_TICKET_INVALID"));
    const into = String(preview.into_user_id ?? "");
    const other = typeof preview.other_user_id === "string" ? preview.other_user_id : null;
    const cards = await links.cards(other ? [into, other] : [into]);
    const card = (id: string): AccountSummary => {
      const c = cards.find((x) => x.userId === id);
      return { userId: id, handle: c?.handle ?? null, displayName: c?.displayName ?? null };
    };
    const outcome = preview.outcome === "already" || preview.outcome === "link" ? preview.outcome : "fold";
    const method = preview.method === "x" || preview.method === "google" ? preview.method : "wallet";
    const refusal = outcome !== "fold"
      ? null
      : typeof preview.refusal === "string"
        ? (REFUSALS[preview.refusal] ?? "ACCOUNT_NOT_FOLDABLE")
        : !this.deps.fold ? "ACCOUNT_FOLD_DISABLED" : null;
    return {
      outcome,
      proof: { kind: method, label: typeof preview.proof_label === "string" ? preview.proof_label : null },
      into: card(into),
      from: other && outcome !== "already" ? card(other) : null,
      otherUserId: other,
      refusal,
    };
  }

  async completeLink(otherAccessToken: string, ticket: string, expect: LinkExpectation): Promise<LinkCompletion> {
    this.requireLinking();
    const session = await this.otherSide(otherAccessToken);
    const done = await this.links().complete({
      ticketHash: hashNonce(ticket),
      authUserId: session.authUserId,
      allowLink: this.deps.linking,
      allowFold: this.deps.fold,
      expectedOutcome: expect.outcome,
      expectedOtherUserId: expect.otherUserId,
    });
    if (!done.ok) {
      if (done.reason === "unknown_user" || done.reason === "owned") failAuth("ACCOUNT_NOT_FOLDABLE");
      failAuth(codeForStoreReason(done.reason, "IDENTITY_STORE_ERROR"));
    }
    const summary = (done.summary ?? {}) as { follows?: unknown };
    const follows = Array.isArray(summary.follows)
      ? (summary.follows as unknown[]).filter(
          (p): p is [string, string] =>
            Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string",
        )
      : [];
    const notify = Array.isArray(done.notify)
      ? (done.notify as unknown[]).flatMap((n) => {
          const t = n as { token?: unknown; platform?: unknown } | null;
          return t && typeof t.token === "string" && typeof t.platform === "string"
            ? [{ token: t.token, platform: t.platform }]
            : [];
        })
      : [];
    return {
      outcome: done.outcome === "folded" ? "folded" : done.outcome === "linked" ? "linked" : "already",
      userId: String(done.user_id ?? ""),
      foldedUserId: typeof done.folded_user_id === "string" ? done.folded_user_id : null,
      follows,
      notify,
      foldedHandle: typeof done.folded_handle === "string" ? done.folded_handle : null,
      intoHandle: typeof done.into_handle === "string" ? done.into_handle : null,
    };
  }
}
