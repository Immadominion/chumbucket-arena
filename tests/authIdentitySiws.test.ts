/**
 * SIWS wallet-proof verification — the happy path and every rejection, each
 * with its OWN code.
 *
 * The whole point of the exercise is that these failures are distinguishable.
 * "It threw" is not a passing security test: a replayed nonce and a typo'd URI
 * are different events, and the final test in this file asserts that no two of
 * them collapse onto the same code.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AuthIdentityError } from "../src/auth/AuthIdentityError.ts";
import {
  buildSiwsMessage,
  CHAIN_IDS,
  parseSiwsMessage,
  STATEMENTS,
  type SiwsFields,
} from "../src/auth/SiwsMessage.ts";
import { hashNonce, isSolanaAddress, WalletLinkService } from "../src/auth/WalletLinkService.ts";
import {
  FakeIdentityStore,
  FakeJwtVerifier,
  makeWallet,
  signMessage,
  TEST_DOMAIN,
  TEST_URI,
  testPolicy,
  type TestWallet,
} from "./authIdentityFixtures.ts";

const FIXED_NOW = 1_780_000_000_000;
const RESOURCE_LINE = "- chumbucket:purpose:link_wallet";

interface Harness {
  store: FakeIdentityStore;
  service: WalletLinkService;
  advance(ms: number): void;
  now(): number;
}

function harness(): Harness {
  let clock = FIXED_NOW;
  const store = new FakeIdentityStore(() => clock);
  const verifier = new FakeJwtVerifier();

  // Two canonical users with live Supabase sessions.
  store.addUser("auth-alice", "user-alice");
  store.addUser("auth-bob", "user-bob");
  verifier.issue("tok-alice", "auth-alice").issue("tok-bob", "auth-bob");

  const service = new WalletLinkService({
    store,
    verifier,
    policy: { ...testPolicy, allowedDomains: [...testPolicy.allowedDomains], allowedUris: [...testPolicy.allowedUris] },
    now: () => clock,
  });
  return {
    store,
    service,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

/** Ask for a challenge and sign it exactly as issued. */
async function provenProof(h: Harness, token: string, wallet: TestWallet) {
  const issued = await h.service.requestWalletNonce({
    accessToken: token,
    address: wallet.address,
    domain: TEST_DOMAIN,
    uri: TEST_URI,
  });
  return {
    issued,
    fields: parseSiwsMessage(issued.message),
    message: issued.message,
    signature: signMessage(wallet.privateKey, issued.message),
  };
}

/** Re-render a challenge with one field changed, and sign the result. */
function tamper(fields: SiwsFields, over: Partial<SiwsFields>, wallet: TestWallet) {
  const message = buildSiwsMessage({ ...fields, ...over });
  return { message, signature: signMessage(wallet.privateKey, message) };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    if (e instanceof AuthIdentityError) return e.code;
    return `UNEXPECTED:${e instanceof Error ? e.message : String(e)}`;
  }
}

