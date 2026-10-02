import { expect, test } from "bun:test";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { MarketCreationError } from "../src/marketCreation/errors.ts";
import { MarketCreationService, PROPOSER_DAILY_LIMIT, PROPOSER_PENDING_LIMIT, type CreateChain, type ProposeInput } from "../src/marketCreation/MarketCreationService.ts";
import { PantaMarketCreator } from "../src/marketCreation/PantaMarketCreator.ts";
import { PUBLISH_MIN_LEAD_MS } from "../src/marketCreation/rules.ts";
import { InMemoryMarketProposalStore } from "../src/marketCreation/store.ts";
import { marketUuid } from "../src/prediction/types.ts";
import { TestClock } from "./predictionFixtures.ts";
import { COVER_URL, eventPda, FakePanta, FEE, program, sign, wallet } from "./marketCreationFixtures.ts";

const HOUR = 3_600_000;
const proposer = "10000000-0000-4000-8000-000000000001";
const reviewer = "10000000-0000-4000-8000-0000000000aa";
const stranger = "10000000-0000-4000-8000-000000000002";

class FakeChain implements CreateChain {
  broadcasts: string[] = []; verified = false; failedSig = false; expired = false; throwBroadcast = false;
  verifyInputs: unknown[] = [];
  constructor(private readonly onBroadcast: () => void = () => {}) {}
  async broadcast(tx: { signature: string }) { this.onBroadcast(); this.broadcasts.push(tx.signature); if (this.throwBroadcast) throw new Error("synthetic lost reply"); }
  async verifyTransaction(input: unknown) { this.verifyInputs.push(input); return this.verified; }
  async failed() { return this.failedSig; }
  async neverLanded() { return this.expired; }
}

