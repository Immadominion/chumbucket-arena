/**
 * The token the apps hand Privy for the Chumbucket wallet: one wallet per
 * ACCOUNT, not per sign-in.
 *
 * An account can be reached through several Supabase sign-ins (wallet, X,
 * Google). Keyed on a Supabase `sub`, Privy would give each sign-in its own
 * wallet. So the BFF mints its own short-lived JWT whose `sub` is the
 * account (`public.users.id`, resolved exactly as every other procedure
 * resolves it), and Privy verifies it against the BFF's own JWKS:
 *
 *   header   { alg: "ES256", typ: "JWT", kid }
 *   payload  { iss: <BFF public base URL>, sub: <account id>,
 *              aud: "chumbucket-privy", iat, exp: iat + 600, jti }
 *
 * The private key arrives in PRIVY_JWT_PRIVATE_KEY (PEM or JWK, P-256) and is
 * never logged, returned or put in an error. `kid` is the key's RFC 7638
 * thumbprint, so a rotated key gets a new kid on its own.
 *
 * Making a key locally, without printing it (docs/chumbucket-wallet.md):
 *   openssl ecparam -name prime256v1 -genkey -noout \
 *     | openssl pkcs8 -topk8 -nocrypt -out privy-jwt.pem
 *   railway variables --set "PRIVY_JWT_PRIVATE_KEY=$(cat privy-jwt.pem)" >/dev/null
 */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";

export const PRIVY_JWT_AUDIENCE = "chumbucket-privy";
export const PRIVY_JWT_TTL_SECONDS = 600;
export const PRIVY_JWKS_PATH = "/.well-known/chumbucket-privy-jwks.json";

export interface PrivyJwtConfig {
  /** PEM (PKCS#8 or SEC1) or a JWK as JSON. A P-256 private key. */
  privateKey: string;
  /** The BFF's public https base URL; the token's `iss`. */
  issuer: string;
}

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

function privateKeyFrom(raw: string): KeyObject {
  const text = raw.trim();
  const key = text.startsWith("{")
    ? createPrivateKey({ key: JSON.parse(text) as Record<string, string>, format: "jwk" })
    : // A one-line env value keeps its newlines as "\n".
      createPrivateKey(text.replace(/\\n/g, "\n"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("PRIVY_JWT_PRIVATE_KEY must be a P-256 key");
  }
  return key;
}

export class PrivyJwtSigner {
  private constructor(
    private readonly key: KeyObject,
    readonly publicJwk: PublicJwk,
    readonly issuer: string,
    private readonly now: () => number,
  ) {}

  /** Throws on an unusable key or issuer. The message never carries the key. */
  static fromConfig(cfg: PrivyJwtConfig, now: () => number = Date.now): PrivyJwtSigner {
    let key: KeyObject;
    try {
      key = privateKeyFrom(cfg.privateKey);
    } catch {
      throw new Error("PRIVY_JWT_PRIVATE_KEY is not a usable P-256 private key");
    }
    const issuer = new URL(cfg.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error("BFF_PUBLIC_URL must be a plain https URL");
    }
    const pub = createPublicKey(key as unknown as Parameters<typeof createPublicKey>[0]).export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
    // RFC 7638: the required members, lexicographic, no whitespace.
    const kid = b64url(createHash("sha256").update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y })).digest());
    const jwk: PublicJwk = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid, alg: "ES256", use: "sig" };
    return new PrivyJwtSigner(key, jwk, issuer.origin, now);
  }

  /** A token for exactly one account, valid for ten minutes. */
  mint(accountId: string): { token: string; expiresAt: number } {
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("not an account id");
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + PRIVY_JWT_TTL_SECONDS;
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.publicJwk.kid }));
    const payload = b64url(
      JSON.stringify({ iss: this.issuer, sub: accountId, aud: PRIVY_JWT_AUDIENCE, iat, exp, jti: randomUUID() }),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: this.key, dsaEncoding: "ieee-p1363" });
    return { token: `${header}.${payload}.${b64url(signature)}`, expiresAt: exp * 1000 };
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: [this.publicJwk] };
  }
}

const signers = new WeakMap<object, PrivyJwtSigner | null>();

/** Memoised per config object; null when either env value is missing or unusable. */
export function privyJwtSignerFor(owner: object, cfg: PrivyJwtConfig | undefined): PrivyJwtSigner | null {
  if (signers.has(owner)) return signers.get(owner)!;
  let signer: PrivyJwtSigner | null = null;
  try {
    signer = cfg ? PrivyJwtSigner.fromConfig(cfg) : null;
  } catch (error) {
    // The reason only; never the value.
    console.error("[wallet] Privy JWT signer unavailable:", error instanceof Error ? error.message : "invalid");
    signer = null;
  }
  signers.set(owner, signer);
  return signer;
}
