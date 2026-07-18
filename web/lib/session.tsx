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
 * _syncUserWithSupabase() trigger point exactly (call sync_user right after
 * Privy auth succeeds). See lib/social.ts for the query layer.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { frostToWal, walToFrost } from "@/lib/format";
import { fetchSupabaseProfile, syncSupabaseUser, updateSupabaseProfile } from "@/lib/social";

/** Best-effort email for sync_user(): mobile only ever logs in with email, so it
 * always has one. Web also allows Google / X / wallet login, where an email may
 * not exist — X in particular never exposes one via Privy. We fall back through
 * the linked accounts that do carry an email, then an empty string as a last
 * resort so the account still gets created (open question: unverified against
 * the actual sync_user SQL, since it isn't in this repo). */
function bestEffortEmail(user: ReturnType<typeof usePrivy>["user"]): string {
  return user?.email?.address ?? user?.google?.email ?? user?.apple?.email ?? "";
}

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
  const { ready: authReady, authenticated, user, login, logout } = usePrivy();

  const meQ = useQuery({ ...trpc.me.queryOptions(), enabled: authenticated, retry: false, staleTime: 5_000 });

  // Sync the shared Supabase `users` row once per authenticated Privy identity —
  // same trigger point as mobile (right after login succeeds), independent of
  // whether this browser has picked a handle with the backend yet.
  const syncedPrivyIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authReady || !authenticated || !user?.id) return;
    if (syncedPrivyIdRef.current === user.id) return;
    syncedPrivyIdRef.current = user.id;
    syncSupabaseUser(user.id, bestEffortEmail(user)).catch((e) => {
      syncedPrivyIdRef.current = null; // allow a retry on the next render/login
      console.warn("[session] sync_user failed", e);
    });
  }, [authReady, authenticated, user]);

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
      if (user?.id) {
        try {
          const finalHandle = handle.trim() || "Chum";
          // Guarantee the users row exists before writing to it — the sync_user
          // effect above is fire-and-forget, so a fast handle submission could
          // otherwise race it. sync_user is idempotent on mobile, safe to repeat.
          await syncSupabaseUser(user.id, bestEffortEmail(user));
          const existing = await fetchSupabaseProfile(user.id);
          await updateSupabaseProfile(user.id, finalHandle, existing?.bio ?? "");
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