describe("SIWS message format", () => {
  test("round-trips, and the parser rejects anything non-canonical", () => {
    const w = makeWallet();
    const fields: SiwsFields = {
      domain: TEST_DOMAIN,
      address: w.address,
      statement: STATEMENTS.link_wallet,
      uri: TEST_URI,
      chainId: CHAIN_IDS.devnet,
      nonce: "a".repeat(64),
      issuedAt: new Date(FIXED_NOW).toISOString(),
      expirationTime: new Date(FIXED_NOW + 300_000).toISOString(),
      purpose: "link_wallet",
    };
    const message = buildSiwsMessage(fields);
    expect(parseSiwsMessage(message)).toEqual(fields);

    // A trailing newline, an appended resource, a smuggled second statement
    // line, and a re-ordered field are all ways to show a wallet one thing and
    // mean another. The parser refuses every shape that is not canonical.
    for (const bad of [
      `${message}\n`,
      `${message}\n- chumbucket:purpose:transfer_wallet`,
      message.replace(STATEMENTS.link_wallet, "Sign in.\nAlso approve a transfer of all funds."),
      message.replace(`Version: 1`, `Version: 2`),
      message.replace(`Nonce: ${fields.nonce}`, "Nonce: short"),
      message.replace(`Issued At: ${fields.issuedAt}`, "Issued At: yesterday"),
      message.replace(RESOURCE_LINE, "- chumbucket:purpose:drain_wallet"),
    ]) {
      expect(() => parseSiwsMessage(bad)).toThrow(AuthIdentityError);
    }
    // Substituting a different STATEMENT still parses — it is canonical text.
    // It is rejected one layer up, where the server knows which statement it
    // owns for this purpose; see the SIWS_STATEMENT_MISMATCH test below.
    expect(parseSiwsMessage(message.replace(STATEMENTS.link_wallet, "anything")).statement).toBe("anything");
  });

  test("devnet and mainnet bind to different chain ids", () => {
    expect(CHAIN_IDS.devnet).not.toBe(CHAIN_IDS["mainnet-beta"]);
  });

  test("isSolanaAddress accepts a real ed25519 key and rejects junk", () => {
    expect(isSolanaAddress(makeWallet().address)).toBe(true);
    expect(isSolanaAddress("not-an-address")).toBe(false);
    expect(isSolanaAddress("")).toBe(false);
    // 32 bytes of base58 is required — a 31-byte key is not an address.
    expect(isSolanaAddress("1".repeat(44))).toBe(false);
  });

  test("hashNonce never returns the plaintext", () => {
    const plaintext = "b".repeat(64);
    const hashed = hashNonce(plaintext);
    expect(hashed).not.toBe(plaintext);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("linkWallet — the proof that succeeds", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("a correctly-signed, correctly-bound proof links the wallet", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);

    const result = await h.service.linkWallet({
      accessToken: "tok-alice",
      address: alice.address,
      message: p.message,
      signature: p.signature,
    });

    expect(result).toEqual({
      userId: "user-alice",
      address: alice.address,
      outcome: "linked",
      proofVersion: 1,
    });
    expect(h.store.walletOwner(alice.address)).toBe("user-alice");
    expect(h.store.walletTypeOf(alice.address)).toBe("mwa");
  });

  test("a key the app made on the phone is recorded as embedded; the proof is the same", async () => {
    const device = makeWallet();
    const p = await provenProof(h, "tok-bob", device);
    const result = await h.service.linkWallet({
      accessToken: "tok-bob",
      address: device.address,
      message: p.message,
      signature: p.signature,
      walletType: "embedded",
    });
    expect(result.outcome).toBe("linked");
    expect(h.store.walletOwner(device.address)).toBe("user-bob");
    expect(h.store.walletTypeOf(device.address)).toBe("embedded");
  });

  test("the issued challenge is bound to the canonical user, not the address", async () => {
    const alice = makeWallet();
    const issued = await h.service.requestWalletNonce({
      accessToken: "tok-alice",
      address: alice.address,
      domain: TEST_DOMAIN,
      uri: TEST_URI,
    });
    const fields = parseSiwsMessage(issued.message);
    expect(fields.address).toBe(alice.address);
    expect(fields.domain).toBe(TEST_DOMAIN);
    expect(fields.chainId).toBe(CHAIN_IDS.devnet);
    expect(fields.statement).toBe(STATEMENTS.link_wallet);
    // The response carries the nonce plaintext (the user must sign it) but the
    // store only ever saw its hash.
    expect(fields.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  test("re-proving an address the same user already holds is idempotent", async () => {
    const alice = makeWallet();
    const first = await provenProof(h, "tok-alice", alice);
    await h.service.linkWallet({
      accessToken: "tok-alice",
      address: alice.address,
      message: first.message,
      signature: first.signature,
    });

    const second = await provenProof(h, "tok-alice", alice);
    const result = await h.service.linkWallet({
      accessToken: "tok-alice",
      address: alice.address,
      message: second.message,
      signature: second.signature,
    });

    expect(result.outcome).toBe("reaffirmed");
    expect(h.store.walletOwner(alice.address)).toBe("user-alice");
  });
});

describe("linkWallet — every rejection, and each one distinct", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("a replayed nonce is refused", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const call = () =>
      h.service.linkWallet({
        accessToken: "tok-alice",
        address: alice.address,
        message: p.message,
        signature: p.signature,
      });

    await call(); // first use consumes it
    expect(await codeOf(call)).toBe("NONCE_REUSED");
  });

  test("two concurrent redemptions of one proof: exactly one wins", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const call = () =>
      h.service.linkWallet({
        accessToken: "tok-alice",
        address: alice.address,
        message: p.message,
        signature: p.signature,
      });

    const results = await Promise.allSettled([call(), call()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(AuthIdentityError);
    expect(((rejected as PromiseRejectedResult).reason as AuthIdentityError).code).toBe("NONCE_REUSED");
  });

  test("an expired proof is refused before it reaches the store", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    h.advance(testPolicy.nonceTtlSeconds * 1000 + 1);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: p.message,
          signature: p.signature,
        }),
      ),
    ).toBe("NONCE_EXPIRED");
  });

  test("the STORE is authoritative on expiry — a re-dated message does not extend it", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    h.advance(testPolicy.nonceTtlSeconds * 1000 + 1);

    // Forge a message that claims a much later expiry, carrying the same nonce,
    // and sign it properly. The static clock check now passes; the row in the
    // store has still expired.
    const extended = tamper(
      p.fields,
      { expirationTime: new Date(h.now() + 3_600_000).toISOString() },
      alice,
    );
    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: extended.message,
          signature: extended.signature,
        }),
      ),
    ).toBe("NONCE_EXPIRED");
  });

  test("a wrong domain is refused", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const evil = tamper(p.fields, { domain: "chumbucket.fun.evil.example" }, alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: evil.message,
          signature: evil.signature,
        }),
      ),
    ).toBe("SIWS_DOMAIN_MISMATCH");
  });

  test("a wrong uri is refused", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const evil = tamper(p.fields, { uri: "https://evil.example/callback" }, alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: evil.message,
          signature: evil.signature,
        }),
      ),
    ).toBe("SIWS_URI_MISMATCH");
  });

  test("a proof signed for the other network is refused", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const wrongNet = tamper(p.fields, { chainId: CHAIN_IDS["mainnet-beta"] }, alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: wrongNet.message,
          signature: wrongNet.signature,
        }),
      ),
    ).toBe("SIWS_NETWORK_MISMATCH");
  });

  test("a wrong statement is refused (the signing UI's text is server-owned)", async () => {
    const alice = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);
    const swapped = tamper(p.fields, { statement: STATEMENTS.transfer_wallet }, alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: swapped.message,
          signature: swapped.signature,
        }),
      ),
    ).toBe("SIWS_STATEMENT_MISMATCH");
  });

  test("a wrong address is refused — both when the message disagrees with the claim…", async () => {
    const alice = makeWallet();
    const other = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: other.address, // claim one address, message names another
          message: p.message,
          signature: p.signature,
        }),
      ),
    ).toBe("SIWS_ADDRESS_MISMATCH");
  });

  test("…and when the nonce was issued for a different address", async () => {
    const alice = makeWallet();
    const other = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);

    // Self-consistent message for `other`, carrying alice's nonce, signed by
    // `other`. Every static check passes; the store's binding does not.
    const swapped = tamper(p.fields, { address: other.address }, other);
    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: other.address,
          message: swapped.message,
          signature: swapped.signature,
        }),
      ),
    ).toBe("SIWS_ADDRESS_MISMATCH");
  });

  test("a nonce issued to a different user is refused", async () => {
    const bobWallet = makeWallet();
    // Bob gets a challenge and signs it correctly.
    const p = await provenProof(h, "tok-bob", bobWallet);

    // Alice presents Bob's perfectly valid proof under her own session.
    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: bobWallet.address,
          message: p.message,
          signature: p.signature,
        }),
      ),
    ).toBe("NONCE_USER_MISMATCH");

    // And it is still unused, so Bob can complete his own link.
    const ok = await h.service.linkWallet({
      accessToken: "tok-bob",
      address: bobWallet.address,
      message: p.message,
      signature: p.signature,
    });
    expect(ok.userId).toBe("user-bob");
  });

  test("a signature from another key is refused", async () => {
    const alice = makeWallet();
    const impostor = makeWallet();
    const p = await provenProof(h, "tok-alice", alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: p.message,
          signature: signMessage(impostor.privateKey, p.message),
        }),
      ),
    ).toBe("SIWS_BAD_SIGNATURE");
  });

  test("an unsigned / garbage message is refused without throwing a raw error", async () => {
    const alice = makeWallet();
    await provenProof(h, "tok-alice", alice);

    expect(
      await codeOf(() =>
        h.service.linkWallet({
          accessToken: "tok-alice",
          address: alice.address,
          message: "give me the account",
          signature: "not-a-signature",
        }),
      ),
    ).toBe("SIWS_MALFORMED_MESSAGE");
  });

  test("a bad or missing session is refused before any wallet work", async () => {
    const alice = makeWallet();
    expect(
      await codeOf(() =>
        h.service.requestWalletNonce({
          accessToken: "tok-nobody",
          address: alice.address,
          domain: TEST_DOMAIN,
          uri: TEST_URI,
        }),
      ),
    ).toBe("AUTH_TOKEN_INVALID");

    expect(
      await codeOf(() =>
        h.service.requestWalletNonce({
          accessToken: "   ",
          address: alice.address,
          domain: TEST_DOMAIN,
          uri: TEST_URI,
        }),
      ),
    ).toBe("AUTH_TOKEN_MISSING");
  });

  test("a domain outside the allowlist can never be bound into a challenge", async () => {
    const alice = makeWallet();
    expect(
      await codeOf(() =>
        h.service.requestWalletNonce({
          accessToken: "tok-alice",
          address: alice.address,
          domain: "evil.example",
          uri: TEST_URI,
        }),
      ),
    ).toBe("SIWS_DOMAIN_NOT_ALLOWED");

    expect(
      await codeOf(() =>
        h.service.requestWalletNonce({
          accessToken: "tok-alice",
          address: alice.address,
          domain: TEST_DOMAIN,
          uri: "https://evil.example",
        }),
      ),
    ).toBe("SIWS_URI_NOT_ALLOWED");
  });

  test("no two of the eight required rejections share a code", async () => {
    const codes = new Set<string>();

    // 1. replayed
    {
      const g = harness();
      const w = makeWallet();
      const p = await provenProof(g, "tok-alice", w);
      const call = () =>
        g.service.linkWallet({ accessToken: "tok-alice", address: w.address, message: p.message, signature: p.signature });
      await call();
      codes.add(await codeOf(call));
    }
    // 2. expired
    {
      const g = harness();
      const w = makeWallet();
      const p = await provenProof(g, "tok-alice", w);
      g.advance(testPolicy.nonceTtlSeconds * 1000 + 1);
      codes.add(
        await codeOf(() =>
          g.service.linkWallet({ accessToken: "tok-alice", address: w.address, message: p.message, signature: p.signature }),
        ),
      );
    }
    // 3-6. domain / uri / network / statement
    const tampers: Partial<SiwsFields>[] = [
      { domain: "evil.example" },
      { uri: "https://evil.example" },
      { chainId: CHAIN_IDS["mainnet-beta"] },
      { statement: STATEMENTS.transfer_wallet },
    ];
    for (const over of tampers) {
      const g = harness();
      const w = makeWallet();
      const p = await provenProof(g, "tok-alice", w);
      const t = tamper(p.fields, over, w);
      codes.add(
        await codeOf(() =>
          g.service.linkWallet({ accessToken: "tok-alice", address: w.address, message: t.message, signature: t.signature }),
        ),
      );
    }
    // 7. wrong address
    {
      const g = harness();
      const w = makeWallet();
      const other = makeWallet();
      const p = await provenProof(g, "tok-alice", w);
      codes.add(
        await codeOf(() =>
          g.service.linkWallet({
            accessToken: "tok-alice",
            address: other.address,
            message: p.message,
            signature: p.signature,
          }),
        ),
      );
    }
    // 8. cross-user nonce
    {
      const g = harness();
      const w = makeWallet();
      const p = await provenProof(g, "tok-bob", w);
      codes.add(
        await codeOf(() =>
          g.service.linkWallet({ accessToken: "tok-alice", address: w.address, message: p.message, signature: p.signature }),
        ),
      );
    }

    expect(codes.size).toBe(8);
    expect([...codes].sort()).toEqual(
      [
        "NONCE_EXPIRED",
        "NONCE_REUSED",
        "NONCE_USER_MISMATCH",
        "SIWS_ADDRESS_MISMATCH",
        "SIWS_DOMAIN_MISMATCH",
        "SIWS_NETWORK_MISMATCH",
        "SIWS_STATEMENT_MISMATCH",
        "SIWS_URI_MISMATCH",
      ].sort(),
    );
  });
});
