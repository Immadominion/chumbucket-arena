import { expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { MarketCreationError } from "../src/marketCreation/errors.ts";
import { cloudinaryUpload, pantaCreatePost, PantaMarketCreator, CREATE_POLICY, formatUsdc } from "../src/marketCreation/PantaMarketCreator.ts";
import { normalizeDraft, PANTA_MIN_START_DELAY_S, START_MARGIN_S, type MarketDraft } from "../src/marketCreation/rules.ts";
import { TestClock } from "./predictionFixtures.ts";
import { COVER_URL, eventPda, FakePanta, FEE, program, synthetic, TOKEN, wallet, ata } from "./marketCreationFixtures.ts";

const HOUR = 3_600_000;
function rig(maxFee = "100000000") {
  const clock = new TestClock();
  const panta = new FakePanta(() => clock.now());
  const creator = new PantaMarketCreator({ request: panta.request, upload: panta.upload, programId: program, maxFeeBaseUnits: maxFee, clock });
  const draft = normalizeDraft({ question: "Will ETH close above $5,000 on 1 Jan 2027?", category: "crypto",
    closesAt: clock.now() + 72 * HOUR, resolvesAt: clock.now() + 73 * HOUR,
    rules: "Resolves YES if the CoinGecko ETH/USD daily close on 1 Jan 2027 UTC is above 5000.",
    sources: ["https://www.coingecko.com/en/coins/ethereum"], description: "A synthetic test market." }) as MarketDraft & { category: "crypto" };
  return { clock, panta, creator, draft };
}
const prepare = (h: ReturnType<typeof rig>) => h.creator.prepare({ wallet, draft: h.draft, imageUrl: COVER_URL });

test("quote + build produce a bounded binding with the fee breakdown and earliest start", async () => {
  const h = rig();
  const binding = await prepare(h);
  expect(binding).toMatchObject({ version: 1, policy: CREATE_POLICY, createId: "cr_synthetic_1", eventPda, wallet, programId: program,
    paymentBaseUnits: FEE, liquidityBaseUnits: "10000000", platformBaseUnits: "40000000", category: "crypto", imageUrl: COVER_URL });
  expect(binding.startTime).toBe(Math.ceil(h.clock.now() / 1000) + PANTA_MIN_START_DELAY_S + START_MARGIN_S);
  expect(binding.expiresAt).toBe(h.clock.now() + 60_000);
  const quote = h.panta.calls.find(call => call.path === "/markets/create/quote/")!.body;
  expect(quote).toMatchObject({ wallet, question: h.draft.question, resolutionRule: h.draft.rules, sourcesOfTruth: h.draft.sources,
    category: "crypto", marketType: "standard", imageUrl: COVER_URL, description: "A synthetic test market." });
  expect(quote).not.toHaveProperty("eventInProgress");
  expect(h.panta.calls.map(call => call.path)).toEqual(["/markets/create/quote/", "/markets/create/build/"]);
  expect(h.creator.validateBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
  expect(formatUsdc(FEE)).toBe("50.00");
});

test("a fee above the server cap is refused before any wallet sees a transaction", async () => {
  const h = rig("40000000");
  await expect(prepare(h)).rejects.toMatchObject({ code: "MC_FEE_TOO_HIGH" });
  expect(h.panta.count("/markets/create/build/")).toBe(0);
});

test("an inconsistent fee breakdown or mismatched echo fails closed", async () => {
  const a = rig(); a.panta.liquidity = "1"; await expect(prepare(a)).rejects.toMatchObject({ code: "MC_SCHEMA" });
  const b = rig(); b.panta.overrides["/markets/create/build/"] = () => ({ ...{}, createId: "cr_other" });
  await expect(prepare(b)).rejects.toMatchObject({ code: "MC_SCHEMA" });
  const c = rig(); const original = c.panta.request;
  c.panta.overrides["/markets/create/build/"] = async () => {
    delete c.panta.overrides["/markets/create/build/"];
    const body = await original("/markets/create/build/", {}) as Record<string, unknown>;
    return { ...body, derived: { event: synthetic(9) } };
  };
  await expect(prepare(c)).rejects.toMatchObject({ code: "MC_SCHEMA" });
});

test("transaction policy: foreign payer, extra signer, SOL transfer, token transfer and unwritten event are refused", async () => {
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(11));
  const cases: [string, FakePanta["tx"]][] = [
    ["foreign payer", { payer: stranger.publicKey.toBase58() }],
    ["system transfer", { extra: [SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: new PublicKey(synthetic(12)), lamports: 1 })] }],
    ["token transfer", { extra: [new TransactionInstruction({ programId: new PublicKey(TOKEN), data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      keys: [{ pubkey: new PublicKey(ata(wallet)), isSigner: false, isWritable: true }, { pubkey: new PublicKey(synthetic(13)), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(wallet), isSigner: true, isWritable: false }] })] }],
    ["second signer", { extra: [new TransactionInstruction({ programId: new PublicKey(program), data: Buffer.from([0]),
      keys: [{ pubkey: stranger.publicKey, isSigner: true, isWritable: false }, { pubkey: new PublicKey(wallet), isSigner: true, isWritable: true }] })] }],
    ["event not written", { omitEventWrite: true }],
    ["stale blockhash", { blockhashValue: synthetic(14) }],
    ["already signed", { sign: Keypair.fromSeed(new Uint8Array(32).fill(7)) }],
  ];
  for (const [label, shape] of cases) {
    const h = rig(); h.panta.tx = shape;
    const result = await prepare(h).then(() => "accepted", (error: MarketCreationError) => error.code);
    expect(`${label}: ${result}`).toBe(`${label}: MC_SCHEMA`);
  }
});

