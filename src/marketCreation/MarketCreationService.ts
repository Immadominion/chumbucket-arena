/**
 * Proposal -> review -> paid Panta create -> live market, for a canonical
 * person. No method takes an identity from a client: every `userId` is the
 * verified session's public.users.id, resolved by the route.
 *
 *   pending_review --approve--> approved --sign+broadcast--> publishing --register+verify--> live
 *        |   \--reject--> rejected            |    \--withdraw/reject          |
 *        \--withdraw--> withdrawn             \<-- the transaction failed or expired
 *
 * `expired` is derived, not stored: a pending/approved proposal whose close is
 * too near to publish (rules.publishDeadline).
 *
 * Money rules, mirroring PantaTradingService:
 *  - the signed bytes are committed (session SUBMITTED, proposal publishing)
 *    BEFORE broadcast; a lost reply is re-checked, never re-quoted;
 *  - `live` requires Panta's register AND independent RPC evidence of the exact
 *    reviewed message landing with the exact USDC fee debited from the signer;
 *  - only RPC evidence of failure or of an expired blockhash releases a
 *    publishing proposal back to approved. A Panta refusal alone does not.
 */
import { createHash } from "node:crypto";
import { validateSignedPantaTransaction, type SignedPantaTransaction } from "../prediction/PantaChain.ts";
import { marketUuid } from "../prediction/types.ts";
import { MarketCreationError, isMarketCreationError, type MarketCreationErrorCode } from "./errors.ts";
import { recentBlockhashOf, type CreateBinding, type PantaMarketCreator } from "./PantaMarketCreator.ts";
import { normalizeDraft, publishDeadline, validateDraft, type MarketDraft, type PantaCreateCategory } from "./rules.ts";
import type { MarketProposalStore, ProposalRow, ProposalStatus, ReviewReason, SessionRow } from "./store.ts";
import type { AccountWallets } from "../wallet/accountWallets.ts";

export const PROPOSER_PENDING_LIMIT = 5;
export const PROPOSER_DAILY_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PersonRef { id: string; handle: string; displayName: string }
export interface CreateChain {
  broadcast(tx: SignedPantaTransaction): Promise<void>;
  verifyTransaction(input: { signature: string; owner: string; market: string; programId: string; amountBaseUnits: string; messageHash: string }): Promise<boolean>;
  failed(signature: string): Promise<boolean>;
  neverLanded(signature: string, lastValidBlockHeight: number, recentBlockhash: string): Promise<boolean>;
}
/** Pull a freshly live market into the call catalog. Best effort. */
export interface CatalogIngest { ingest(venueMarketId: string): Promise<void> }

export type ProposalView = {
  id: string;
  question: string;
  category: string;
  outcomes: ["YES", "NO"];
  closesAt: number;
  resolvesAt: number;
  rules: string;
  sources: string[];
  description: string | null;
  status: ProposalStatus | "expired";
  createdAt: number;
  updatedAt: number;
  publishDeadline: number;
  proposer: PersonRef | null;
  viewerIsProposer: boolean;
  review: { decidedAt: number; reason: ReviewReason | null; note: string | null } | null;
  canWithdraw: boolean;
  canPublish: boolean;
  publish: { wallet: string; submittedAt: number } | null;
  live: { venueMarketId: string; marketId: string; creatorWallet: string; liveAt: number } | null;
  attribution: "Powered by Panta";
};

export interface PublishReview {
  sessionId: string;
  proposalId: string;
  wallet: string;
  eventAddress: string;
  feeBaseUnits: string;
  liquidityBaseUnits: string;
  platformBaseUnits: string;
  currency: "USDC";
  network: "solana-mainnet";
  transaction: string;
  expiresAt: number;
  closesAt: number;
  resolvesAt: number;
  attribution: "Powered by Panta";
}

export interface ProposeInput extends MarketDraft { idempotencyKey: string }

