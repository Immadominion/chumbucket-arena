"use client";

/**
 * Client session — "who's signed in and what's in the bank" — now backed by the
 * live system. Identity comes from Privy (email/social/wallet → an embedded Solana
 * wallet); money + standing come from the backend Dossier (the `me` query).
 *
 *   login()              ->  Privy modal, then the access token authenticates tRPC
 *   signContract(handle) ->  trpc.signContract.mutate({ handle })
 *   deposit(wal, proof)  ->  trpc.deposit.mutate({ amount, proof })   (custody verifies on-chain)
 *   withdraw(wal)        ->  trpc.withdraw.mutate({ amount })
 *
 * Calls are placed with trpc.makeCall on the Call screen; the resulting balance
 * change flows back through the `me` query. The Trial + spotlight tour are local
 * onboarding flags, persisted to localStorage.
 *
 * Alongside the backend Dossier, every successful Privy login also syncs the
 * SAME `users` row the mobile app (Flutter) would create/reuse in Supabase —
 * same accounts, friends and profile across both platforms. This mirrors
 * chumbucket/lib/features/authentication/providers/auth_provider.dart's
 * _syncUserWithSupabase() trigger point, but keyed by WALLET ADDRESS, not Privy
 * id — the original privy-id-keyed `sync_user` RPC no longer exists server-side
 * (confirmed via a live 404); the schema moved to `sync_user_by_wallet`,
 * matching mobile and the Arena backend. That means the sync can only fire once
 * the wallet is known — i.e. once `me` resolves — not at raw Privy-login time.
 * See lib/social.ts for the query layer and the full identity-key rationale.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { frostToWal, walToFrost } from "@/lib/format";
import { fetchSupabaseProfile, syncSupabaseUser, updateSupabaseProfile } from "@/lib/social";

export type Session = {
  status: "guest" | "signed";
  handle: string;
  wallet: string;
  balance: number; // spendable USDC (free + bonus) — what you can stake
  withdrawable: number; // free USDC only — what you can cash out
  bonus: number; // non-withdrawable starter bonus
  staked: number; // locked USDC
  onboarded: boolean; // completed The Trial
  tourDone: boolean; // seen the spotlight tour
};

const LOCAL_KEY = "chumbucket.onboarding.v1";

type Ctx = {
  session: Session;
  ready: boolean; // safe to make routing decisions (Privy settled + me resolved)
  authReady: boolean;
  authenticated: boolean;
  busy: boolean; // a write is in flight
  login: () => void;
  signContract: (handle: string) => Promise<void>;
  deposit: (wal: number, proof?: string) => Promise<void>;
  withdraw: (wal: number) => Promise<void>;
  claimWelcomeGrant: () => Promise<void>;
  refresh: () => void;
  completeTrial: () => void;
  completeTour: () => void;
  signOut: () => void;
};

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { ready: authReady, authenticated, login, logout } = usePrivy();

  const meQ = useQuery({ ...trpc.me.queryOptions(), enabled: authenticated, retry: false, staleTime: 5_000 });

  // Sync the shared Supabase `users` row once per known wallet — the wallet is
  // resolved server-side by PrivyAuth on the very first authenticated tRPC
  // call, so it's available as soon as `me` resolves, well before raw
  // Privy-login readiness would have it. Keyed on wallet (not Privy user id)
  // to match `sync_user_by_wallet`.
  const syncedWalletRef = useRef<string | null>(null);
  useEffect(() => {
    const wallet = meQ.data?.wallet;
    if (!authenticated || !wallet) return;
    if (syncedWalletRef.current === wallet) return;
    syncedWalletRef.current = wallet;
    syncSupabaseUser(wallet).catch((e) => {
      syncedWalletRef.current = null; // allow a retry on the next render/login
      console.warn("[session] sync_user_by_wallet failed", e);
    });
  }, [authenticated, meQ.data?.wallet]);

  // Local onboarding flags (The Trial + the spotlight tour).
  const [local, setLocal] = useState({ onboarded: false, tourDone: false });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) setLocal((l) => ({ ...l, ...JSON.parse(raw) }));
    } catch {
      /* ignore */
    }
  }, []);
  const persistLocal = useCallback((next: { onboarded: boolean; tourDone: boolean }) => {
    setLocal(next);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const dossier = meQ.data ?? null;
  const signed = authenticated && !!dossier;

  const session: Session = {
    status: signed ? "signed" : "guest",
    handle: dossier?.handle ?? "",
    wallet: dossier?.wallet ?? "",
    balance: dossier ? frostToWal(dossier.balance + dossier.bonus) : 0,
    withdrawable: dossier ? frostToWal(dossier.balance) : 0,
    bonus: dossier ? frostToWal(dossier.bonus) : 0,
    staked: dossier ? frostToWal(dossier.locked) : 0,
    // Onboarded if this browser says so OR the account already claimed its grant —
    // so a cleared cache / new device never re-runs the trial (or re-asks for 2 USDC).
    onboarded: local.onboarded || !!dossier?.claimedGrant,
    tourDone: local.tourDone,
  };

  // Ready to route once Privy has settled and (if logged in) `me` resolved once.
  const ready = authReady && (!authenticated || !meQ.isLoading);

  const signContractM = useMutation(trpc.signContract.mutationOptions());
  const depositM = useMutation(trpc.deposit.mutationOptions());
  const withdrawM = useMutation(trpc.withdraw.mutationOptions());
  const grantM = useMutation(trpc.claimWelcomeGrant.mutationOptions());
  const busy = signContractM.isPending || depositM.isPending || withdrawM.isPending || grantM.isPending;

  const invalidateMe = useCallback(
    () => qc.invalidateQueries({ queryKey: trpc.me.queryKey() }),
    [qc, trpc],
  );

  const value: Ctx = {
    session,
    ready,
    authReady,
    authenticated,
    busy,
    login,
    signContract: async (handle: string) => {
      await signContractM.mutateAsync({ handle: handle || undefined });
      await invalidateMe();
      // Reconcile: the backend's "handle" IS the mobile app's users.full_name —
      // there's no separate handle concept, so push the same value both places.
      // Best-effort only: the account is already fully signed up on the backend
      // at this point, so a Supabase hiccup here must not surface as an error.
      // invalidateMe() awaits the refetch, so the fresh wallet is already in
      // the cache here.
      const wallet = qc.getQueryData(trpc.me.queryKey())?.wallet;
      if (wallet) {
        try {
          const finalHandle = handle.trim() || "Chum";
          // Guarantee the users row exists before writing to it — the sync
          // effect above is fire-and-forget, so a fast handle submission could
          // otherwise race it. sync_user_by_wallet is idempotent, safe to repeat.
          await syncSupabaseUser(wallet);
          const existing = await fetchSupabaseProfile(wallet);
          await updateSupabaseProfile(wallet, finalHandle, existing?.bio ?? "");
        } catch (e) {
          console.warn("[session] full_name reconciliation failed", e);
        }
      }
    },
    deposit: async (wal: number, proof?: string) => {
      await depositM.mutateAsync({ amount: walToFrost(wal), proof });
      await invalidateMe();
    },
    withdraw: async (wal: number) => {
      await withdrawM.mutateAsync({ amount: walToFrost(wal) });
      await invalidateMe();
    },
    claimWelcomeGrant: async () => {
      await grantM.mutateAsync();
      await invalidateMe();
    },
    refresh: () => void invalidateMe(),
    completeTrial: () => persistLocal({ ...local, onboarded: true }),
    completeTour: () => persistLocal({ ...local, tourDone: true }),
    signOut: () => {
      void logout();
      persistLocal({ onboarded: false, tourDone: false });
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
