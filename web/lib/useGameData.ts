"use client";

/**
 * The read side: live game data from the backend, shaped for the screens. Public
 * queries (fixtures, ladder, the Manager's Pot) load for everyone; the player's
 * own slice (me, open calls) loads once Privy says they're authenticated. React
 * Query dedupes the `me` fetch this shares with SessionProvider.
 */

import { useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { useTRPC } from "@/lib/trpc";
import { toFixture, toLadder, toOpenCall, toPlayer, toSettledCall } from "@/lib/adapters";
import { frostToWal } from "@/lib/format";

export function useGameData() {
  const trpc = useTRPC();
  const { authenticated } = usePrivy();

  // Pots and odds move as the crowd bets; poll the public lists so every screen
  // stays live even without a per-match subscription (the Call screen adds one).
  const matchesQ = useQuery({ ...trpc.matchday.queryOptions(), refetchInterval: 8_000, refetchOnWindowFocus: true });
  const ladderQ = useQuery({ ...trpc.leaderboard.queryOptions({ by: "gr", limit: 50 }), refetchInterval: 15_000 });
  const potQ = useQuery({ ...trpc.managersPot.queryOptions(), refetchInterval: 15_000 });
  const meQ = useQuery({ ...trpc.me.queryOptions(), enabled: authenticated, retry: false });
  const settledQ = useQuery({ ...trpc.settledCalls.queryOptions({ limit: 50 }), enabled: authenticated, retry: false });

  const matches = matchesQ.data ?? [];
  const fixtures = matches.filter((m) => m.status === "OPEN").map(toFixture);

  const myWallet = meQ.data?.wallet;
  const myRank = myWallet ? ladderQ.data?.find((r) => r.wallet === myWallet)?.rank ?? 0 : 0;
  const me = meQ.data ? toPlayer(meQ.data, myRank) : null;
  const ladder = toLadder(ladderQ.data ?? [], myWallet);

  const rawOpen = meQ.data?.openCalls ?? [];
  const openCalls = rawOpen.map((c) => ({
    matchId: c.matchId,
    ...toOpenCall(c, matches.find((m) => m.fixture.matchId === c.matchId)),
  }));
  const openCall = openCalls[0] ?? null;

  const settledCalls = (settledQ.data ?? []).map((c) =>
    toSettledCall(c, matches.find((m) => m.fixture.matchId === c.matchId)),
  );

  // Every match you have a stake in (open or settled) — for marking the Matchday.
  const calledMatchIds = new Set<string>([
    ...rawOpen.map((c) => c.matchId),
    ...(settledQ.data ?? []).map((c) => c.matchId),
  ]);

  return {
    loading: matchesQ.isLoading,
    error: matchesQ.error,
    // True only when the public data genuinely failed to load — lets screens
    // Surface the backend failure instead of showing a false empty state.
    isError: matchesQ.isError && !matchesQ.data,
    // Retry the public lists (what an error state's "Try again" calls).
    refetch: () => {
      void matchesQ.refetch();
      void ladderQ.refetch();
      void potQ.refetch();
    },
    fixtures,
    featured: fixtures[0] ?? null,
    matchday: fixtures.slice(1),
    matches,
    fixtureById: (id: string) => fixtures.find((f) => f.matchId === id) ?? null,
    matchById: (id: string) => matches.find((m) => m.fixture.matchId === id) ?? null,
    me,
    meRaw: meQ.data ?? null, // full DossierView (traits, landmarks, verdict, open calls)
    ladder,
    podium: ladder.slice(0, 3),
    managersPot: Math.round(frostToWal(potQ.data ?? 0n)),
    openCall,
    openCalls,
    settledCalls,
    calledMatchIds,
  };
}