export interface MarketCreationDeps {
  store: MarketProposalStore;
  reviewerIds: ReadonlySet<string>;
  /** The calls directory mirror. `load` reads through on a miss (a person who
   *  joined after this replica booted); attribution never fails a request. */
  people: { get(id: string): PersonRef | undefined; load?(id: string): Promise<void> };
  now?: () => number;
  newId?: () => string;
  /** Present only when publishing is ready. */
  publishing?: { creator: PantaMarketCreator; chain: CreateChain; catalog: CatalogIngest } | null;
  /**
   * After a broadcast, keep re-checking in the background: a check is what
   * registers the create with Panta, and the payer's app may close right
   * after signing. In-process and bounded; the app's own checks remain the
   * fallback across restarts. Off unless composed (tests drive `refresh`).
   */
  followUp?: { attempts: number; everyMs: number; schedule?: (run: () => void, ms: number) => void } | null;
  /**
   * The account's own proven wallets (docs/money-api.md §g): the proposer
   * pays from one of them. Production always composes it; absent (tests),
   * the paying wallet is not checked.
   */
  wallets?: AccountWallets | null;
}

/** What the verified session proves about its own wallet: a Sign-in-with-Solana address. */
export interface PublishSession { signInWallet?: string | null }

const refuse = (code: ConstructorParameters<typeof MarketCreationError>[0], message: string, field?: string): never => {
  throw new MarketCreationError(code, message, field ? { field } : {});
};
const ms = (iso: string): number => Date.parse(iso);

