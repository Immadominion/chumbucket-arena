/**
 * docs/money-api.md §g: reviewers only approve; the proposer publishes and
 * pays, from one of their own proven wallets. Always, whenever publishing is on.
 */
import { expect, test } from "bun:test";
import { MarketCreationService, type CreateChain, type ProposeInput } from "../src/marketCreation/MarketCreationService.ts";
import { PantaMarketCreator } from "../src/marketCreation/PantaMarketCreator.ts";
import { InMemoryMarketProposalStore } from "../src/marketCreation/store.ts";
import type { AccountWalletStatus } from "../src/wallet/accountWallets.ts";
import { TestClock } from "./predictionFixtures.ts";
import { FakePanta, program, sign, wallet } from "./marketCreationFixtures.ts";

const HOUR = 3_600_000;
const proposer = "10000000-0000-4000-8000-000000000001";
const reviewer = "10000000-0000-4000-8000-0000000000aa";

class Chain implements CreateChain {
  broadcasts = 0; verified = true;
  async broadcast() { this.broadcasts++; }
  async verifyTransaction() { return this.verified; }
  async failed() { return false; }
  async neverLanded() { return false; }
}

function rig(checkWallets = true) {
  const clock = new TestClock();
  let ids = 0;
  const store = new InMemoryMarketProposalStore(() => clock.now());
  const panta = new FakePanta(() => clock.now());
  const chain = new Chain();
  const links = new Map<string, AccountWalletStatus>([[`${proposer}:${wallet}`, "active"]]);
  let linksDown = false;
  const service = new MarketCreationService({
    store, reviewerIds: new Set([reviewer]), now: () => clock.now(),
    newId: () => `20000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    people: { get: () => undefined },
    publishing: { creator: new PantaMarketCreator({ request: panta.request, upload: panta.upload, programId: program, maxFeeBaseUnits: "100000000", clock }),
      chain, catalog: { ingest: async () => {} } },
    wallets: checkWallets ? { status: async (userId, address) => {
      if (linksDown) throw new Error("synthetic read failure");
      return links.get(`${userId}:${address}`) ?? "none";
    } } : null,
  });
  const input: ProposeInput = {
    question: "Will ETH close above $5,000 on 1 Jan 2027?", category: "crypto",
    closesAt: clock.now() + 72 * HOUR, resolvesAt: clock.now() + 73 * HOUR,
    rules: "Resolves YES if the CoinGecko ETH/USD daily close on 1 Jan 2027 UTC is above 5000.",
    sources: ["https://www.coingecko.com/en/coins/ethereum"], description: null, idempotencyKey: "proposal-key-0001",
  };
  const approved = async () => {
    const p = await service.propose(proposer, input);
    await service.review(reviewer, p.id, { approve: true });
    return p;
  };
  return { service, store, chain, links, approved, linksDown: () => { linksDown = true; } };
}

test("a reviewer approves but cannot publish or pay; canPublish is the proposer's alone", async () => {
  const h = rig();
  const p = await h.approved();
  await expect(h.service.preparePublish(reviewer, p.id, wallet)).rejects.toMatchObject({
    code: "MC_FORBIDDEN", message: "Only the person who proposed this market can publish it." });
  expect((await h.service.get(reviewer, p.id)).canPublish).toBe(false);
  expect((await h.service.get(proposer, p.id)).canPublish).toBe(true);
  expect((await h.service.reviewQueue(reviewer)).approved.map(v => v.canPublish)).toEqual([false]);
});

test("the proposer publishes from their own proven wallet", async () => {
  const h = rig();
  const p = await h.approved();
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  const live = await h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction));
  expect(live.status).toBe("live");
  expect(h.store.proposals.get(p.id)).toMatchObject({ published_by: proposer, creator_wallet: wallet });
});

test("a wallet that is not the proposer's is refused before any quote; a session's own sign-in wallet is accepted", async () => {
  const h = rig();
  const p = await h.approved();
  h.links.set(`${proposer}:${wallet}`, "other");
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_FORBIDDEN", message: "Link this wallet to your account first" });
  h.links.set(`${proposer}:${wallet}`, "revoked");
  await expect(h.service.preparePublish(proposer, p.id, wallet, { signInWallet: wallet })).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  h.links.delete(`${proposer}:${wallet}`);
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  expect((await h.service.preparePublish(proposer, p.id, wallet, { signInWallet: wallet })).wallet).toBe(wallet);
});

test("a link revoked after the review stops the signed create; unreadable links refuse", async () => {
  const h = rig();
  const p = await h.approved();
  const review = await h.service.preparePublish(proposer, p.id, wallet);
  h.links.set(`${proposer}:${wallet}`, "revoked");
  await expect(h.service.submitPublish(proposer, p.id, review.sessionId, sign(review.transaction))).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  expect(h.chain.broadcasts).toBe(0);
  h.links.set(`${proposer}:${wallet}`, "active");
  h.linksDown();
  await expect(h.service.preparePublish(proposer, p.id, wallet)).rejects.toMatchObject({ code: "MC_UNVERIFIED" });
});

test("proposer-only holds whatever the money flag: a reviewer is refused even with no wallet check composed", async () => {
  const h = rig(false);
  const p = await h.approved();
  await expect(h.service.preparePublish(reviewer, p.id, wallet)).rejects.toMatchObject({ code: "MC_FORBIDDEN" });
  expect((await h.service.get(reviewer, p.id)).canPublish).toBe(false);
});
