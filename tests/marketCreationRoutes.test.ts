import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { marketCreationRouter } from "../src/api/marketCreation.ts";
import { appRouter } from "../src/api/router.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { proposalsReadiness, publishingReadiness, resolveMarketCreationConfig } from "../src/marketCreation/config.ts";
import { MarketCreationService } from "../src/marketCreation/MarketCreationService.ts";
import { PantaMarketCreator } from "../src/marketCreation/PantaMarketCreator.ts";
import { marketCreationFor, setMarketCreationRuntime } from "../src/marketCreation/runtime.ts";
import { InMemoryMarketProposalStore } from "../src/marketCreation/store.ts";
import { PANTA_MAINNET_PROGRAM_ID } from "../src/prediction/PantaTradingRuntime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { FakePanta, program, sign, wallet } from "./marketCreationFixtures.ts";

const proposer = "10000000-0000-4000-8000-000000000001";
const reviewer = "10000000-0000-4000-8000-0000000000aa";
const HOUR = 3_600_000;
const ENV = { PANTA_API_KEY: "pk_live_synthetic_create_routes", PANTA_PROGRAM_ID: PANTA_MAINNET_PROGRAM_ID, PANTA_SCHEMA_READY: "true",
  SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", SOLANA_NETWORK: "mainnet-beta",
  SOLANA_RPC_URL: "https://synthetic-rpc.invalid" };

async function rig() {
  const cfg = loadConfig(ENV);
  const app = await createApp({ config: cfg });
  const identity = new FakeIdentityStore().addUser("auth-proposer", proposer).addUser("auth-reviewer", reviewer);
  const verifier = new FakeJwtVerifier().issue("session-proposer", "auth-proposer").issue("session-reviewer", "auth-reviewer");
  primeAuthIdentityRuntime(cfg, { store: identity, verifier, policy: resolveAuthIdentityPolicy(cfg) });
  const panta = new FakePanta(() => Date.now());
  const creator = new PantaMarketCreator({ request: panta.request, upload: panta.upload, programId: program, maxFeeBaseUnits: "100000000" });
  const chain = { broadcasts: 0, async broadcast() { this.broadcasts++; }, async verifyTransaction() { return true; }, async failed() { return false; }, async neverLanded() { return false; } };
  const service = new MarketCreationService({ store: new InMemoryMarketProposalStore(), reviewerIds: new Set([reviewer]),
    people: { get: () => undefined }, publishing: { creator, chain, catalog: { ingest: async () => {} } } });
  setMarketCreationRuntime(cfg, { config: resolveMarketCreationConfig(cfg, {}), service,
    proposals: { enabled: true, reason: null }, publishing: { enabled: true, reason: null } });
  const as = (token?: string) => marketCreationRouter.createCaller({ app, ...(token ? { supabaseAccessToken: token } : {}) });
  return { app, cfg, panta, chain, as };
}
const draft = (key = "route-key-0001") => ({
  question: "Will SOL close above $300 on 31 Dec 2026?", category: "crypto" as const,
  closesAt: Date.now() + 72 * HOUR, resolvesAt: Date.now() + 73 * HOUR,
  rules: "Resolves YES if the CoinGecko SOL/USD daily close on 31 Dec 2026 UTC is above 300.",
  sources: ["https://www.coingecko.com/en/coins/solana"], idempotencyKey: key,
});

test("the router is mounted at marketCreation.* on the app router", () => {
  expect(Object.keys(appRouter._def.procedures)).toEqual(expect.arrayContaining([
    "marketCreation.status", "marketCreation.propose", "marketCreation.mine", "marketCreation.get", "marketCreation.withdraw",
    "marketCreation.reviewQueue", "marketCreation.review", "marketCreation.preparePublish", "marketCreation.submitPublish",
    "marketCreation.refreshPublish", "marketCreation.byMarket",
  ]));
});

