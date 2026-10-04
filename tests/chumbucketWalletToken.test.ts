/**
 * The Chumbucket wallet's Privy token (src/wallet/privyJwt.ts, wallet.privyToken,
 * the JWKS route): one wallet per ACCOUNT. The token's `sub` is the account,
 * so every sign-in of one account reaches the same Privy user. Keys here are
 * generated per run and never leave the test.
 */

import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { walletRouter } from "../src/api/wallet.ts";
import { startServer } from "../src/api/server.ts";
import { createApp } from "../src/app.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { loadConfig } from "../src/config.ts";
import { SessionDepositAccounts } from "../src/deposits/accounts.ts";
import { primeDepositsRuntime } from "../src/deposits/runtime.ts";
import { DepositRateLimiter } from "../src/deposits/service.ts";
import { PRIVY_JWKS_PATH, PRIVY_JWT_AUDIENCE, PRIVY_JWT_TTL_SECONDS, PrivyJwtSigner } from "../src/wallet/privyJwt.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";

const ACCOUNT = "10000000-0000-4000-8000-0000000000aa";
const OTHER = "10000000-0000-4000-8000-0000000000bb";
const ISSUER = "https://bff.synthetic.invalid";
const NOW = 1_780_000_000_000;

const pem = (curve = "prime256v1") =>
  generateKeyPairSync("ec", { namedCurve: curve }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function decode(token: string) {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>,
    signed: Buffer.from(`${h}.${p}`),
    signature: Buffer.from(s!, "base64url"),
  };
}

describe("the account token", () => {
  test("ES256, signed by the key the JWKS publishes, for exactly this account, ten minutes at most", () => {
    const signer = PrivyJwtSigner.fromConfig({ privateKey: pem(), issuer: `${ISSUER}/` }, () => NOW);
    const { token, expiresAt } = signer.mint(ACCOUNT);
    const { header, payload, signed, signature } = decode(token);
    const [jwk] = signer.jwks().keys;
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: jwk!.kid });
    expect(payload).toMatchObject({ iss: ISSUER, sub: ACCOUNT, aud: PRIVY_JWT_AUDIENCE, iat: NOW / 1000 });
    expect((payload.exp as number) - (payload.iat as number)).toBe(PRIVY_JWT_TTL_SECONDS);
    expect(PRIVY_JWT_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(expiresAt).toBe((payload.exp as number) * 1000);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(decode(signer.mint(ACCOUNT).token).payload.jti).not.toBe(payload.jti);
    const key = createPublicKey({ key: { kty: jwk!.kty, crv: jwk!.crv, x: jwk!.x, y: jwk!.y }, format: "jwk" });
    expect(verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    // Another key's JWKS does not verify it.
    const stranger = PrivyJwtSigner.fromConfig({ privateKey: pem(), issuer: ISSUER }).jwks().keys[0]!;
    const strangerKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: stranger.x, y: stranger.y }, format: "jwk" });
    expect(verify("sha256", signed, { key: strangerKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
  });

  test("the JWKS is public material only, its kid the RFC 7638 thumbprint", () => {
    const signer = PrivyJwtSigner.fromConfig({ privateKey: pem(), issuer: ISSUER });
    const jwks = signer.jwks();
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0]!;
    expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    const thumb = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
    expect(jwk.kid).toBe(thumb);
  });

  test("PEM with escaped newlines and a JWK both load; anything else is refused without echoing it", () => {
    const key = pem();
    expect(() => PrivyJwtSigner.fromConfig({ privateKey: key.replace(/\n/g, "\\n"), issuer: ISSUER })).not.toThrow();
    const jwk = JSON.stringify(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }));
    expect(() => PrivyJwtSigner.fromConfig({ privateKey: jwk, issuer: ISSUER })).not.toThrow();
    for (const bad of ["not a key", pem("secp384r1")]) {
      let message = "";
      try {
        PrivyJwtSigner.fromConfig({ privateKey: bad, issuer: ISSUER });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe("PRIVY_JWT_PRIVATE_KEY is not a usable P-256 private key");
      expect(message).not.toContain("BEGIN");
    }
    expect(() => PrivyJwtSigner.fromConfig({ privateKey: key, issuer: "http://bff.invalid" })).toThrow("https");
    expect(() => PrivyJwtSigner.fromConfig({ privateKey: key, issuer: ISSUER }).mint("not-an-account")).toThrow();
  });
});

