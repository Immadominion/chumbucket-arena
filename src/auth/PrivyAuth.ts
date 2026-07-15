/**
 * Privy auth — the production identity layer. Verifies the user's Privy access
 * token (local JWT verification, no per-request network), then resolves them to
 * a server-authoritative **Solana** embedded wallet.
 *
 * We create the wallet explicitly with chain_type 'solana' and key it to the
 * user via a deterministic external_id + idempotency_key — so "get or create"
 * is one safe, repeatable call. That address is the player identity the rest
 * of the system already speaks in. (The frontend should treat this as the
 * user's wallet — i.e. fund *this* address — so there's exactly one wallet per
 * player.)
 */

import { PrivyClient } from "@privy-io/node";
import { asWallet, type Wallet } from "../domain/ids.ts";
import type { Auth, AuthedUser } from "./Auth.ts";

const externalId = (userId: string): string =>
  userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

interface PrivyWalletInfo {
  wallet: Wallet;
  walletId: string;
}

export class PrivyAuth implements Auth {
  private readonly client: PrivyClient;
  private readonly walletByUser = new Map<string, PrivyWalletInfo>();

  constructor(appId: string, appSecret: string, verificationKey?: string) {
    this.client = new PrivyClient({
      appId,
      appSecret,
      ...(verificationKey ? { jwtVerificationKey: verificationKey } : {}),
    });
  }

  async verify(token: string): Promise<AuthedUser | null> {
    const t = token?.trim();
    if (!t) return null;

    let userId: string;
    try {
      const claims = await this.client.utils().auth().verifyAuthToken(t);
      userId = claims.user_id;
    } catch {
      return null; // missing / invalid / expired token → logged-out
    }

    const info = await this.resolveWallet(userId); // may throw on a real server error
    return {
      userId,
      wallet: info.wallet,
      privyWalletId: info.walletId,
    };
  }

  private async resolveWallet(userId: string): Promise<PrivyWalletInfo> {
    const cached = this.walletByUser.get(userId);
    if (cached) return cached;

    const ext = externalId(userId);
    const created = (await this.client.wallets().create({
      chain_type: "solana",
      external_id: ext,
      idempotency_key: `gaffer:${ext}`,
    })) as unknown as { id: string; address: string };
    const info: PrivyWalletInfo = {
      wallet: asWallet(created.address),
      walletId: created.id,
    };
    this.walletByUser.set(userId, info);
    return info;
  }
}