test("writes need a verified Supabase session; wallet strings and client identities are refused", async () => {
  const h = await rig();
  await expect(h.as().propose(draft())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const walletOnly = marketCreationRouter.createCaller({ app: h.app, wallet: asWallet(wallet) });
  await expect(walletOnly.propose(draft())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(h.as("forged-token").mine({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(h.as("session-proposer").propose({ ...draft(), userId: reviewer } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(h.as("session-proposer").propose({ ...draft(), category: "gaming" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("status is public and tells a reviewer apart from everyone else", async () => {
  const h = await rig();
  const anonymous = await h.as().status();
  expect(anonymous).toMatchObject({ proposalsEnabled: true, publishingEnabled: true, viewerIsReviewer: false, attribution: "Powered by Panta" });
  expect(anonymous.rules.categories).toHaveLength(8);
  expect((await h.as("session-proposer").status()).viewerIsReviewer).toBe(false);
  expect((await h.as("session-reviewer").status()).viewerIsReviewer).toBe(true);
});

test("end to end through the router: propose, review, publish with a signed create, live", async () => {
  const h = await rig();
  const proposerCaller = h.as("session-proposer"), reviewerCaller = h.as("session-reviewer");
  const proposal = await proposerCaller.propose(draft());
  expect(proposal.status).toBe("pending_review");
  await expect(proposerCaller.review({ proposalId: proposal.id, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(proposerCaller.reviewQueue({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await reviewerCaller.reviewQueue({})).pending).toHaveLength(1);
  expect((await reviewerCaller.review({ proposalId: proposal.id, decision: "approve" })).status).toBe("approved");
  const review = await proposerCaller.preparePublish({ proposalId: proposal.id, wallet });
  expect(review.feeBaseUnits).toBe("50000000");
  expect(JSON.stringify(review)).not.toContain(ENV.PANTA_API_KEY);
  const live = await proposerCaller.submitPublish({ proposalId: proposal.id, sessionId: review.sessionId, signedTransaction: sign(review.transaction) });
  expect(live.status).toBe("live");
  expect(h.chain.broadcasts).toBe(1);
  expect(await h.as().byMarket({ venueMarketId: live.live!.venueMarketId })).toMatchObject({ proposalId: proposal.id });
  expect((await proposerCaller.mine({}))[0]!.status).toBe("live");
});

test("refusals map to readable transport codes", async () => {
  const h = await rig();
  const caller = h.as("session-proposer");
  await expect(caller.propose({ ...draft(), closesAt: Date.now() + HOUR, resolvesAt: Date.now() + HOUR }))
    .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("3 more hours") });
  const p = await caller.propose(draft("route-key-0002"));
  await expect(caller.preparePublish({ proposalId: p.id, wallet })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "This market is still waiting for review." });
  await expect(caller.get({ proposalId: "30000000-0000-4000-8000-000000000009" })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a server without the switches answers status and refuses actions", async () => {
  const cfg = loadConfig({ ...ENV });
  const app = await createApp({ config: cfg });
  const rt = marketCreationFor(cfg);
  expect(rt.proposals.enabled).toBe(false);
  const caller = marketCreationRouter.createCaller({ app });
  expect(await caller.status()).toMatchObject({ proposalsEnabled: false, publishingEnabled: false, reason: "Market proposals are not switched on yet." });
  await expect(caller.propose(draft())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(await caller.byMarket({ venueMarketId: wallet })).toBeNull();
});

test("readiness names exactly what is missing before money can move", () => {
  const base = loadConfig(ENV);
  const cfg = (env: Record<string, string>) => resolveMarketCreationConfig(base, env);
  expect(proposalsReadiness(base, cfg({})).reason).toContain("not switched on");
  expect(proposalsReadiness({ ...base, social: undefined } as AppConfig, cfg({ MARKET_PROPOSALS_ENABLED: "true" })).reason).toContain("account database");
  expect(proposalsReadiness(base, cfg({ MARKET_PROPOSALS_ENABLED: "true" })).enabled).toBe(true);
  expect(publishingReadiness(base, cfg({ MARKET_PROPOSALS_ENABLED: "true" })).reason).toContain("paused");
  const on = cfg({ MARKET_PROPOSALS_ENABLED: "true", MARKET_PUBLISHING_ENABLED: "true" });
  expect(publishingReadiness(base, on)).toEqual({ enabled: true, reason: null });
  expect(publishingReadiness({ ...base, predictions: { ...base.predictions, pantaSchemaReady: false } }, on).reason).toContain("schema");
  expect(publishingReadiness({ ...base, predictions: { ...base.predictions, panta: { ...base.predictions!.panta!, programId: wallet } } }, on).reason).toContain("program");
  expect(publishingReadiness({ ...base, solana: { ...base.solana, rpcUrl: "http://insecure.invalid" } }, on).reason).toContain("secure");
  const reviewers = cfg({ MARKET_REVIEWER_USER_IDS: ` ${reviewer.toUpperCase()}, not-a-uuid ,${proposer}` }).reviewerIds;
  expect([...reviewers]).toEqual([reviewer, proposer]);
  expect(cfg({ MARKET_CREATION_MAX_FEE_BASE_UNITS: "-5" }).maxFeeBaseUnits).toBe("100000000");
});