function rig(options: { publishing?: boolean } = {}) {
  const clock = new TestClock();
  let ids = 0;
  const newId = () => `20000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
  const store = new InMemoryMarketProposalStore(() => clock.now());
  const panta = new FakePanta(() => clock.now());
  const creator = new PantaMarketCreator({ request: panta.request, upload: panta.upload, programId: program, maxFeeBaseUnits: "100000000", clock });
  const chain = new FakeChain(() => {
    // Commit-before-broadcast: the signed bytes and the publishing claim are durable first.
    const session = [...store.sessions.values()].find(s => s.state === "SUBMITTED");
    expect(session?.signature).toBeTruthy();
    expect([...store.proposals.values()].some(p => p.status === "publishing")).toBe(true);
  });
  const ingested: string[] = [];
  const service = new MarketCreationService({
    store, reviewerIds: new Set([reviewer]), now: () => clock.now(), newId,
    people: { get: id => id === proposer ? { id, handle: "ada", displayName: "Ada" } : undefined },
    publishing: options.publishing === false ? null : { creator, chain, catalog: { ingest: async id => { ingested.push(id); } } },
  });
  const input = (overrides: Partial<ProposeInput> = {}): ProposeInput => ({
    question: "Will ETH close above $5,000 on 1 Jan 2027?", category: "crypto",
    closesAt: clock.now() + 72 * HOUR, resolvesAt: clock.now() + 73 * HOUR,
    rules: "Resolves YES if the CoinGecko ETH/USD daily close on 1 Jan 2027 UTC is above 5000.",
    sources: ["https://www.coingecko.com/en/coins/ethereum"], description: null, idempotencyKey: "proposal-key-0001", ...overrides,
  });
  return { clock, store, panta, chain, service, input, ingested };
}
async function approved(h: ReturnType<typeof rig>) {
  const proposal = await h.service.propose(proposer, h.input());
  await h.service.review(reviewer, proposal.id, { approve: true });
  return proposal;
}

test("a proposal is stored pending review, attributed to its proposer, and replays idempotently", async () => {
  const h = rig();
  const first = await h.service.propose(proposer, h.input());
  expect(first).toMatchObject({ status: "pending_review", outcomes: ["YES", "NO"], viewerIsProposer: true, canWithdraw: true,
    canPublish: false, proposer: { handle: "ada" }, review: null, live: null, attribution: "Powered by Panta" });
  expect(first.publishDeadline).toBe(first.closesAt - PUBLISH_MIN_LEAD_MS);
  expect(await h.service.propose(proposer, h.input())).toEqual(first);
  await expect(h.service.propose(proposer, h.input({ question: "Will ETH close above $6,000 on 1 Jan 2027?" }))).rejects.toMatchObject({ code: "MC_CONFLICT" });
  expect(await h.service.mine(proposer)).toHaveLength(1);
  expect(await h.service.mine(stranger)).toHaveLength(0);
  expect(h.panta.calls).toHaveLength(0); // proposing never touches Panta
});

test("invalid drafts are refused with the offending field", async () => {
  const h = rig();
  const error = await h.service.propose(proposer, h.input({ closesAt: h.clock.now() + HOUR, resolvesAt: h.clock.now() + HOUR })).catch(e => e as MarketCreationError);
  expect(error).toMatchObject({ code: "MC_INVALID", field: "closesAt" });
  await expect(h.service.propose(proposer, h.input({ sources: ["http://localhost/result"] }))).rejects.toMatchObject({ field: "sources" });
});

test("pending and daily limits stop proposal floods", async () => {
  const h = rig();
  for (let i = 0; i < PROPOSER_PENDING_LIMIT; i++) await h.service.propose(proposer, h.input({ idempotencyKey: `pending-key-${i}`, question: `Will question number ${i} resolve YES?` }));
  await expect(h.service.propose(proposer, h.input({ idempotencyKey: "pending-key-x" }))).rejects.toMatchObject({ code: "MC_LIMIT" });
  const pending = (await h.service.mine(proposer)).slice(0, PROPOSER_DAILY_LIMIT - PROPOSER_PENDING_LIMIT);
  for (const p of pending) await h.service.review(reviewer, p.id, { approve: false, reason: "unclear", note: null });
  for (let i = 0; i < PROPOSER_DAILY_LIMIT - PROPOSER_PENDING_LIMIT; i++) {
    await h.service.propose(proposer, h.input({ idempotencyKey: `daily-key-${i}`, question: `Will daily question ${i} resolve YES?` }));
  }
  await expect(h.service.propose(proposer, h.input({ idempotencyKey: "daily-key-x" }))).rejects.toMatchObject({ code: "MC_LIMIT" });
});

test("only reviewers review; rejection carries a reason and is visible to the proposer only", async () => {
  const h = rig();
  const p = await h.service.propose(proposer, h.input());
  await expect(h.service.review(proposer, p.id, { approve: true })).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  await expect(h.service.reviewQueue(stranger)).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  expect((await h.service.reviewQueue(reviewer)).pending.map(x => x.id)).toEqual([p.id]);
  const rejected = await h.service.review(reviewer, p.id, { approve: false, reason: "unverifiable", note: " The source has no daily close. " });
  expect(rejected).toMatchObject({ status: "rejected", review: { reason: "unverifiable", note: "The source has no daily close." } });
  expect(JSON.stringify(rejected)).not.toContain(reviewer); // who reviewed stays private
  await expect(h.service.get(stranger, p.id)).rejects.toMatchObject({ code: "MC_NOT_FOUND" });
  expect((await h.service.get(proposer, p.id)).status).toBe("rejected");
  await expect(h.service.review(reviewer, p.id, { approve: true })).rejects.toMatchObject({ code: "MC_STATE" });
  await expect(h.service.withdraw(proposer, p.id)).rejects.toMatchObject({ code: "MC_STATE" });
});

test("the proposer can withdraw before publishing; nobody else can", async () => {
  const h = rig();
  const p = await approved(h);
  await expect(h.service.withdraw(reviewer, p.id)).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  expect((await h.service.withdraw(proposer, p.id)).status).toBe("withdrawn");
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_STATE" });
});

test("a pending or approved proposal past its publish deadline reads as expired and cannot publish", async () => {
  const h = rig();
  const p = await approved(h);
  h.clock.advance(p.publishDeadline - h.clock.now() + 1);
  const view = await h.service.get(proposer, p.id);
  expect(view).toMatchObject({ status: "expired", canPublish: false, canWithdraw: false });
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_STATE" });
});

test("publishing is refused when the server has not enabled it", async () => {
  const h = rig({ publishing: false });
  const p = await approved(h);
  expect((await h.service.get(proposer, p.id)).canPublish).toBe(false);
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_DISABLED" });
});

test("unapproved proposals and strangers cannot publish", async () => {
  const h = rig();
  const p = await h.service.propose(proposer, h.input());
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_STATE" });
  await h.service.review(reviewer, p.id, { approve: true });
  await expect(h.service.preparePublish(stranger, p.id, wallet)).rejects.toMatchObject({ code: "MC_NOT_FOUND" });
  expect(h.panta.calls).toHaveLength(0);
});

test("full publish: review shows the fee, signed bytes commit before broadcast, live needs register AND chain proof", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  expect(review).toMatchObject({ proposalId: p.id, wallet, eventAddress: eventPda, feeBaseUnits: FEE, liquidityBaseUnits: "10000000",
    platformBaseUnits: "40000000", currency: "USDC", network: "solana-mainnet", attribution: "Powered by Panta" });
  expect(h.panta.uploads).toHaveLength(1);
  expect(h.store.proposals.get(p.id)!.cover_image_url).toBe(COVER_URL);

  // Not yet confirmed on our RPC: Panta registered it, but live waits for chain proof.
  const publishing = await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(publishing).toMatchObject({ status: "publishing", publish: { wallet }, live: null });
  expect(h.chain.broadcasts).toHaveLength(1);
  expect(h.ingested).toHaveLength(0);

  h.chain.verified = true;
  const live = await h.service.refresh(proposer, p.id);
  expect(live).toMatchObject({ status: "live", live: { venueMarketId: eventPda, marketId: marketUuid("panta", eventPda), creatorWallet: wallet } });
  expect(h.chain.verifyInputs.at(-1)).toMatchObject({ owner: wallet, market: eventPda, programId: program, amountBaseUnits: FEE });
  expect(h.ingested).toEqual([eventPda]);
  expect(await h.service.byMarket(eventPda)).toMatchObject({ proposalId: p.id, proposer: { handle: "ada" } });
  // Re-submitting the same approval is idempotent and never re-quotes.
  const quotes = h.panta.count("/markets/create/quote/");
  await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(h.panta.count("/markets/create/quote/")).toBe(quotes);
});

test("a reviewer can sponsor an approved market with their own wallet", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(reviewer, p.id, wallet);
  h.chain.verified = true;
  const live = await h.service.submitPublish(reviewer, p.id, review.sessionId, sign(review.transaction));
  expect(live.status).toBe("live");
  expect(h.store.proposals.get(p.id)).toMatchObject({ published_by: reviewer, proposer_id: proposer, creator_wallet: wallet });
  // The proposer cannot submit the reviewer's session.
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toMatchObject({ code: "MC_NOT_FOUND" });
});

test("a foreign signature, changed message or late approval never reaches broadcast", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  // A signature by a different key placed in the creator's slot.
  const forged = VersionedTransaction.deserialize(Buffer.from(review.transaction, "base64"));
  const otherKey = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 21)]) });
  forged.addSignature(new PublicKey(wallet), edSign(null, forged.message.serialize(), otherKey));
  // A correctly signed but different message (another blockhash).
  const changed = VersionedTransaction.deserialize(Buffer.from(review.transaction, "base64"));
  changed.message.recentBlockhash = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
  const changedSigned = sign(Buffer.from(changed.serialize()).toString("base64"));
  for (const payload of [review.transaction, Buffer.from(forged.serialize()).toString("base64"), changedSigned, Buffer.from("x").toString("base64")]) {
    await expect(h.service.submitPublish(proposer, p.id, review.sessionId, payload)).rejects.toMatchObject({ code: "MC_INVALID" });
  }
  h.clock.advance(61_000);
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toMatchObject({ code: "MC_STATE" });
  expect(h.chain.broadcasts).toHaveLength(0);
  expect(h.store.proposals.get(p.id)!.status).toBe("approved");
});

test("only one create can be submitted per proposal", async () => {
  const h = rig();
  const p = await approved(h);
  // Two reviews may exist (e.g. the first expired in the wallet); only one can be sent.
  const first = await h.service.preparePublish(proposer, p.id, wallet);
  const second = await h.service.preparePublish(proposer, p.id, wallet);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(h.panta.uploads).toHaveLength(1); // the cover is uploaded once per proposal
  await h.service.submitPublish(proposer, p.id, first.sessionId, sign(first.transaction));
  await expect(h.service.submitPublish(proposer, p.id, second.sessionId, sign(second.transaction))).rejects.toMatchObject({ code: "MC_STATE" });
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_STATE" });
  expect(h.chain.broadcasts).toHaveLength(1);
});

test("a lost broadcast reply stays publishing until chain evidence decides", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  h.chain.throwBroadcast = true;
  h.panta.registerError = new MarketCreationError("MC_PANTA_REFUSED", "not yet", { providerCode: "TX_NOT_FOUND" });
  const view = await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(view.status).toBe("publishing");
  expect((await h.service.refresh(proposer, p.id)).status).toBe("publishing");
  // The blockhash expired without the signature ever landing: release, publish again.
  h.chain.expired = true;
  const released = await h.service.refresh(proposer, p.id);
  expect(released).toMatchObject({ status: "approved", canPublish: true, publish: null });
  expect([...h.store.sessions.values()].map(s => s.state)).toEqual(["FAILED"]);
});

test("an on-chain failure releases the proposal; a Panta refusal alone does not", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  h.panta.registerError = new MarketCreationError("MC_PANTA_REFUSED", "mismatch", { providerCode: "TX_MISMATCH" });
  await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect((await h.service.refresh(proposer, p.id)).status).toBe("publishing");
  h.chain.failedSig = true;
  expect((await h.service.refresh(proposer, p.id)).status).toBe("approved");
});

test("byMarket is null for markets nobody proposed here", async () => {
  const h = rig();
  expect(await h.service.byMarket(eventPda)).toBeNull();
});

test("a lost claim reply is claimed on retry BEFORE any broadcast", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  // The bytes commit, then the claim's database reply is lost.
  const update = h.store.updateProposal.bind(h.store);
  h.store.updateProposal = async () => { throw new Error("synthetic lost database reply"); };
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toThrow("synthetic lost database reply");
  h.store.updateProposal = update;
  expect([...h.store.sessions.values()].map(s => s.state)).toEqual(["SUBMITTED"]);
  expect(h.store.proposals.get(p.id)!.status).toBe("approved");
  expect(h.chain.broadcasts).toHaveLength(0);
  // The retry claims the proposal first (FakeChain asserts publishing at broadcast).
  const view = await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(view.status).toBe("publishing");
  expect(h.chain.broadcasts).toHaveLength(1);
});

test("committed bytes that can no longer be claimed are retired and never broadcast", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  const update = h.store.updateProposal.bind(h.store);
  h.store.updateProposal = async () => { throw new Error("synthetic lost database reply"); };
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toThrow();
  h.store.updateProposal = update;
  // Meanwhile a reviewer rejects the approved proposal.
  await h.service.review(reviewer, p.id, { approve: false, reason: "duplicate", note: null });
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toMatchObject({ code: "MC_STATE" });
  expect([...h.store.sessions.values()].map(s => s.state)).toEqual(["FAILED"]);
  expect(h.chain.broadcasts).toHaveLength(0);
  // A retired approval stays retired.
  const again = await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(again.status).toBe("rejected");
  expect(h.chain.broadcasts).toHaveLength(0);
});

test("an expired, unclaimed approval is retired so a fresh quote can be published", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  const update = h.store.updateProposal.bind(h.store);
  h.store.updateProposal = async () => { throw new Error("synthetic lost database reply"); };
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toThrow();
  h.store.updateProposal = update;
  h.clock.advance(61_000);
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toMatchObject({ code: "MC_STATE" });
  expect(h.chain.broadcasts).toHaveLength(0);
  const fresh = await h.service.preparePublish(proposer, p.id, wallet);
  expect((await h.service.submitPublish(proposer, p.id, fresh.sessionId, sign(fresh.transaction))).status).toBe("publishing");
  expect(h.chain.broadcasts).toHaveLength(1);
});

test("expiry is judged on the reviewed blockhash", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  const seen: unknown[][] = [];
  h.chain.neverLanded = async (...args: unknown[]) => { seen.push(args); return false; };
  h.panta.registerError = new MarketCreationError("MC_PANTA_REFUSED", "not yet", { providerCode: "TX_NOT_FOUND" });
  await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  const tx = VersionedTransaction.deserialize(Buffer.from(review.transaction, "base64"));
  expect(seen.at(-1)).toEqual([expect.any(String), 1000, tx.message.recentBlockhash]);
});

test("a proposer missing from the directory mirror is read through for attribution", async () => {
  const h = rig();
  const p = await approved(h);
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  h.chain.verified = true;
  await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  const directory = new Map<string, { id: string; handle: string; displayName: string }>();
  const loads: string[] = [];
  const cold = new MarketCreationService({ store: h.store, reviewerIds: new Set([reviewer]), now: () => h.clock.now(),
    people: { get: id => directory.get(id), load: async id => { loads.push(id); directory.set(id, { id, handle: "ada", displayName: "Ada" }); } } });
  expect(await cold.byMarket(eventPda)).toMatchObject({ proposer: { handle: "ada" } });
  expect((await cold.reviewQueue(reviewer)).approved).toHaveLength(0);
  expect(loads).toEqual([proposer]); // once; afterwards the mirror has them
  const failing = new MarketCreationService({ store: h.store, reviewerIds: new Set(), people: { get: () => undefined, load: async () => { throw new Error("down"); } } });
  expect(await failing.byMarket(eventPda)).toMatchObject({ proposer: null }); // attribution never fails the read
});