export class MarketCreationService {
  private readonly following = new Set<string>();
  constructor(private readonly deps: MarketCreationDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private newId() { return this.deps.newId?.() ?? crypto.randomUUID(); }
  isReviewer(userId: string | null): boolean { return userId !== null && this.deps.reviewerIds.has(userId.toLowerCase()); }

  // ── proposals ────────────────────────────────────────────────────────────

  async propose(userId: string, input: ProposeInput): Promise<ProposalView> {
    const draft = normalizeDraft(input);
    const fingerprint = createHash("sha256").update(JSON.stringify([draft.question, draft.category, draft.closesAt,
      draft.resolvesAt, draft.rules, draft.sources, draft.description])).digest("hex");
    const existing = await this.deps.store.findByKey(userId, input.idempotencyKey);
    if (existing) return this.replayProposal(existing, fingerprint, userId);
    const problems = validateDraft(draft, this.now());
    if (problems.length > 0) refuse("MC_INVALID", problems[0]!.message, problems[0]!.field);
    if (await this.deps.store.countPending(userId) >= PROPOSER_PENDING_LIMIT) {
      refuse("MC_LIMIT", `You already have ${PROPOSER_PENDING_LIMIT} markets waiting for review. Wait for a decision first.`);
    }
    if (await this.deps.store.countSince(userId, new Date(this.now() - DAY_MS).toISOString()) >= PROPOSER_DAILY_LIMIT) {
      refuse("MC_LIMIT", "You've proposed the maximum number of markets for today. Try again tomorrow.");
    }
    const row = await this.deps.store.insertProposal({
      id: this.newId(), proposer_id: userId, idempotency_key: input.idempotencyKey, request_fingerprint: fingerprint,
      question: draft.question, category: draft.category, closes_at: new Date(draft.closesAt).toISOString(),
      resolves_at: new Date(draft.resolvesAt).toISOString(), rules: draft.rules, sources: draft.sources,
      description: draft.description ?? null,
    });
    if (row) return this.view(row, userId);
    const raced = await this.deps.store.findByKey(userId, input.idempotencyKey);
    if (!raced) return refuse("MC_CONFLICT", "Your proposal could not be saved. Try again.");
    return this.replayProposal(raced, fingerprint, userId);
  }

  private replayProposal(row: ProposalRow, fingerprint: string, userId: string): ProposalView {
    if (row.request_fingerprint !== fingerprint) refuse("MC_CONFLICT", "This proposal was already sent with different details.");
    return this.view(row, userId);
  }

  async mine(userId: string): Promise<ProposalView[]> {
    const rows = await this.withPeople(await this.deps.store.byProposer(userId, 50));
    return rows.map(row => this.view(row, userId));
  }

  async get(userId: string, proposalId: string): Promise<ProposalView> {
    const [row] = await this.withPeople([await this.visible(userId, proposalId)]);
    return this.view(row!, userId);
  }

  async withdraw(userId: string, proposalId: string): Promise<ProposalView> {
    const row = await this.visible(userId, proposalId);
    if (row.proposer_id !== userId) refuse("MC_FORBIDDEN", "Only the person who proposed this market can withdraw it.");
    if (row.status !== "pending_review" && row.status !== "approved") refuse("MC_STATE", this.stateCopy(row.status));
    const saved = await this.deps.store.updateProposal(row.id, row.status, { status: "withdrawn" });
    if (!saved) return refuse("MC_CONFLICT", "This proposal just changed. Refresh and try again.");
    return this.view(saved, userId);
  }

  // ── review ───────────────────────────────────────────────────────────────

  async reviewQueue(userId: string): Promise<{ pending: ProposalView[]; approved: ProposalView[] }> {
    this.requireReviewer(userId);
    const rows = await this.withPeople(await this.deps.store.byStatus(["pending_review", "approved", "publishing"], 100));
    return {
      pending: rows.filter(row => row.status === "pending_review").map(row => this.view(row, userId)),
      approved: rows.filter(row => row.status !== "pending_review").map(row => this.view(row, userId)),
    };
  }

  async review(userId: string, proposalId: string, decision: { approve: true } | { approve: false; reason: ReviewReason; note: string | null }): Promise<ProposalView> {
    this.requireReviewer(userId);
    const row = await this.deps.store.proposal(proposalId);
    if (!row) return refuse("MC_NOT_FOUND", "That market proposal no longer exists.");
    const now = this.now();
    if (decision.approve) {
      if (row.status !== "pending_review") refuse("MC_STATE", this.stateCopy(row.status));
      if (now > publishDeadline(ms(row.closes_at))) refuse("MC_STATE", "Trading closes too soon to publish this market. Reject it instead.");
    } else if (row.status !== "pending_review" && row.status !== "approved") refuse("MC_STATE", this.stateCopy(row.status));
    const note = decision.approve ? null : (decision.note?.trim() || null);
    const saved = await this.deps.store.updateProposal(row.id, row.status, {
      status: decision.approve ? "approved" : "rejected", reviewed_by: userId, reviewed_at: new Date(now).toISOString(),
      review_reason: decision.approve ? null : decision.reason, review_note: note,
    });
    if (!saved) return refuse("MC_CONFLICT", "This proposal just changed. Refresh and try again.");
    return this.view(saved, userId);
  }

  // ── publishing (the paid Panta create) ──────────────────────────────────

  /** Upload the cover once, quote and build. Nothing is signed or broadcast. */
  async preparePublish(userId: string, proposalId: string, wallet: string, publishSession: PublishSession = {}): Promise<PublishReview> {
    const publishing = this.requirePublishing();
    let row = await this.publishable(userId, proposalId);
    await this.assertOwnWallet(userId, wallet, publishSession);
    if (!row.cover_image_url) {
      const url = await publishing.creator.uploadCover(row.category as PantaCreateCategory);
      row = await this.deps.store.updateProposal(row.id, "approved", { cover_image_url: url })
        ?? refuse("MC_CONFLICT", "This proposal just changed. Refresh and try again.");
    }
    const binding = await publishing.creator.prepare({ wallet, imageUrl: row.cover_image_url!, draft: {
      question: row.question, category: row.category as PantaCreateCategory, closesAt: ms(row.closes_at),
      resolvesAt: ms(row.resolves_at), rules: row.rules, sources: row.sources, description: row.description,
    } });
    const session = await this.deps.store.insertSession({ id: this.newId(), proposal_id: row.id, publisher_id: userId,
      wallet_address: wallet, create_id: binding.createId, event_pda: binding.eventPda,
      payment_base_units: binding.paymentBaseUnits, prepared: binding });
    return this.publishReview(session, row, binding);
  }

  /** Commit the signed bytes, then claim the proposal, then broadcast, then try to confirm. */
  async submitPublish(userId: string, proposalId: string, sessionId: string, signedTransaction: string, publishSession: PublishSession = {}): Promise<ProposalView> {
    const publishing = this.requirePublishing();
    let session = await this.deps.store.session(sessionId);
    if (!session || session.proposal_id !== proposalId || session.publisher_id !== userId) {
      return refuse("MC_NOT_FOUND", "That publish review is not yours. Start publishing again.");
    }
    const binding = publishing.creator.validateBinding(session.prepared);
    // Still the publisher's own wallet: a link revoked since the review stops the send.
    if (session.state === "QUOTED") await this.assertOwnWallet(userId, binding.wallet, publishSession);
    let tx: SignedPantaTransaction;
    try { tx = validateSignedPantaTransaction(signedTransaction, binding.wallet, binding.messageHash); }
    catch { return refuse("MC_INVALID", "The wallet approval doesn't match the reviewed market transaction."); }
    if (session.signature !== null && (session.signature !== tx.signature || session.signed_transaction !== signedTransaction)) {
      refuse("MC_CONFLICT", "This review already approved a different transaction.");
    }
    if (session.state === "QUOTED") {
      if (binding.expiresAt <= this.now()) refuse("MC_STATE", "The wallet approval arrived after the quote expired. Review a fresh quote; nothing was sent.");
      await this.publishable(userId, proposalId);
      let submitted: SessionRow | null;
      try {
        submitted = await this.deps.store.updateSession(session.id, "QUOTED", { state: "SUBMITTED", signature: tx.signature, signed_transaction: signedTransaction });
      } catch { return refuse("MC_CONFLICT", "Another publish of this market is already in progress."); }
      if (!submitted) return refuse("MC_CONFLICT", "This review just changed. Refresh and try again.");
      session = submitted;
      await this.claimCommitted(userId, proposalId, session, binding);
    } else if (session.state === "SUBMITTED") {
      // A retry. If the first attempt committed the bytes but lost the claim's
      // reply, the proposal is not `publishing` yet: claim it now, or retire the
      // bytes. Never broadcast for a proposal this session does not hold.
      if ((await this.requireProposal(proposalId)).status !== "publishing") await this.claimCommitted(userId, proposalId, session, binding);
    } else {
      return this.view(await this.requireProposal(proposalId), userId);
    }
    // Durable approval and claim BEFORE RPC. A lost reply re-sends the same bytes only.
    try { await publishing.chain.broadcast(tx); }
    catch { /* uncertain: refresh decides from chain evidence, never by re-quoting */ }
    let view: ProposalView;
    try { view = await this.refresh(userId, proposalId); }
    catch (error) { this.followUp(userId, proposalId); throw error; }
    if (view.status === "publishing") this.followUp(userId, proposalId);
    return view;
  }

  /** Bounded background re-checks of one sent create; one chain per proposal. */
  private followUp(userId: string, proposalId: string): void {
    const plan = this.deps.followUp;
    if (!plan || plan.attempts <= 0 || this.following.has(proposalId)) return;
    this.following.add(proposalId);
    const schedule = plan.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
    let left = plan.attempts;
    const tick = () => schedule(() => {
      left--;
      this.refresh(userId, proposalId)
        .then(view => view.status === "publishing", () => true)
        .then(again => { if (again && left > 0) tick(); else this.following.delete(proposalId); });
    }, plan.everyMs);
    tick();
  }

  /**
   * Hold the proposal in `publishing` for a session whose signed bytes are
   * committed (SUBMITTED). Broadcast only ever follows a successful claim, so
   * an unclaimed session was never sent: when it can no longer be claimed its
   * bytes are retired (FAILED) and can never be sent. A lost database reply
   * here leaves the session SUBMITTED, and the retry comes back through this
   * check before any broadcast.
   */
  private async claimCommitted(userId: string, proposalId: string, session: SessionRow, binding: CreateBinding): Promise<void> {
    const retire = async (code: MarketCreationErrorCode, message: string): Promise<never> => {
      await this.deps.store.updateSession(session.id, "SUBMITTED", { state: "FAILED" });
      return refuse(code, message);
    };
    if (binding.expiresAt <= this.now()) return retire("MC_STATE", "The wallet approval expired before it was sent. Review a fresh quote; nothing was sent.");
    let row: ProposalRow;
    try { row = await this.publishable(userId, proposalId); }
    catch (error) {
      if (!isMarketCreationError(error)) throw error;
      return retire(error.code, `${error.message} Nothing was sent.`);
    }
    const claimed = await this.deps.store.updateProposal(row.id, "approved", { status: "publishing", published_by: userId, creator_wallet: binding.wallet });
    if (!claimed) return retire("MC_CONFLICT", "This proposal changed before publishing. Nothing was sent.");
  }

  /** Re-check a publishing proposal against Panta and the chain. */
  async refresh(userId: string, proposalId: string): Promise<ProposalView> {
    const row = await this.visible(userId, proposalId);
    if (row.status !== "publishing") return this.view(row, userId);
    const publishing = this.requirePublishing();
    const session = await this.deps.store.activeSession(row.id);
    if (!session?.signature) return this.view(row, userId);
    const binding = publishing.creator.validateBinding(session.prepared);
    let registered = session.state === "REGISTERED" ? session.registered_market_id : null;
    if (!registered) {
      try {
        registered = (await publishing.creator.register(binding, session.signature)).marketId;
        await this.deps.store.updateSession(session.id, "SUBMITTED", { state: "REGISTERED", registered_market_id: registered });
      } catch (error) {
        if (!isMarketCreationError(error) || error.code === "MC_SCHEMA") throw error;
        // Not registered (yet). Only chain evidence may release the proposal.
        if (await publishing.chain.failed(session.signature) ||
            await publishing.chain.neverLanded(session.signature, binding.lastValidBlockHeight, recentBlockhashOf(binding))) {
          await this.deps.store.updateSession(session.id, "SUBMITTED", { state: "FAILED" });
          const released = await this.deps.store.updateProposal(row.id, "publishing", { status: "approved", published_by: null, creator_wallet: null });
          return this.view(released ?? await this.requireProposal(row.id), userId);
        }
        return this.view(row, userId);
      }
    }
    const verified = await publishing.chain.verifyTransaction({ signature: session.signature, owner: binding.wallet,
      market: binding.eventPda, programId: binding.programId, amountBaseUnits: binding.paymentBaseUnits, messageHash: binding.messageHash })
      .catch(() => false);
    if (!verified) return this.view(row, userId);
    const live = await this.deps.store.updateProposal(row.id, "publishing", {
      status: "live", venue_market_id: binding.eventPda, live_at: new Date(this.now()).toISOString(),
    });
    try { await publishing.catalog.ingest(binding.eventPda); } catch { /* the catalog sync picks it up next pass */ }
    return this.view(live ?? await this.requireProposal(row.id), userId);
  }

  /** Public: who proposed a live market (for "Proposed by @handle"). */
  async byMarket(venueMarketId: string): Promise<{ proposalId: string; proposer: PersonRef | null; liveAt: number } | null> {
    const row = await this.deps.store.byVenueMarket(venueMarketId);
    if (!row || row.status !== "live" || !row.live_at) return null;
    await this.withPeople([row]);
    return { proposalId: row.id, proposer: this.deps.people.get(row.proposer_id) ?? null, liveAt: ms(row.live_at) };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Make sure every proposer is in the directory mirror before rendering. */
  private async withPeople(rows: ProposalRow[]): Promise<ProposalRow[]> {
    const load = this.deps.people.load;
    if (load) {
      const missing = [...new Set(rows.map(row => row.proposer_id))].filter(id => !this.deps.people.get(id));
      await Promise.all(missing.map(id => load(id).catch(() => undefined)));
    }
    return rows;
  }
  private requireReviewer(userId: string) {
    if (!this.isReviewer(userId)) refuse("MC_FORBIDDEN", "Only Chumbucket reviewers can do that.");
  }
  private requirePublishing() {
    return this.deps.publishing ?? refuse("MC_DISABLED", "Publishing to Panta isn't available right now.");
  }
  private async requireProposal(id: string): Promise<ProposalRow> {
    return (await this.deps.store.proposal(id)) ?? refuse("MC_NOT_FOUND", "That market proposal no longer exists.");
  }
  /** The proposer and reviewers can see a proposal; nobody else can. */
  private async visible(userId: string, proposalId: string): Promise<ProposalRow> {
    const row = await this.deps.store.proposal(proposalId);
    if (!row || (row.proposer_id !== userId && !this.isReviewer(userId))) return refuse("MC_NOT_FOUND", "That market proposal no longer exists.");
    return row;
  }
  /**
   * The paying wallet must be the publisher's own: an active SIWS-proven
   * link, or (with no link row at all) the wallet this session signed in
   * with. Unreadable links refuse, never assume.
   */
  private async assertOwnWallet(userId: string, wallet: string, session: PublishSession): Promise<void> {
    const wallets = this.deps.wallets;
    if (!wallets) return;
    let status: Awaited<ReturnType<AccountWallets["status"]>>;
    try { status = await wallets.status(userId, wallet); }
    catch { return refuse("MC_UNVERIFIED", "We couldn't confirm this wallet is yours. Try again in a moment."); }
    if (status === "active" || (status === "none" && session.signInWallet === wallet)) return;
    refuse("MC_FORBIDDEN", "Link this wallet to your account first", "wallet");
  }

  /**
   * Approved, still in time, and the caller is its proposer. Reviewers only
   * approve: a reviewer paying for, and owning, someone else's market is the
   * gap this closes (docs/money-api.md §g).
   */
  private async publishable(userId: string, proposalId: string): Promise<ProposalRow> {
    const row = await this.visible(userId, proposalId);
    if (row.proposer_id !== userId) refuse("MC_FORBIDDEN", "Only the person who proposed this market can publish it.");
    if (row.status !== "approved") refuse("MC_STATE", this.stateCopy(row.status));
    if (this.now() > publishDeadline(ms(row.closes_at))) refuse("MC_STATE", "Trading closes too soon to publish this market now.");
    return row;
  }
  private stateCopy(status: ProposalStatus): string {
    switch (status) {
      case "pending_review": return "This market is still waiting for review.";
      case "approved": return "This market is approved and waiting to be published.";
      case "rejected": return "This market proposal was rejected.";
      case "withdrawn": return "This market proposal was withdrawn.";
      case "publishing": return "This market is being published. Check its status instead.";
      case "live": return "This market is already live.";
    }
  }
  private publishReview(session: SessionRow, row: ProposalRow, binding: CreateBinding): PublishReview {
    return { sessionId: session.id, proposalId: row.id, wallet: binding.wallet, eventAddress: binding.eventPda,
      feeBaseUnits: binding.paymentBaseUnits, liquidityBaseUnits: binding.liquidityBaseUnits, platformBaseUnits: binding.platformBaseUnits,
      currency: "USDC", network: "solana-mainnet", transaction: binding.transaction, expiresAt: binding.expiresAt,
      closesAt: ms(row.closes_at), resolvesAt: ms(row.resolves_at), attribution: "Powered by Panta" };
  }

  view(row: ProposalRow, viewerId: string | null): ProposalView {
    const closesAt = ms(row.closes_at);
    const deadline = publishDeadline(closesAt);
    const late = this.now() > deadline;
    const status: ProposalView["status"] = late && (row.status === "pending_review" || row.status === "approved") ? "expired" : row.status;
    const isProposer = viewerId !== null && row.proposer_id === viewerId;
    return {
      id: row.id, question: row.question, category: row.category, outcomes: ["YES", "NO"], closesAt,
      resolvesAt: ms(row.resolves_at), rules: row.rules, sources: [...row.sources], description: row.description, status,
      createdAt: ms(row.created_at), updatedAt: ms(row.updated_at), publishDeadline: deadline,
      proposer: this.deps.people.get(row.proposer_id) ?? null, viewerIsProposer: isProposer,
      // Who reviewed stays private; the decision and its reason do not.
      review: row.reviewed_at ? { decidedAt: ms(row.reviewed_at), reason: row.review_reason, note: row.review_note } : null,
      canWithdraw: isProposer && (status === "pending_review" || status === "approved"),
      canPublish: status === "approved" && this.deps.publishing != null && isProposer,
      publish: row.status === "publishing" && row.creator_wallet ? { wallet: row.creator_wallet, submittedAt: ms(row.updated_at) } : null,
      live: row.status === "live" && row.venue_market_id && row.live_at && row.creator_wallet
        ? { venueMarketId: row.venue_market_id, marketId: marketUuid("panta", row.venue_market_id), creatorWallet: row.creator_wallet, liveAt: ms(row.live_at) }
        : null,
      attribution: "Powered by Panta",
    };
  }
}