describe("wallet.privyToken and the JWKS route", () => {
  async function rig(env: Record<string, string> = {}) {
    const key = pem();
    const cfg = loadConfig({
      CHUMBUCKET_WALLET_ENABLED: "true",
      PRIVY_JWT_PRIVATE_KEY: key,
      BFF_PUBLIC_URL: ISSUER,
      SUPABASE_URL: "https://synthetic.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-only",
      ...env,
    });
    const app = await createApp({ config: cfg });
    // The primary sign-in and an extra sign-in resolve to one account, as
    // resolve_auth_user_v1 (fleet/linking) answers through userIdForAuthUser.
    const store = new FakeIdentityStore().addUser("auth-primary", ACCOUNT).addUser("auth-extra", ACCOUNT).addUser("auth-other", OTHER).addUser("auth-other-2", OTHER);
    const verifier = new FakeJwtVerifier().issue("primary", "auth-primary").issue("extra", "auth-extra").issue("other", "auth-other").issue("other-2", "auth-other-2");
    primeAuthIdentityRuntime(cfg, { store, verifier, policy: resolveAuthIdentityPolicy(cfg) });
    primeDepositsRuntime(cfg, {
      readiness: { available: false, reason: { code: "PAUSED", message: "Paused" }, config: null },
      service: null,
      accounts: new SessionDepositAccounts(cfg, { activeVerified: async () => [] }, { confirmedEmail: async () => null }),
      balances: null,
      limiter: new DepositRateLimiter(),
    });
    const caller = (token?: string) => walletRouter.createCaller({ app, ...(token ? { supabaseAccessToken: token } : {}) });
    return { app, caller };
  }

  test("signed in only, and every sign-in of one account gets the same sub", async () => {
    const r = await rig();
    await expect(r.caller().privyToken()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(r.caller("forged").privyToken()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const primary = decode((await r.caller("primary").privyToken()).token).payload;
    const extra = decode((await r.caller("extra").privyToken()).token).payload;
    const other = decode((await r.caller("other").privyToken()).token).payload;
    expect(primary.sub).toBe(ACCOUNT);
    expect(extra.sub).toBe(ACCOUNT);
    expect(other.sub).toBe(OTHER);
    expect(primary.jti).not.toBe(extra.jti);
  });

  test("off, or without a key: no token", async () => {
    await expect((await rig({ CHUMBUCKET_WALLET_ENABLED: "false" })).caller("primary").privyToken()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect((await rig({ PRIVY_JWT_PRIVATE_KEY: "" })).caller("primary").privyToken()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  test("rate limited per account, and wallet.status too", async () => {
    const r = await rig();
    for (let i = 0; i < 12; i++) await r.caller("primary").privyToken();
    await expect(r.caller("extra").privyToken()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await r.caller("other").privyToken();
    // Per account, not per session: the account's other sign-in is refused too.
    for (let i = 0; i < 30; i++) await r.caller("other").status();
    await expect(r.caller("other-2").status()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  test("the JWKS is served at its public path and verifies the minted token", async () => {
    const r = await rig();
    const server = startServer(r.app, 0, "127.0.0.1");
    try {
      if (!server.http.listening) await once(server.http, "listening");
      const address = server.http.address();
      if (!address || typeof address === "string") throw new Error("missing local test port");
      const base = `http://127.0.0.1:${address.port}`;
      const res = await fetch(`${base}${PRIVY_JWKS_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      const jwks = (await res.json()) as { keys: Array<{ kty: string; crv: string; x: string; y: string; kid: string }> };
      expect(JSON.stringify(jwks)).not.toContain('"d"');
      const { header, signed, signature } = decode((await r.caller("primary").privyToken()).token);
      const jwk = jwks.keys.find((k) => k.kid === header.kid)!;
      const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
      expect(verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
      expect((await fetch(`${base}${PRIVY_JWKS_PATH}`, { method: "POST" })).status).toBe(405);
    } finally {
      server.wss.close();
      await new Promise<void>((resolve, reject) => server.http.close((error) => (error ? reject(error) : resolve())));
    }
    const unconfigured = await rig({ BFF_PUBLIC_URL: "" });
    const server2 = startServer(unconfigured.app, 0, "127.0.0.1");
    try {
      if (!server2.http.listening) await once(server2.http, "listening");
      const address = server2.http.address();
      if (!address || typeof address === "string") throw new Error("missing local test port");
      expect((await fetch(`http://127.0.0.1:${address.port}${PRIVY_JWKS_PATH}`)).status).toBe(404);
    } finally {
      server2.wss.close();
      await new Promise<void>((resolve, reject) => server2.http.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
