import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { PantaPreparedOrder, PantaVerifiedOrder } from "../src/prediction/PantaExecution.ts";
import { sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";

// Opt-in only. The verifier creates the URL; normal bun test never connects.
const url = process.env.PANTA_TRADING_TEST_DATABASE_URL;
const local = url ? describe : describe.skip;
if (!url) console.info("SKIP Panta trading PostgreSQL: PANTA_TRADING_TEST_DATABASE_URL unset; run bun --no-env-file scripts/verify-panta-trading-local.ts --run");
const migrationDir = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");
const tradeMigration = "20260929120000_panta_trade_sessions.sql";
const migrationFiles = [
  "20260913120000_auth_identity_auth_user_link.sql",
  "20260913130000_venue_market_catalog.sql",
  "20260913130500_venue_market_resolutions.sql",
  "20260913140000_social_calls_calls.sql",
  "20260928210000_panta_share_price_evidence.sql",
  tradeMigration,
];
const applied = new Map<string, string>();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let db: SQL | undefined;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function database(): SQL { check(db, "Disposable database is not initialized"); return db; }
type Role = "anon" | "authenticated" | "service_role" | "owner";
async function asRole<T>(role: Role, action: (tx: SQL) => Promise<T>, authId?: string): Promise<T> {
  return database().begin(async tx => {
    if (role !== "owner") await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role, ...(authId ? { sub: authId } : {}) })}, true)`;
    return action(tx);
  });
}
class AcceptedMutation extends Error {}
// Always roll back probes, even when a guard unexpectedly permits the write.
async function rejectsMutation(action: (tx: SQL) => Promise<unknown>, pattern: RegExp, role: Role = "service_role", authId?: string) {
  try {
    await asRole(role, async tx => { await action(tx); throw new AcceptedMutation("Mutation unexpectedly accepted"); }, authId);
  } catch (error) {
    if (error instanceof AcceptedMutation) return false;
    check(error instanceof Error, "Expected a PostgreSQL rejection");
    expect(error.message).toMatch(pattern);
    return true;
  }
  throw new Error("Probe did not roll back");
}
async function rejectCases(cases: [string, (tx: SQL) => Promise<unknown>][], pattern: RegExp, role: Role = "service_role") {
  const accepted: string[] = [];
  for (const [label, action] of cases) if (!await rejectsMutation(action, pattern, role)) accepted.push(label);
  if (accepted.length) throw new Error(`GUARD GAP: accepted ${accepted.join("; ")}`);
}
async function acceptsMutation(action: (tx: SQL) => Promise<unknown>) {
  try { await asRole("service_role", async tx => { await action(tx); throw new AcceptedMutation(); }); }
  catch (error) { if (error instanceof AcceptedMutation) return; throw error; }
  throw new Error("Positive probe did not roll back");
}
function atPath(value: object, path: readonly string[], replacement: unknown, remove = false) {
  // JSON round-trip mirrors JSONB: core can share object references between
  // order/unsignedOrder or review/binding.review; stored JSON does not.
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const key = path.at(-1)!;
  if (remove) delete parent[key]; else parent[key] = replacement;
  return copy;
}

// Synthetic base58 bytes; no keypair, private key, wallet signing or RPC exists.
function syntheticBase58(label: string, size = 32) {
  const bytes = Buffer.concat([createHash("sha256").update(label).digest(), createHash("sha256").update(`${label}:tail`).digest()]).subarray(0, size);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${bytes.toString("hex")}`), result = "";
  while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = "1" + result; }
  return result;
}

