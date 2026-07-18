"use client";

/**
 * Batch-resolve wallet addresses to their linked-identity profile (X handle,
 * display name, avatar) via the same `walletProfiles` procedure mobile's
 * activity feed would use. One request per distinct wallet set — callers
 * should pass a stable (e.g. useMemo'd) array so React Query can dedupe.
 */

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

export function useWalletProfiles(wallets: string[]) {
  const trpc = useTRPC();
  const unique = Array.from(new Set(wallets.filter(Boolean)));

  const profilesQ = useQuery({
    ...trpc.walletProfiles.queryOptions({ wallets: unique }),
    enabled: unique.length > 0,
    staleTime: 60_000,
  });

  const byWallet = new Map((profilesQ.data ?? []).map((p) => [p.wallet_address, p]));

  return {
    isLoading: profilesQ.isLoading,
    /** @x_handle if linked, else display_name/handle, else null — caller decides the wallet-shortened fallback. */
    labelFor: (wallet: string): string | null => {
      const p = byWallet.get(wallet);
      if (!p) return null;
      return p.x_handle ? `@${p.x_handle}` : p.display_name ?? p.handle ?? null;
    },
    profileFor: (wallet: string) => byWallet.get(wallet) ?? null,
  };
}
