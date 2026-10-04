/**
 * Sign in with Solana, as Supabase Auth's Web3 grant accepts it.
 *
 * The wallet signs one plain-text message — no transaction, no fee, nothing
 * moves — and Supabase verifies the signature and issues the same kind of
 * session Google and X get. The message is built line for line as the
 * Android app builds it (`solana_sign_in.dart`), which is line for line how
 * Supabase's own client builds it: the server re-parses exactly this text.
 *
 * On chumbucket.fun the domain and URI are the ones the app already uses
 * (`chumbucket.fun`, `https://chumbucket.fun`), which are on the project's
 * redirect allow-list. Supabase checks that the domain matches the URI's
 * host and that "Issued At" is recent.
 *
 * Pure: the browser wallet plumbing lives in components/webapp/wallets.ts.
 */

export const SIGN_IN_STATEMENT =
  "Sign in to Chumbucket. This is a signature, not a transaction: it costs nothing and moves nothing.";

export function signInMessage(args: {
  domain: string;
  uri: string;
  address: string;
  issuedAt: Date;
  statement?: string;
}): string {
  return [
    `${args.domain} wants you to sign in with your Solana account:`,
    args.address,
    "",
    args.statement ?? SIGN_IN_STATEMENT,
    "",
    "Version: 1",
    `URI: ${args.uri}`,
    `Issued At: ${args.issuedAt.toISOString()}`,
  ].join("\n");
}

/** Byte-for-byte equality: the wallet must sign exactly the message it was given. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