local("Panta funded intent — fresh owner-only PostgreSQL 15", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    check(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname === "127.0.0.1"
      && Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535
      && parsed.username === "panta_trading_test_admin" && !parsed.password && !parsed.search && !parsed.hash
      && /^\/chumbucket_panta_trading_test_[0-9a-f]{12}$/.test(parsed.pathname), "Refusing non-disposable database target");
    db = new SQL(url!, { max: 2, connectionTimeout: 5 });
    const [server] = await db`SELECT current_setting('data_directory') AS dir,
      current_setting('listen_addresses') AS listen, current_setting('port') AS port,
      current_setting('server_version_num')::integer AS version, current_database() AS name,
      current_user AS username, pg_postmaster_start_time() AS started`;
    check(/^\/private\/tmp\/chumbucket-panta-trading\.[A-Za-z0-9]{8}\/data$/.test(server.dir)
      && server.listen === "127.0.0.1" && server.port === parsed.port
      && server.version >= 150000 && server.version < 160000 && server.username === parsed.username
      && server.name === parsed.pathname.slice(1) && Date.now() - new Date(server.started).getTime() < 600000,
      "Require a fresh task-prefixed PostgreSQL 15 cluster on loopback");
    for (const path of [server.dir, dirname(server.dir)]) {
      const stat = statSync(path);
      check(realpathSync(path) === path && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
        "Disposable data and scratch directories must be owner-only and owned by this user");
    }
    const [existing] = await db`SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') AS relations,
      (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') AS functions`;
    check(existing.relations === 0 && existing.functions === 0, "Require a new empty database; refusing to overwrite existing objects");
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
      $$;
      CREATE TABLE public.users(id UUID PRIMARY KEY, wallet_address TEXT UNIQUE, full_name TEXT, handle TEXT UNIQUE);
      CREATE TABLE public.follows(follower_user_id UUID REFERENCES public.users(id), followee_user_id UUID REFERENCES public.users(id));
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
      CREATE TABLE public.legacy_default_grant_canary(id UUID PRIMARY KEY);
    `);
    for (const file of migrationFiles) {
      const source = readFileSync(join(migrationDir, file), "utf8");
      await db.unsafe(source);
      applied.set(file, sha(source));
    }
    console.info(`APPLIED ${tradeMigration} sha256=${applied.get(tradeMigration)}`);
  }, 30000);
  afterAll(async () => {
    try {
      for (const [file, hash] of applied) check(sha(readFileSync(join(migrationDir, file))) === hash,
        `${file} changed during verification; rerun against the new source`);
    } finally { await db?.end(); db = undefined; }
  });

  async function fixture(venue: "panta" | "fixture" = "panta") {
    const user = randomUUID(), other = randomUUID(), auth = randomUUID(), otherAuth = randomUUID();
    const market = randomUUID(), venueMarketId = syntheticBase58(`market:${market}`);
    const wallet = syntheticBase58(`wallet:${user}`), otherWallet = syntheticBase58(`wallet:${other}`);
    const at = Date.now();
    const snapshot = sharePriceFromIndicative({ marketId: market, venueMarketId, venue: "panta", currency: "USDC",
      unit: "per_share", yesPrice: "1.250000000000000001", noPrice: "0.35", observedAt: at,
      executable: false, attribution: "Powered by Panta", demo: false });
    const raw = { venue: "panta", venueMarketId, payloadVersion: 1, fetchedAt: at,
      body: { yesPrice: snapshot.yesPrice, noPrice: snapshot.noPrice } };
    const sql = database();
    await sql`INSERT INTO auth.users(id) VALUES (${auth}),(${otherAuth})`;
    await sql`INSERT INTO public.users(id,wallet_address,auth_user_id)
      VALUES (${user},${wallet},${auth}),(${other},${otherWallet},${otherAuth})`;
    await sql`INSERT INTO public.venue_markets(id,venue,venue_event_id,venue_market_id,question,rules_text,outcomes,status,raw_status,opens_at,closes_at,payload_version,raw_payload)
      VALUES (${market},${venue},${market},${venueMarketId},'Synthetic local question','Synthetic exact rules',
        '[{"side":"YES"},{"side":"NO"}]','OPEN','primary',now()-interval '1 hour',now()+interval '1 hour',1,'{"synthetic":true}')`;
    if (venue === "panta") await asRole("service_role", tx => tx`INSERT INTO public.market_share_price_snapshots(id,market_id,observed_at,snapshot,raw_evidence)
      VALUES (${snapshot.id},${market},${new Date(at)},${snapshot}::jsonb,${raw}::jsonb)`.execute());
    const call = randomUUID(), otherCall = randomUUID();
    for (const [id, author, side] of [[call, user, "YES"], [otherCall, other, "NO"]]) {
      await asRole("service_role", tx => tx`INSERT INTO public.calls(id,user_id,market_id,side,visibility,share_price_snapshot_id,entry_price)
        VALUES (${id},${author},${market},${side},'followers',${venue === "panta" ? snapshot.id : null},${venue === "panta" ? snapshot : null}::jsonb)`.execute());
    }
    return { user, other, auth, otherAuth, market, venueMarketId, wallet, otherWallet, snapshot, call, otherCall };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function intent(f: Fixture, other = false) {
    const id = randomUUID();
    return { id, user_id: other ? f.other : f.user, call_id: other ? f.otherCall : f.call,
      market_id: f.market, wallet_address: other ? f.otherWallet : f.wallet, venue_market_id: f.venueMarketId,
      side: other ? "NO" : "YES", amount_base_units: "2500000", max_slippage_bps: 100,
      idempotency_key: `synthetic-${id}`, request_fingerprint: sha(`synthetic-intent:${id}`) };
  }
  type Intent = ReturnType<typeof intent>;
  async function evidence(i: Intent) {
    const orderId = `synthetic-order-${i.id}`, quoteId = `synthetic-quote-${i.id}`, now = Date.now();
    const expiresAt = now + 240000, programId = syntheticBase58("synthetic-program"), side = i.side as "YES" | "NO";
    const nativeSide = side === "YES" ? "yes" : "no";
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const owner = new PublicKey(i.wallet_address);
    const ata = PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(),
      new PublicKey(usdcMint).toBuffer()], new PublicKey(ataProgram))[0].toBase58();
    const derived: PantaPreparedOrder["binding"]["derived"] = {
      userPosition: syntheticBase58(`position:${i.id}`), marketConfig: syntheticBase58(`config:${i.id}`),
      userTokenAccount: ata, vaultTokenAccount: syntheticBase58(`vault-token:${i.id}`),
      treasuryTokenAccount: syntheticBase58(`treasury-token:${i.id}`), vaultAuthority: syntheticBase58(`vault-authority:${i.id}`),
    };
    const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isWritable, isSigner });
    const buyData = Buffer.alloc(17);
    createHash("sha256").update("global:primary_order_usdc").digest().copy(buyData, 0, 0, 8);
    buyData[8] = side === "YES" ? 0 : 1; buyData.writeBigUInt64LE(BigInt(i.amount_base_units), 9);
    // Construct the current typed wire DTO directly. This suite tests SQL
    // persistence, independently of the actively-changing execution guard.
    const instructions = [
      new TransactionInstruction({ programId: new PublicKey(ataProgram), data: Buffer.from([1]), keys: [
        meta(i.wallet_address, true, true), meta(ata, true), meta(i.wallet_address), meta(usdcMint),
        meta(SystemProgram.programId.toBase58()), meta(tokenProgram),
      ] }),
      new TransactionInstruction({ programId: new PublicKey(programId), data: buyData, keys: [
        meta(i.wallet_address, true, true), meta(i.venue_market_id, true), meta(derived.marketConfig),
        meta(derived.vaultAuthority), meta(derived.vaultTokenAccount, true), meta(derived.userPosition, true),
        meta(usdcMint), meta(ata, true), meta(derived.treasuryTokenAccount, true), meta(tokenProgram),
        meta(ataProgram), meta(SystemProgram.programId.toBase58()),
      ] }),
      new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(`panta:v1:usr_synthetic_partner:${quoteId}:${orderId}`), keys: [meta(i.wallet_address, false, true)] }),
    ];
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: syntheticBase58(`blockhash:${i.id}`), instructions }).compileToV0Message();
    const payload = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    const review: PantaPreparedOrder["review"] = { amountUsdc: "2.500000", amountBaseUnits: i.amount_base_units,
      avgPrice: "1.25", feeUsdc: "0.01", expectedShares: "1.992", maxSlippageBps: i.max_slippage_bps,
      currency: "USDC", priceUnit: "USDC/share", sharesUnit: "shares", quotedProbability: null, attribution: "Powered by Panta" };
    const order = { orderId, venue: "panta", venueMarketId: i.venue_market_id, owner: i.wallet_address, side,
      amountBaseUnits: i.amount_base_units, quotedProbability: null, fundingState: "QUOTED",
      transaction: { venue: "panta", encoding: "solana-tx-base64", payload, expiresAt, demo: false },
      idempotencyKey: i.idempotency_key, createdAt: now, expiresAt, demo: false } satisfies PantaPreparedOrder["order"];
    const prepared: PantaPreparedOrder = { order, review, binding: { version: 1, quoteId, providerOrderId: orderId,
      owner: i.wallet_address, venueMarketId: i.venue_market_id, side, amountBaseUnits: i.amount_base_units,
      amountUsdc: "2.500000", idempotencyKey: i.idempotency_key, canonicalUserId: i.user_id,
      providerAttributionUserId: "usr_synthetic_partner", programId,
      createdAt: now, expiresAt, lastValidBlockHeight: 100000, signature: null, messageHash: sha(Buffer.from(message.serialize())),
      derived, unsignedOrder: order, review } };
    const signature = syntheticBase58(`synthetic-signature:${i.id}`, 64);
    // Stored signed_transaction is intentionally a dummy; no transaction is
    // signed or broadcast, and independentlyVerified is synthetic fixture data.
    const signed = Buffer.from(`synthetic signed bytes:${i.id}; NOT a signature or a Solana transaction`).toString("base64");
    const fill: PantaVerifiedOrder = { orderId, venueOrderId: orderId, venue: "panta", venueMarketId: i.venue_market_id,
      owner: i.wallet_address, side, amountBaseUnits: i.amount_base_units, filledBaseUnits: i.amount_base_units,
      fundingState: "FILLED", fillTxSignature: signature, createdAt: now, updatedAt: now, idempotencyKey: i.idempotency_key, demo: false,
      fillEvidence: { providerVerify: { orderId, status: "confirmed", signature, wallet: i.wallet_address,
        marketId: i.venue_market_id, side: nativeSide, amountUsdc: i.amount_base_units },
      providerTrade: { signature, status: "processed", marketId: i.venue_market_id, wallet: i.wallet_address, side: nativeSide, kind: "buy" },
      messageHash: prepared.binding.messageHash, independentlyVerified: true, expectedShares: review.expectedShares } };
    return { prepared, orderId, signature, signed, fill };
  }
  async function insert(i: Intent, patch: Record<string, unknown> = {}) {
    return asRole("service_role", async tx => (await tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, ...patch })} RETURNING *`)[0]);
  }
  function write(tx: SQL, id: string, patch: Record<string, unknown>) {
    return tx`UPDATE public.panta_trade_sessions SET ${tx(patch)} WHERE id=${id} RETURNING *`.execute();
  }
  async function update(id: string, patch: Record<string, unknown>) {
    try { return await asRole("service_role", tx => write(tx, id, patch)); }
    catch (error) {
      if (error instanceof Error && "errno" in error) throw new Error(`Transition ${String(patch.state ?? "update")}: SQLSTATE ${String(error.errno)}; ${error.message}`);
      throw error;
    }
  }
  type State = "PREPARING" | "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED";
  async function session(state: State = "PREPARING", f = undefined as Fixture | undefined, other = false) {
    f ??= await fixture();
    const i = intent(f, other), e = await evidence(i);
    await insert(i);
    if (["QUOTED", "SUBMITTED", "FILLED"].includes(state)) await update(i.id, { state: "QUOTED", provider_order_id: e.orderId, prepared: e.prepared });
    if (["SUBMITTED", "FILLED"].includes(state)) await update(i.id, { state: "SUBMITTED", signed_transaction: e.signed, signature: e.signature });
    if (state === "FILLED") await update(i.id, { state: "FILLED", fill_evidence: e.fill });
    if (state === "FAILED") await update(i.id, { state: "FAILED" });
    return { f, i, e };
  }

  test("real price/call evidence and canonical auth mapping exist; legacy default grants are broad", async () => {
    const f = await fixture(), sql = database();
    for (const [auth, user] of [[f.auth, f.user], [f.otherAuth, f.other]]) {
      const [identity] = await asRole("authenticated", tx => tx`SELECT auth.uid() AS auth, public.current_app_user_id() AS canonical`.execute(), auth);
      expect(identity).toEqual({ auth, canonical: user }); expect(auth).not.toBe(user);
    }
    for (const role of ["anon", "authenticated"]) {
      const [rights] = await sql`SELECT has_table_privilege(${role},'public.legacy_default_grant_canary','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS wide`;
      expect(rights.wide).toBe(true);
    }
    const [call] = await sql`SELECT entry_price,entry_probability,snapshot_id,funding_state FROM public.calls WHERE id=${f.call}`;
    expect(call).toEqual({ entry_price: f.snapshot, entry_probability: null, snapshot_id: null, funding_state: "NONE" });
    await asRole("service_role", tx => tx`INSERT INTO public.market_resolutions(market_id,venue,venue_market_id,resolution,resolved_at,evidence_source,raw_evidence)
      VALUES (${f.market},'panta',${f.venueMarketId},'YES',now(),'synthetic-only','{"synthetic":true}')`.execute());
    expect(await rejectsMutation(tx => tx`INSERT INTO public.calls(user_id,market_id,side,share_price_snapshot_id,entry_price)
      VALUES (${f.user},${f.market},'YES',${f.snapshot.id},${f.snapshot}::jsonb)`.execute(), /answer is public/)).toBe(true);
  });

  test("RLS enabled, no client policies, no inherited table/column/function privileges", async () => {
    const sql = database();
    const [rls] = await sql`SELECT relrowsecurity FROM pg_class WHERE oid='public.panta_trade_sessions'::regclass`;
    expect(rls.relrowsecurity).toBe(true);
    expect(await sql`SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='panta_trade_sessions'`).toHaveLength(0);
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect((await sql`SELECT has_table_privilege(${role},'public.panta_trade_sessions',${privilege}) AS allowed`)[0].allowed).toBe(false);
      }
      for (const column of ["id", "user_id", "prepared", "signed_transaction", "signature", "fill_evidence"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
          expect((await sql`SELECT has_column_privilege(${role},'public.panta_trade_sessions',${column},${privilege}) AS allowed`)[0].allowed).toBe(false);
        }
      }
      expect((await sql`SELECT has_function_privilege(${role},'public.panta_trade_session_guard_v1()','EXECUTE') AS allowed`)[0].allowed).toBe(false);
    }
    const [fn] = await sql`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.panta_trade_session_guard_v1()'::regprocedure`;
    expect(fn.prosecdef).toBe(true); expect(fn.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
    expect((await sql`SELECT count(*)::integer AS count FROM pg_trigger WHERE tgrelid='public.panta_trade_sessions'::regclass AND NOT tgisinternal`)[0].count).toBe(2);
  });

  test("anon and both authenticated people cannot directly SELECT prepared or signed rows or write sessions", async () => {
    const s = await session("SUBMITTED"), sql = database();
    for (const [role, auth] of [["anon", undefined], ["authenticated", s.f.auth], ["authenticated", s.f.otherAuth]] as const) {
      for (const select of ["*", "id", "prepared", "signed_transaction", "signature", "fill_evidence"]) {
        await expect(asRole(role, tx => tx.unsafe(`SELECT ${select} FROM public.panta_trade_sessions WHERE id=$1`, [s.i.id]).execute(), auth)).rejects.toThrow(/permission denied/);
      }
      const fresh = intent(s.f);
      for (const action of [
        (tx: SQL) => tx`INSERT INTO public.panta_trade_sessions ${tx(fresh)}`.execute(),
        (tx: SQL) => write(tx, s.i.id, { state: "FAILED" }),
        (tx: SQL) => tx`DELETE FROM public.panta_trade_sessions WHERE id=${s.i.id}`.execute(),
        (tx: SQL) => tx`TRUNCATE public.panta_trade_sessions`.execute(),
      ]) expect(await rejectsMutation(action, /permission denied/, role, auth)).toBe(true);
    }
    expect((await sql`SELECT signed_transaction FROM public.panta_trade_sessions WHERE id=${s.i.id}`)[0].signed_transaction).toBe(s.e.signed);
  });

  test("service has SELECT/INSERT and only the transition-column UPDATE grant", async () => {
    const sql = database();
    for (const privilege of ["SELECT", "INSERT"]) expect((await sql`SELECT has_table_privilege('service_role','public.panta_trade_sessions',${privilege}) AS allowed`)[0].allowed).toBe(true);
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) expect((await sql`SELECT has_table_privilege('service_role','public.panta_trade_sessions',${privilege}) AS allowed`)[0].allowed).toBe(false);
    for (const column of ["state", "provider_order_id", "prepared", "signed_transaction", "signature", "fill_evidence", "updated_at"])
      expect((await sql`SELECT has_column_privilege('service_role','public.panta_trade_sessions',${column},'UPDATE') AS allowed`)[0].allowed).toBe(true);
    const s = await session();
    expect(await rejectsMutation(tx => write(tx, s.i.id, { amount_base_units: "3000000" }), /permission denied/)).toBe(true);
  });

  test("two-user service queries scope order/idempotency lookup to the canonical user; followers privacy survives", async () => {
    const f = await fixture(), a = await session("SUBMITTED", f), b = await session("QUOTED", f, true);
    for (const [user, own, other] of [[f.user, a, b], [f.other, b, a]] as const) {
      expect(await asRole("service_role", tx => tx`SELECT id FROM public.panta_trade_sessions WHERE user_id=${user} AND provider_order_id=${own.e.orderId}`.execute())).toEqual([{ id: own.i.id }]);
      expect(await asRole("service_role", tx => tx`SELECT id FROM public.panta_trade_sessions WHERE user_id=${user} AND provider_order_id=${other.e.orderId}`.execute())).toHaveLength(0);
      expect(await asRole("service_role", tx => tx`SELECT id FROM public.panta_trade_sessions WHERE user_id=${user} AND idempotency_key=${other.i.idempotency_key}`.execute())).toHaveLength(0);
    }
    for (const [auth, call] of [[f.auth, f.call], [f.otherAuth, f.otherCall]]) {
      expect(await asRole("authenticated", tx => tx`SELECT id FROM public.calls WHERE market_id=${f.market}`.execute(), auth)).toEqual([{ id: call }]);
    }
  });

  test("insert guard binds canonical caller, exact call, market, provider market and side", async () => {
    const f = await fixture(), other = await fixture(), i = intent(f);
    const patches = [
      ["another canonical user", { user_id: f.other }], ["auth UUID is not canonical user", { user_id: f.auth }],
      ["another user's call", { call_id: f.otherCall }], ["cross-market call", { call_id: other.call }],
      ["cross-market UUID", { market_id: other.market }], ["wrong provider market", { venue_market_id: other.venueMarketId }],
      ["wrong side", { side: "NO" }], ["nonexistent call", { call_id: randomUUID() }], ["nonexistent market", { market_id: randomUUID() }],
    ] as const;
    await rejectCases(patches.map(([label, patch]) => [label, tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, ...patch })}`.execute()]), /exact called market\/side/);
    const row = await insert(i); expect(row.user_id).toBe(f.user); expect(row.state).toBe("PREPARING");
    const nonPanta = intent(await fixture("fixture"));
    expect(await rejectsMutation(tx => tx`INSERT INTO public.panta_trade_sessions ${tx(nonPanta)}`.execute(), /exact called market\/side/)).toBe(true);
  });

  for (const state of ["QUOTED", "SUBMITTED", "FILLED", "FAILED"] as const) {
    test(`cannot start directly ${state}, even with matching synthetic evidence`, async () => {
      const i = intent(await fixture()), e = await evidence(i);
      expect(await rejectsMutation(tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, state,
        prepared: e.prepared, provider_order_id: e.orderId, signed_transaction: e.signed, signature: e.signature, fill_evidence: e.fill })}`.execute(), /start as an unfunded intent/)).toBe(true);
    });
  }
  test("PREPARING insert rejects prepared, signed and filled artifacts", async () => {
    const i = intent(await fixture()), e = await evidence(i);
    await rejectCases([
      ["prepared", tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, prepared: e.prepared })}`.execute()],
      ["signed pair", tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, signed_transaction: e.signed, signature: e.signature })}`.execute()],
      ["fill", tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, fill_evidence: e.fill })}`.execute()],
    ], /start as an unfunded intent/);
    expect(await rejectsMutation(tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, signed_transaction: e.signed })}`.execute(), /check constraint/)).toBe(true);
  });

  test("valid PREPARING → QUOTED → SUBMITTED → FILLED persists exact artifacts; free call stays NONE", async () => {
    const s = await session(), sql = database();
    await update(s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared });
    await update(s.i.id, { state: "SUBMITTED", signed_transaction: s.e.signed, signature: s.e.signature });
    await update(s.i.id, { state: "FILLED", fill_evidence: s.e.fill });
    const [row] = await sql`SELECT state,prepared,signed_transaction,signature,fill_evidence,amount_base_units::text FROM public.panta_trade_sessions WHERE id=${s.i.id}`;
    expect(row).toEqual({ state: "FILLED", prepared: s.e.prepared, signed_transaction: s.e.signed,
      signature: s.e.signature, fill_evidence: s.e.fill, amount_base_units: "2500000" });
    const [call] = await sql`SELECT funding_state,entry_price FROM public.calls WHERE id=${s.f.call}`;
    expect(call).toEqual({ funding_state: "NONE", entry_price: s.f.snapshot });
    expect(await rejectsMutation(tx => tx`UPDATE public.calls SET funding_state='FILLED' WHERE id=${s.f.call}`.execute(), /immutable/)).toBe(true);
  });

  for (const from of ["PREPARING", "QUOTED", "SUBMITTED"] as const) {
    test(`${from} cannot skip or reverse funding transitions`, async () => {
      const s = await session(from);
      const forbidden = from === "PREPARING" ? ["SUBMITTED", "FILLED"] : from === "QUOTED" ? ["PREPARING", "FILLED"] : ["PREPARING", "QUOTED"];
      await rejectCases(forbidden.map(state => [state, tx => write(tx, s.i.id, { state, provider_order_id: s.e.orderId,
        prepared: s.e.prepared, signed_transaction: s.e.signed, signature: s.e.signature, fill_evidence: s.e.fill })]), /Invalid Panta funding transition/);
    });
    test(`${from} may fail but a failed intent cannot reopen`, async () => {
      const s = await session(from); await update(s.i.id, { state: "FAILED" });
      await rejectCases(["PREPARING", "QUOTED", "SUBMITTED", "FILLED"].map(state => [state, tx => write(tx, s.i.id, { state })]), /cannot reopen/);
    });
  }

  test("quote/submit prerequisites reject SQL NULL and incomplete signed pairs", async () => {
    const preparing = await session(), quoted = await session("QUOTED");
    await rejectCases([
      ["quote without prepared", tx => write(tx, preparing.i.id, { state: "QUOTED", provider_order_id: preparing.e.orderId })],
      ["quote without order", tx => write(tx, preparing.i.id, { state: "QUOTED", prepared: preparing.e.prepared })],
      ["submit without both", tx => write(tx, quoted.i.id, { state: "SUBMITTED" })],
      ["submit with signature only", tx => write(tx, quoted.i.id, { state: "SUBMITTED", signature: quoted.e.signature })],
      ["submit with signed payload only", tx => write(tx, quoted.i.id, { state: "SUBMITTED", signed_transaction: quoted.e.signed })],
    ], /check constraint/);
  });

  const fillFields = ["venue", "fundingState", "fillTxSignature", "venueOrderId", "owner", "venueMarketId", "side", "filledBaseUnits"] as const;
  for (const field of fillFields) {
    test(`FILLED rejects missing, JSON null and mismatched ${field} (SQL UNKNOWN cannot pass)`, async () => {
      const s = await session("SUBMITTED");
      const missing: Record<string, unknown> = { ...s.e.fill }; delete missing[field];
      const wrong = field === "filledBaseUnits" ? "2500001" : field === "side" ? "NO" : "synthetic-mismatch";
      await rejectCases([
        ["missing", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: missing })],
        ["JSON null", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: { ...s.e.fill, [field]: null } })],
        ["mismatch", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: { ...s.e.fill, [field]: wrong } })],
      ], /panta_trade_confirmed_evidence/);
    });
  }
  test("FILLED rejects SQL NULL, empty/scalar/array evidence and malformed numeric amounts", async () => {
    const s = await session("SUBMITTED");
    expect(await rejectsMutation(tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: null }), /panta_trade_confirmed_evidence/)).toBe(true);
    await rejectCases([null, {}, [], "synthetic", 0].map((fill, index) => [String(index), tx => tx`UPDATE public.panta_trade_sessions
      SET state='FILLED',fill_evidence=${JSON.stringify(fill)}::jsonb WHERE id=${s.i.id}`.execute()]), /panta_trade_confirmed_evidence/);
    for (const amount of ["invalid", "NaN", "Infinity", "0", "-1", "2.5"]) {
      expect(await rejectsMutation(tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: { ...s.e.fill, filledBaseUnits: amount } }), /numeric|panta_trade_confirmed_evidence/)).toBe(true);
    }
  });

  const providerFields: [string[], unknown][] = [
    [["messageHash"], "f".repeat(64)], [["independentlyVerified"], false],
    [["providerVerify", "status"], "submitted"], [["providerVerify", "orderId"], "synthetic-alternative"],
    [["providerVerify", "signature"], syntheticBase58("different-signature", 64)],
    [["providerVerify", "marketId"], syntheticBase58("different-market")], [["providerVerify", "side"], "no"],
    [["providerVerify", "amountUsdc"], "2500001"],
    [["providerTrade", "status"], "pending"], [["providerTrade", "kind"], "claim"],
    [["providerTrade", "signature"], syntheticBase58("different-signature", 64)],
    [["providerTrade", "wallet"], syntheticBase58("different-wallet")],
    [["providerTrade", "marketId"], syntheticBase58("different-market")], [["providerTrade", "side"], "no"],
  ];
  for (const [path, wrong] of providerFields) {
    test(`FILLED rejects missing/null/mismatched fillEvidence.${path.join(".")} (SQL UNKNOWN)`, async () => {
      const s = await session("SUBMITTED");
      await rejectCases([
        ["missing", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", ...path], undefined, true) })],
        ["JSON null", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", ...path], null) })],
        ["mismatch", tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", ...path], wrong) })],
      ], /panta_trade_confirmed_evidence/);
    });
  }
  test("FILLED rejects absent/null/non-object raw provider containers and non-boolean RPC flags", async () => {
    const s = await session("SUBMITTED");
    const cases: [string, (tx: SQL) => Promise<unknown>][] = [];
    for (const path of [["fillEvidence"], ["fillEvidence", "providerVerify"], ["fillEvidence", "providerTrade"]]) {
      for (const [label, value, remove] of [["missing", undefined, true], ["null", null, false], ["empty", {}, false], ["array", [], false], ["scalar", "synthetic", false]] as const) {
        cases.push([`${path.join(".")} ${label}`, tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: atPath(s.e.fill, path, value, remove) })]);
      }
    }
    for (const value of ["true", 1, {}]) cases.push([`independentlyVerified=${JSON.stringify(value)}`, tx => write(tx, s.i.id,
      { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", "independentlyVerified"], value) })]);
    await rejectCases(cases, /panta_trade_confirmed_evidence/);
  });
  test("provider verification integer base units may be a canonical decimal string or safe JSON integer", async () => {
    for (const amount of ["2500000", 2500000]) {
      const s = await session("SUBMITTED");
      await update(s.i.id, { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", "providerVerify", "amountUsdc"], amount) });
    }
  });
  test("guard gap probe: raw verify amountUsdc rejects fractional/exponent/human/uncanonical base-unit strings", async () => {
    const s = await session("SUBMITTED");
    const amounts = ["2.5", "2500000.0", "2.5e6", " 2500000 ", "+2500000", "0002500000"];
    await rejectCases(amounts.map(amount => [amount, tx => write(tx, s.i.id,
      { state: "FILLED", fill_evidence: atPath(s.e.fill, ["fillEvidence", "providerVerify", "amountUsdc"], amount) })]), /numeric|evidence|fill|check constraint/i);
  });

  test("required intent columns reject SQL NULL; wallet/side/amount/slippage/fingerprint bounds apply", async () => {
    const i = intent(await fixture());
    const invalid: [string, unknown][] = Object.keys(i).map(key => [key, null]);
    invalid.push(["wallet_address", "not-a-wallet"], ["side", "MAYBE"], ["amount_base_units", "0"], ["amount_base_units", "-1"],
      ["max_slippage_bps", -1], ["max_slippage_bps", 501], ["idempotency_key", "short"], ["idempotency_key", "x".repeat(129)], ["request_fingerprint", "x".repeat(64)]);
    await rejectCases(invalid.map(([key, value]) => [`${key}=${String(value)}`, tx => tx`INSERT INTO public.panta_trade_sessions ${tx({ ...i, [key]: value })}`.execute()]), /null value|check constraint|exact called market\/side/);
  });

  test("intent is immutable even for the owner, beyond service column grants", async () => {
    const s = await session(), other = await fixture();
    const patches: [string, unknown][] = [["id", randomUUID()], ["user_id", s.f.other], ["call_id", s.f.otherCall],
      ["market_id", other.market], ["wallet_address", s.f.otherWallet], ["venue_market_id", other.venueMarketId], ["side", "NO"],
      ["amount_base_units", "3000000"], ["max_slippage_bps", 101], ["idempotency_key", "synthetic-alternative"],
      ["request_fingerprint", "f".repeat(64)], ["created_at", new Date(0)]];
    await rejectCases(patches.map(([key, value]) => [key, tx => write(tx, s.i.id, { [key]: value })]), /intent is immutable/, "owner");
  });
  test("prepared review and provider order cannot be replaced or cleared after QUOTED", async () => {
    const s = await session("QUOTED");
    await rejectCases([
      ["prepared replacement", tx => write(tx, s.i.id, { prepared: { ...s.e.prepared, review: { ...s.e.prepared.review, feeUsdc: "2" } } })],
      ["prepared cleared", tx => write(tx, s.i.id, { prepared: null })],
      ["order replacement", tx => write(tx, s.i.id, { provider_order_id: "synthetic-alternative" })],
      ["order cleared", tx => write(tx, s.i.id, { provider_order_id: null })],
    ], /Reviewed Panta transaction cannot change/);
  });
  test("signed payload and signature cannot be replaced or cleared after SUBMITTED", async () => {
    const s = await session("SUBMITTED");
    await rejectCases([
      ["payload replacement", tx => write(tx, s.i.id, { signed_transaction: "synthetic-alternative" })],
      ["signature replacement", tx => write(tx, s.i.id, { signature: syntheticBase58("different-signature", 64) })],
      ["clear both", tx => write(tx, s.i.id, { signed_transaction: null, signature: null })],
    ], /approve only one transaction/);
  });
  test("FILLED rows reject evidence/state/time rewrites; identical no-op is harmless", async () => {
    const s = await session("FILLED");
    await rejectCases([
      ["fill replacement", tx => write(tx, s.i.id, { fill_evidence: { ...s.e.fill, updatedAt: 0 } })],
      ["fill cleared", tx => write(tx, s.i.id, { fill_evidence: null })],
      ["state changed", tx => write(tx, s.i.id, { state: "FAILED" })],
      ["time changed", tx => write(tx, s.i.id, { updated_at: new Date(0) })],
    ], /Confirmed Panta fill is immutable/);
    await update(s.i.id, { state: "FILLED", fill_evidence: s.e.fill });
  });
  test("owner DELETE and TRUNCATE are blocked; service has no delete/truncate grants", async () => {
    const s = await session("FILLED");
    for (const role of ["owner", "service_role"] as const) {
      const pattern = role === "owner" ? /history is permanent/ : /permission denied/;
      expect(await rejectsMutation(tx => tx`DELETE FROM public.panta_trade_sessions WHERE id=${s.i.id}`.execute(), pattern, role)).toBe(true);
      expect(await rejectsMutation(tx => tx`TRUNCATE public.panta_trade_sessions`.execute(), pattern, role)).toBe(true);
    }
  });
  test("idempotency is per user; provider order and signature remain unique", async () => {
    const f = await fixture(), a = await session("QUOTED", f), same = { ...intent(f), idempotency_key: a.i.idempotency_key };
    expect(await rejectsMutation(tx => tx`INSERT INTO public.panta_trade_sessions ${tx(same)}`.execute(), /duplicate key/)).toBe(true);
    const other = { ...intent(f, true), idempotency_key: a.i.idempotency_key }; await insert(other);
    const otherEvidence = await evidence(other);
    const duplicateOrder = atPath(atPath(atPath(otherEvidence.prepared, ["order", "orderId"], a.e.orderId),
      ["binding", "providerOrderId"], a.e.orderId), ["binding", "unsignedOrder", "orderId"], a.e.orderId);
    expect(await rejectsMutation(tx => write(tx, other.id, { state: "QUOTED", provider_order_id: a.e.orderId, prepared: duplicateOrder }), /duplicate key/)).toBe(true);
    await update(other.id, { state: "QUOTED", provider_order_id: otherEvidence.orderId, prepared: otherEvidence.prepared });
    await update(a.i.id, { state: "SUBMITTED", signature: a.e.signature, signed_transaction: a.e.signed });
    expect(await rejectsMutation(tx => write(tx, other.id, { state: "SUBMITTED", signature: a.e.signature, signed_transaction: otherEvidence.signed }), /duplicate key/)).toBe(true);
  });
  test("two simultaneous approvals for one call/wallet arbitrate in SQL; cold restart still refuses a second spend after FILLED", async () => {
    const f = await fixture(), first = await session("QUOTED", f), second = await session("QUOTED", f);
    const index = "panta_trade_sessions_one_funding_per_call_wallet";
    const sql = database();
    expect((await sql`SELECT indisunique FROM pg_index WHERE indexrelid=${`public.${index}`}::regclass`)[0].indisunique).toBe(true);
    const monitor = new SQL(url!, { max: 1, connectionTimeout: 5 });
    const clients = [monitor];
    let release!: () => void, claimed!: () => void, secondStarted!: (pid: number) => void;
    const releaseFirst = new Promise<void>(resolve => { release = resolve; });
    const firstClaimed = new Promise<void>(resolve => { claimed = resolve; });
    const secondPid = new Promise<number>(resolve => { secondStarted = resolve; });
    let winner: Promise<unknown> | undefined, loser: Promise<{ accepted: boolean; error?: unknown }> | undefined;
    try {
      winner = asRole("service_role", async tx => {
        await write(tx, first.i.id, { state: "SUBMITTED", signature: first.e.signature, signed_transaction: first.e.signed });
        claimed();
        await releaseFirst; // Hold the index claim uncommitted on connection 1.
      });
      await Promise.race([firstClaimed, winner]);
      loser = asRole("service_role", async tx => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        secondStarted(backend.pid);
        await write(tx, second.i.id, { state: "SUBMITTED", signature: second.e.signature, signed_transaction: second.e.signed });
      }).then(() => ({ accepted: true }), error => ({ accepted: false, error }));
      const pid = await Promise.race([secondPid, loser.then(() => { throw new Error("Second approval ended before reaching the concurrency barrier"); })]);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (!blocked && Date.now() < deadline) {
        const [lock] = await monitor`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE pid=${pid} AND locktype='transactionid' AND NOT granted) AS blocked`;
        blocked = lock.blocked;
        if (!blocked) await Bun.sleep(25);
      }
      expect(blocked).toBe(true); // Distinct rows race on the unique index.
      release(); await winner;
      const result = await loser;
      expect(result.accepted).toBe(false);
      check(result.error instanceof Error && "errno" in result.error && "constraint" in result.error,
        "Second approval must fail with a PostgreSQL uniqueness error");
      expect(String(result.error.errno)).toBe("23505");
      expect(result.error.constraint).toBe(index);
      expect((await sql`SELECT state,signature,signed_transaction FROM public.panta_trade_sessions WHERE id=${second.i.id}`)[0])
        .toEqual({ state: "QUOTED", signature: null, signed_transaction: null });
      await update(first.i.id, { state: "FILLED", fill_evidence: first.e.fill });

      // New pool/connection: no in-memory active-order registry or lock survives.
      const restarted = new SQL(url!, { max: 1, connectionTimeout: 5 }); clients.push(restarted);
      expect((await restarted`SELECT state FROM public.panta_trade_sessions WHERE id=${first.i.id}`)[0].state).toBe("FILLED");
      await expect(restarted.begin(async tx => {
        await tx`SET LOCAL ROLE service_role`;
        await write(tx, second.i.id, { state: "SUBMITTED", signature: second.e.signature, signed_transaction: second.e.signed });
      })).rejects.toThrow(/panta_trade_sessions_one_funding_per_call_wallet/);
      expect((await sql`SELECT count(*)::integer AS count FROM public.panta_trade_sessions
        WHERE user_id=${f.user} AND call_id=${f.call} AND wallet_address=${f.wallet} AND state IN ('SUBMITTED','FILLED')`)[0].count).toBe(1);
    } finally {
      release();
      await Promise.allSettled([winner, loser]);
      await Promise.all(clients.map(client => client.end()));
    }
  }, 15000);

  // These assertions deliberately expose weak guards for main to fix. They
  // never patch migrations, and keep passing if main strengthens the guards.
  test("guard gap probe: QUOTED requires an object with order/binding/review rather than arbitrary JSON", async () => {
    const s = await session();
    await acceptsMutation(tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared }));
    const invalid: [string, unknown][] = [["JSON null", null], ["empty object", {}], ["array", []], ["scalar", "synthetic"],
      ["missing order", { binding: s.e.prepared.binding, review: s.e.prepared.review }],
      ["missing binding", { order: s.e.prepared.order, review: s.e.prepared.review }],
      ["missing review", { order: s.e.prepared.order, binding: s.e.prepared.binding }]];
    // JSON null is bound as JSONB explicitly to distinguish it from SQL NULL.
    await rejectCases(invalid.map(([label, prepared]) => [label, tx => tx`UPDATE public.panta_trade_sessions
      SET state='QUOTED', provider_order_id=${s.e.orderId}, prepared=${JSON.stringify(prepared)}::jsonb WHERE id=${s.i.id}`.execute()]), /prepared|quote|check constraint/i);
  });
  test("guard gap probe: reviewed binding must agree with canonical user and exact immutable intent", async () => {
    const s = await session();
    await acceptsMutation(tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared }));
    const mismatches: [string, unknown][] = [["canonicalUserId", s.f.other], ["providerOrderId", "synthetic-alternative"],
      ["owner", s.f.otherWallet], ["venueMarketId", syntheticBase58("different-market")], ["side", "NO"],
      ["amountBaseUnits", "2500001"], ["idempotencyKey", "synthetic-alternative"]];
    await rejectCases(mismatches.map(([field, value]) => [field, tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId,
      prepared: { ...s.e.prepared, binding: { ...s.e.prepared.binding, [field]: value } } })]), /prepared|binding|intent|quote|check constraint/i);
  });
  test("guard gap probe: unsigned order must match binding and intent before QUOTED", async () => {
    const s = await session();
    await acceptsMutation(tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared }));
    const mismatches: [string, unknown][] = [["orderId", "synthetic-alternative"], ["owner", s.f.otherWallet], ["venueMarketId", syntheticBase58("different-market")],
      ["side", "NO"], ["amountBaseUnits", "2500001"], ["idempotencyKey", "synthetic-alternative"], ["fundingState", "FILLED"], ["venue", "fixture"]];
    await rejectCases(mismatches.map(([field, value]) => [field, tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId,
      prepared: { ...s.e.prepared, order: { ...s.e.prepared.order, [field]: value } } })]), /prepared|binding|intent|quote|check constraint/i);
  });
  test("prepared intent fields reject missing/null rather than passing SQL UNKNOWN", async () => {
    const s = await session();
    await acceptsMutation(tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared }));
    const paths = [
      ["order", "orderId"], ["order", "venue"], ["order", "fundingState"], ["order", "owner"],
      ["order", "venueMarketId"], ["order", "side"], ["order", "amountBaseUnits"], ["order", "idempotencyKey"],
      ["binding", "canonicalUserId"], ["binding", "owner"], ["binding", "venueMarketId"], ["binding", "providerOrderId"],
      ["binding", "idempotencyKey"], ["binding", "side"], ["binding", "amountBaseUnits"], ["binding", "messageHash"],
      ["review", "attribution"], ["review", "maxSlippageBps"], ["review", "amountBaseUnits"],
    ];
    const cases: [string, (tx: SQL) => Promise<unknown>][] = [];
    for (const path of paths) for (const remove of [true, false]) cases.push([`${path.join(".")} ${remove ? "missing" : "null"}`,
      tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: atPath(s.e.prepared, path, null, remove) })]);
    await rejectCases(cases, /prepared|binding|intent|quote|check constraint/i);
  });
  test("guard gap probe: review amount/slippage and durable unsignedOrder must agree with reviewed intent", async () => {
    const s = await session();
    await acceptsMutation(tx => write(tx, s.i.id, { state: "QUOTED", provider_order_id: s.e.orderId, prepared: s.e.prepared }));
    const patches: [string[], unknown][] = [[["review", "amountBaseUnits"], "2500001"], [["review", "maxSlippageBps"], 101],
      [["binding", "unsignedOrder", "owner"], s.f.otherWallet], [["binding", "unsignedOrder", "orderId"], "synthetic-alternative"],
      [["binding", "unsignedOrder", "amountBaseUnits"], "2500001"]];
    await rejectCases(patches.map(([path, value]) => [path.join("."), tx => write(tx, s.i.id,
      { state: "QUOTED", provider_order_id: s.e.orderId, prepared: atPath(s.e.prepared, path, value) })]), /prepared|binding|intent|quote|check constraint/i);
  });
  test("guard gap probe: signatures and fill evidence cannot be introduced ahead of their state", async () => {
    const preparing = await session(), quoted = await session("QUOTED"), submitted = await session("SUBMITTED");
    await rejectCases([
      ["PREPARING signed pair", tx => write(tx, preparing.i.id, { signed_transaction: preparing.e.signed, signature: preparing.e.signature })],
      ["QUOTED signed pair without SUBMITTED", tx => write(tx, quoted.i.id, { signed_transaction: quoted.e.signed, signature: quoted.e.signature })],
      ["PREPARING fill evidence", tx => write(tx, preparing.i.id, { fill_evidence: preparing.e.fill })],
      ["QUOTED fill evidence", tx => write(tx, quoted.i.id, { fill_evidence: quoted.e.fill })],
      ["SUBMITTED fill evidence without FILLED", tx => write(tx, submitted.i.id, { fill_evidence: submitted.e.fill })],
    ], /state|signed|signature|evidence|intent|check constraint/i);
  });
  test("guard gap probe: PREPARING cannot acquire a signed transaction while staying PREPARING", async () => {
    const s = await session();
    expect(await rejectsMutation(tx => write(tx, s.i.id, { signed_transaction: s.e.signed, signature: s.e.signature }),
      /state|signed|signature|intent|check constraint/i)).toBe(true);
  });
  test("guard gap probe: PREPARING cannot acquire fill evidence while staying PREPARING", async () => {
    const s = await session();
    expect(await rejectsMutation(tx => write(tx, s.i.id, { fill_evidence: s.e.fill }), /state|evidence|fill|intent|check constraint/i)).toBe(true);
  });
  test("guard gap probe: FILLED evidence cannot contain contradictory amount/order/idempotency attribution", async () => {
    const s = await session("SUBMITTED");
    const mismatches: [string, unknown][] = [["amountBaseUnits", "2500001"], ["orderId", "synthetic-alternative"], ["idempotencyKey", "synthetic-alternative"], ["demo", true]];
    await rejectCases(mismatches.map(([field, value]) => [field, tx => write(tx, s.i.id, { state: "FILLED", fill_evidence: { ...s.e.fill, [field]: value } })]), /evidence|fill|check constraint/i);
  });
});
