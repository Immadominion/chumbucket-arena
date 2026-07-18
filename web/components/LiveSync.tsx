"use client";

/**
 * Headless real-time sync. The backend pushes the player's dossier and their
 * settlement feed over WebSocket (tRPC subscriptions); this mounts once inside
 * the signed-in app and folds every pushed update into the React Query cache,
 * so balance, rating, form, open calls, settlements and Verdicts go live on
 * every screen without any page subscribing itself. Match-level liveness (pot
 * / odds on the Call screen) is handled per-match where it's needed.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useTRPC } from "@/lib/trpc";

export default function LiveSync() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { authenticated } = usePrivy();

  // The player's whole dossier, pushed on every change → keeps `me`
  // (balance, GR, tier, form, open calls) live app-wide.
  useSubscription(
    trpc.onDossier.subscriptionOptions(undefined, {
      enabled: authenticated,
      onData: (dossier) => {
        qc.setQueryData(trpc.me.queryKey(), dossier);
      },
    }),
  );

  // Settlement / promotion / verdict events → refresh the money-and-record
  // surfaces the dossier push doesn't already cover.
  useSubscription(
    trpc.onFeed.subscriptionOptions(undefined, {
      enabled: authenticated,
      onData: () => {
        void qc.invalidateQueries({ queryKey: trpc.settledCalls.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.matchday.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.leaderboard.queryKey() });
      },
    }),
  );

  return null;
}