test("register must echo the expected event address", async () => {
  const h = rig(); const binding = await prepare(h);
  const sig = "5".repeat(87);
  expect(await h.creator.register(binding, sig)).toEqual({ marketId: eventPda });
  h.panta.overrides["/markets/register/"] = body => ({ createId: body.createId, marketId: synthetic(15), status: "registered", signature: body.signature });
  await expect(h.creator.register(binding, sig)).rejects.toMatchObject({ code: "MC_SCHEMA" });
  await expect(h.creator.register(binding, "not-a-signature")).rejects.toMatchObject({ code: "MC_INVALID" });
});

test("a tampered stored binding is refused", async () => {
  const h = rig(); const binding = await prepare(h);
  for (const tampered of [{ ...binding, paymentBaseUnits: "1" }, { ...binding, programId: synthetic(16) },
    { ...binding, messageHash: "0".repeat(64) }, { ...binding, expiresAt: binding.createdAt + 600_000 }]) {
    expect(() => h.creator.validateBinding(tampered)).toThrow(MarketCreationError);
  }
});

test("cover upload uses Panta's signed form and returns the Cloudinary URL", async () => {
  const h = rig();
  expect(await h.creator.uploadCover("sports")).toBe(COVER_URL);
  expect(h.panta.uploads).toHaveLength(1);
  expect(h.panta.uploads[0]!.fields).toMatchObject({ api_key: "public-cloudinary-id", timestamp: "1", public_id: "usr_test/cover" });
  expect(h.panta.uploads[0]!.bytes).toBeGreaterThan(1000);
  h.panta.overrides["/markets/create/image-upload/"] = () => ({ uploadUrl: "https://evil.example.com/upload", publicId: "x", fields: {} });
  await expect(h.creator.uploadCover("sports")).rejects.toMatchObject({ code: "MC_SCHEMA" });
});

test("transport reduces refusals to allowlisted codes and never forwards provider text", async () => {
  const key = "pk_live_synthetic_create_transport";
  const respond = (status: number, body: unknown) => Object.assign(async () => new Response(JSON.stringify(body), { status }), { preconnect: fetch.preconnect }) as typeof fetch;
  const post = (status: number, body: unknown) => pantaCreatePost(key, { fetchImpl: respond(status, body) })("/markets/create/quote/", {});
  await expect(post(400, { code: "INVALID_MARKET_PARAMS", message: "startTime must be at least 3600s ahead <script>", field: "startTime" }))
    .rejects.toMatchObject({ code: "MC_PANTA_REFUSED", providerCode: "INVALID_MARKET_PARAMS", field: "startTime", message: "Panta refused the start time for this market. Edit it and propose again." });
  await expect(post(400, { code: "INVALID_MARKET_PARAMS", message: "x", fields: { imageUrl: ["bad"] } })).rejects.toMatchObject({ field: "imageUrl" });
  await expect(post(400, { code: "DUPLICATE_MARKET", message: "dup" })).rejects.toMatchObject({ code: "MC_PANTA_REFUSED", providerCode: "DUPLICATE_MARKET" });
  await expect(post(403, { code: "CREATE_NOT_PERMITTED" })).rejects.toMatchObject({ providerCode: "CREATE_NOT_PERMITTED" });
  await expect(post(400, { code: "SOMETHING_NEW", message: "leak", field: "secretField" })).rejects.toMatchObject({ code: "MC_PANTA_REFUSED", providerCode: undefined, field: undefined });
  await expect(post(429, { code: "RATE_LIMITED" })).rejects.toMatchObject({ code: "MC_RATE_LIMITED" });
  await expect(post(401, { code: "UNAUTHORIZED" })).rejects.toMatchObject({ code: "MC_PANTA_UNAVAILABLE" });
  await expect(post(502, "<html>")).rejects.toMatchObject({ code: "MC_PANTA_UNAVAILABLE" });
  await expect(post(200, { demo: true })).rejects.toMatchObject({ code: "MC_SCHEMA" });
  await expect(post(200, { echoed: key })).rejects.toMatchObject({ code: "MC_SCHEMA" });
  expect(() => pantaCreatePost("pk_test_sandbox")).toThrow(MarketCreationError);
  await expect(pantaCreatePost(key, { fetchImpl: respond(200, {}) })("/primaryorderquote/" as never, {})).rejects.toMatchObject({ code: "MC_DISABLED" });
  let sent: RequestInit | undefined;
  const capture = Object.assign(async (_url: unknown, init?: RequestInit) => { sent = init; return new Response("{}"); }, { preconnect: fetch.preconnect }) as typeof fetch;
  await pantaCreatePost(key, { fetchImpl: capture })("/markets/create/quote/", { a: 1 });
  expect((sent!.headers as Record<string, string>)["X-Api-Key"]).toBe(key);
  expect(sent!.redirect).toBe("error");
});

test("cloudinary upload refuses any destination other than Cloudinary's image upload", async () => {
  const upload = cloudinaryUpload({ fetchImpl: Object.assign(async () => new Response(JSON.stringify({ secure_url: COVER_URL })), { preconnect: fetch.preconnect }) as typeof fetch });
  expect(await upload("https://api.cloudinary.com/v1_1/synthetic/image/upload", { a: "b" }, new Uint8Array([1]))).toEqual({ secure_url: COVER_URL });
  await expect(upload("https://api.cloudinary.com.evil.com/v1_1/x/image/upload", {}, new Uint8Array([1]))).rejects.toMatchObject({ code: "MC_SCHEMA" });
});
