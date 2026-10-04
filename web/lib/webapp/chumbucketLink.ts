/**
 * Linking the Chumbucket wallet to the account: the same single-use
 * Sign-in-with-Solana proof every wallet uses, labelled "chumbucket".
 *
 *   auth.requestWalletNonce   the BFF binds a challenge to this account and
 *                             this address (purpose link_wallet)
 *   sign                      the wallet signs exactly that text
 *   auth.linkWallet           the BFF verifies, spends the challenge, links
 *
 * The domain and URI are the product's own (`chumbucket.fun`), as the phone
 * uses them: the BFF only issues challenges for its allow-listed domain, and
 * this signature is made by the account's own embedded wallet, not shown to a
 * person on some other site. No transaction, nothing moves.
 *
 * Pure: the BFF repo's bun tests import it.
 */

import bs58 from "bs58";

export const LINK_DOMAIN = "chumbucket.fun";
export const LINK_URI = "https://chumbucket.fun";
export const CHUMBUCKET_WALLET_TYPE = "chumbucket";

export interface WalletLinkApi {
  requestWalletLink(supabaseAccessToken: string, address: string): Promise<{ message: string }>;
  linkWallet(
    supabaseAccessToken: string,
    input: { address: string; message: string; signature: string; walletType: typeof CHUMBUCKET_WALLET_TYPE },
  ): Promise<{ address: string; outcome: string }>;
}

export class WalletLinkRefused extends Error {}

/** True when [message] is a link challenge for exactly [address] on our domain. */
export function isLinkChallenge(message: string, address: string): boolean {
  const lines = message.split("\n");
  return (
    lines[0] === `${LINK_DOMAIN} wants you to sign in with your Solana account:` &&
    lines[1] === address &&
    lines.includes(`URI: ${LINK_URI}`) &&
    lines[lines.length - 1] === "- chumbucket:purpose:link_wallet"
  );
}

export async function linkChumbucketWallet(args: {
  api: WalletLinkApi;
  token: string;
  address: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<void> {
  const { message } = await args.api.requestWalletLink(args.token, args.address);
  if (typeof message !== "string" || !isLinkChallenge(message, args.address)) throw new WalletLinkRefused("challenge");
  const signature = await args.signMessage(new TextEncoder().encode(message));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new WalletLinkRefused("signature");
  const linked = await args.api.linkWallet(args.token, {
    address: args.address,
    message,
    signature: bs58.encode(signature),
    walletType: CHUMBUCKET_WALLET_TYPE,
  });
  if (linked.address !== args.address || (linked.outcome !== "linked" && linked.outcome !== "reaffirmed")) {
    throw new WalletLinkRefused("unconfirmed");
  }
}
