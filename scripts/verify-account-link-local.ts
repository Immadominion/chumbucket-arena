/** Explicit opt-in, synthetic-only cross-language account-continuity check.
 * Real Flutter session/client -> mounted BFF -> real PostgREST -> fresh PG.
 * Only Google/MWA approval and the GoTrue issuer are replaced. Never loads .env,
 * accepts a database URL, touches a phone, or seeds a production ownership anchor.
 * Run with bun --no-env-file; POSTGREST_BIN and FLUTTER_BIN are executable paths.
 */
import { SQL } from "bun";
import { Keypair } from "@solana/web3.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/app.ts";
import { startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";

if (process.argv[2] !== "--run") throw new Error("Explicit --run required; local synthetic data only");
const pgBin = process.env.POSTGRES_BIN_DIR ?? "/opt/homebrew/opt/postgresql@15/bin";
const restBin = process.env.POSTGREST_BIN;
const flutter = process.env.FLUTTER_BIN;
if (!restBin || !flutter) throw new Error("Set POSTGREST_BIN and FLUTTER_BIN to local executable paths");
const mobile = resolve(import.meta.dir, "../../chumbucket-social-calls");
const root = realpathSync(mkdtempSync(join(tmpdir(), "chumbucket-account-flow-")));
const data = join(root, "isolated-db");
// Explicit allowlist; no DB URL, provider credential, proxy, or inherited flag.
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "USER"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]!]] : []));
let phase = "initialization";
let started = false;
let db: SQL | undefined;
let postgrest: ReturnType<typeof Bun.spawn> | undefined;
let gateway: ReturnType<typeof Bun.serve> | undefined;
let bff: ReturnType<typeof startServer> | undefined;
let succeeded = false;
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function pg(command: string, args: string[]) {
  const result = spawnSync(join(pgBin, command), args, { env, encoding: "utf8", timeout: 30000 });
  check(result.status === 0, `Local ${command} failed`);
}
async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const a = s.address(); check(a && typeof a !== "string", "Missing loopback port");
  await new Promise<void>(resolve => s.close(() => resolve())); return a.port;
}
const jwtSecret = randomBytes(32).toString("hex");
function jwt(claims: object) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const unsigned = `${head}.${body}`;
  return `${unsigned}.${createHmac("sha256", jwtSecret).update(unsigned).digest("base64url")}`;
}
const fixtures = ["success", "cancel", "unavailable", "conflict", "retry"].map((name, index) => {
  const suffix = String(index + 1).padStart(12, "0");
  const authId = `10000000-0000-4000-8000-${suffix}`;
  return { name, seedByte: index + 31, authId, userId: `20000000-0000-4000-8000-${suffix}`,
    address: Keypair.fromSeed(new Uint8Array(32).fill(index + 31)).publicKey.toBase58(),
    token: jwt({ sub: authId, role: "authenticated" }) };
});
const authRequests = new Map<string, number>();
const rpcRequests = new Map<string, number>();
const serviceToken = jwt({ role: "service_role" });
try {
  phase = "disposable PostgreSQL";
  const pgPort = await freePort();
  pg("initdb", ["-D", data, "-U", "claim_test_admin", "-A", "trust", "--no-locale"]);
  pg("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o",
    `-k ${root} -p ${pgPort} -c listen_addresses=127.0.0.1`, "-w", "start"]);
  started = true;
  db = new SQL(`postgres://claim_test_admin@127.0.0.1:${pgPort}/postgres`);
  const [location] = await db`SELECT current_setting('data_directory') AS dir`;
  check(location.dir === data, "Refusing database outside newly-created scratch cluster");
  await db.unsafe(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE claim_authenticator LOGIN NOINHERIT;
    GRANT anon, authenticated, service_role TO claim_authenticator;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$;
  `);
  await db.unsafe(`
    CREATE TABLE public.users(id uuid PRIMARY KEY, wallet_address text UNIQUE,
      full_name text, handle text UNIQUE, history jsonb DEFAULT '[]');
    CREATE TABLE public.old_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES public.users(id), body text);
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  `);
  for (const file of ["20260913120000_auth_identity_auth_user_link.sql", "20260928120000_existing_account_claims.sql"]) {
    await db.unsafe(readFileSync(join(mobile, "supabase/migrations", file), "utf8"));
  }
  const otherAuth = "30000000-0000-4000-8000-000000000001";
  await db`INSERT INTO auth.users(id) VALUES (${otherAuth})`;
  for (const f of fixtures) {
    await db`INSERT INTO auth.users(id) VALUES (${f.authId})`;
    await db`INSERT INTO public.users(id,wallet_address,full_name,handle,history,auth_user_id)
      VALUES (${f.userId},${f.address},${'Original ' + f.name},${f.name},'["old-history"]',${f.name === 'conflict' ? otherAuth : null})`;
    await db`INSERT INTO public.old_receipts(user_id,body) VALUES (${f.userId},'Original receipt')`;
    if (f.name !== "unavailable") await db`INSERT INTO public.existing_account_anchors
      (user_id,wallet_address,network,evidence_sha256,review_ref,reviewed_by)
      VALUES (${f.userId},${f.address},'devnet',${createHash('sha256').update('synthetic-only').digest('hex')},'synthetic-only','local-test')`;
  }
  phase = "PostgREST startup";
  const restPort = await freePort();
  postgrest = Bun.spawn([restBin], { env: { ...env,
    DYLD_LIBRARY_PATH: join(pgBin, "../lib"),
    PGRST_DB_URI: `postgres://claim_authenticator@127.0.0.1:${pgPort}/postgres`,
    PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: jwtSecret,
    PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(restPort), PGRST_LOG_LEVEL: "crit",
  }, stdout: "ignore", stderr: "pipe" });
  const restBase = `http://127.0.0.1:${restPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${restBase}/users?select=id`, { headers: { authorization: `Bearer ${serviceToken}` }, signal: AbortSignal.timeout(250) })).ok; } catch { /* startup only */ }
    if (!ready) await Bun.sleep(50);
  }
  check(ready, "Local PostgREST did not become ready");
  phase = "PostgREST client-role denials";
  let denied = 0;
  for (const role of ["anon", "authenticated"]) {
    const headers = { authorization: `Bearer ${jwt({ role, sub: fixtures[0]!.authId })}`, "content-type": "application/json" };
    for (const table of ["existing_account_anchors", "existing_account_proofs", "existing_account_claims"]) {
      const response = await fetch(`${restBase}/${table}?select=id`, { headers });
      check([401, 403, 404].includes(response.status), "Client role read private claim data");
      await response.body?.cancel(); denied++;
    }
    for (const rpc of ["issue_existing_account_proof_v1", "claim_existing_account_v1"]) {
      const body = { p_auth_user_id: fixtures[0]!.authId, p_wallet_address: fixtures[0]!.address,
        p_network: "devnet", p_nonce_hash: "a".repeat(64), p_message_hash: "b".repeat(64),
        ...(rpc.startsWith("issue_") ? { p_issued_at: new Date().toISOString(),
          p_expires_at: new Date(Date.now() + 300000).toISOString() } : {}) };
      const response = await fetch(`${restBase}/rpc/${rpc}`, { method: "POST", headers, body: JSON.stringify(body) });
      check([401, 403, 404].includes(response.status), "Client role executed a privileged claim RPC");
      await response.body?.cancel(); denied++;
    }
  }
  console.log(`PASS PostgREST: ${denied} client-role table/RPC denials`);
  phase = "local issuer and mounted BFF";
  // Narrow Supabase gateway: issuer responses are synthetic; /rest/v1 is
  // forwarded unchanged to real PostgREST. Never log a header/body/query string.
  gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/auth/v1/user") {
      const f = fixtures.find(x => request.headers.get("authorization") === `Bearer ${x.token}`);
      if (!f || request.headers.get("apikey") !== serviceToken) return Response.json({}, { status: 401 });
      authRequests.set(f.name, (authRequests.get(f.name) ?? 0) + 1);
      return Response.json({ id: f.authId, aud: "authenticated" });
    }
    if (!url.pathname.startsWith("/rest/v1/")) return new Response(null, { status: 404 });
    rpcRequests.set(url.pathname, (rpcRequests.get(url.pathname) ?? 0) + 1);
    return fetch(`${restBase}${url.pathname.slice(8)}${url.search}`, {
      method: request.method, headers: request.headers, redirect: "error",
      ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
    });
  }});
  const config = loadConfig({ SUPABASE_URL: `http://127.0.0.1:${gateway.port}`,
    SUPABASE_SERVICE_ROLE_KEY: serviceToken, SOLANA_NETWORK: "devnet", RECONCILER_ENABLED: "false",
    EXISTING_ACCOUNT_CLAIMS_ENABLED: "true" });
  const app = await createApp({ config, auth: { verify: async () => null, fetchLinkedIdentities: async () => [] } });
  bff = startServer(app, 0, "127.0.0.1");
  if (!bff.http.listening) await once(bff.http, "listening");
  const address = bff.http.address(); check(address && typeof address !== "string", "No BFF port");
  const bffBase = `http://127.0.0.1:${address.port}`;
  phase = "Flutter -> BFF -> PostgREST -> PostgreSQL";
  const child = Bun.spawn([flutter, "test", "--no-pub", "--reporter", "expanded", "test/existing_account_local_integration_test.dart"], {
    cwd: mobile, env: { ...env, CHUM_LOCAL_ACCOUNT_FIXTURE: JSON.stringify({ bffBase, fixtures }) },
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 90000);
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timeout);
  // Test output is synthetic-only; scrub every generated token defensively.
  let safe = output + error;
  for (const token of [serviceToken, jwtSecret, ...fixtures.map(f => f.token)]) safe = safe.replaceAll(token, "<redacted>");
  console.log(safe.trim());
  check(code === 0, "Cross-language Flutter tests failed");
  phase = "database preservation assertions";
  const rows: Array<{ id: string; wallet_address: string; full_name: string; handle: string;
    history: unknown; auth_user_id: string | null }> =
    await db`SELECT id,wallet_address,full_name,handle,history,auth_user_id FROM public.users ORDER BY handle`;
  check(rows.length === fixtures.length, "Profile count changed");
  for (const f of fixtures) {
    const row = rows.find(r => r.id === f.userId);
    check(row && row.full_name === `Original ${f.name}` && row.wallet_address === f.address
      && row.handle === f.name && JSON.stringify(row.history) === '["old-history"]', "Old profile/history changed");
    const expectedOwner = ["success", "retry"].includes(f.name) ? f.authId : f.name === "conflict" ? otherAuth : null;
    check(row.auth_user_id === expectedOwner, "Unexpected account binding");
    const [receipt] = await db`SELECT body FROM public.old_receipts WHERE user_id=${f.userId}`;
    check(receipt.body === "Original receipt", "Old receipt changed");
  }
  const [audit] = await db`SELECT count(*)::int AS n FROM public.existing_account_claims`;
  check(audit.n === 3, "Claim audit must record two people and one fresh-proof retry");
  check(!rpcRequests.has("/rest/v1/rpc/create_social_person_v1"), "Flow tried creating another profile");
  check(fixtures.every(f => (authRequests.get(f.name) ?? 0) > 0), "A flow bypassed issuer verification");
  console.log("PASS database: 5 original people/receipts preserved; 2 linked people / 3 proof audits; no profile creation");
  console.log("PASS transport: real PostgREST and mounted BFF; issuer consulted for all five cases");
  succeeded = true;
} catch (error) {
  console.error(`FAIL local account flow at ${phase}: ${error instanceof Error ? error.message : 'unknown failure'}`);
  process.exitCode = 1;
} finally {
  if (bff) { bff.wss.close(); await new Promise<void>(resolve => bff!.http.close(() => resolve())); }
  gateway?.stop(true);
  if (postgrest) { postgrest.kill(); await postgrest.exited; }
  await db?.end();
  if (started) pg("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  // Keep only this stopped synthetic cluster as an inspectable test artifact.
  console.log(`Local cluster stopped; synthetic artifacts retained at ${root}`);
  if (succeeded) console.log("PASS account-link local integration; no live app/provider/database touched");
}
