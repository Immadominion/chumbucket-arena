"use client";

/**
 * Scans the matches the player might have an on-chain position in (anything
 * that isn't still OPEN) for a settled/void Pot with an unclaimed Position —
 * i.e. what the Wallet/Results screens' "Claim" button needs. Pull-based by
 * design (chumbucket_arena's claim is a player-signed instruction, not an
 * automatic payout), so this is purely a read — nothing here moves money.
 *
 * Note: trpc.matchday's match list is the off-chain read-model (event-sourced
 * from the SAME TxLINE fixtures the on-chain keeper drives), used here only to
 * know which matchIds exist and roughly when they finished — it never reflects
 * on-chain stake amounts placed via placeCall, only the on-chain Pot/Position
 * accounts fetched below do.
 */

import { useQuery } from "@tanstack/react-query";
import { useGameData } from "@/lib/useGameData";
import { useSession } from "@/lib/session";
import {
  estimateClaimPayout,
  fetchPosition,
  fetchPot,
  isClaimablePot,
  type OnchainPosition,
  type OnchainPot,
} from "@/lib/arena-onchain";
import type { MatchView } from "@/lib/adapters";

export type ClaimablePosition = {
  matchId: string;
  match: MatchView | undefined;
  pot: OnchainPot;
  position: OnchainPosition;
  /** USDC base units (1e6 = 1 USDC) the claim() call would pay out. */
  payout: bigint;
  won: boolean;
};

export type OpenPosition = {
  matchId: string;
  match: MatchView | undefined;
  /** RESULT bucket slot: 0 HOME · 1 DRAW · 2 AWAY. */
  bucket: number;
  /** USDC base units (1e6 = 1 USDC). */
  stake: bigint;
};

/**
 * The player's OPEN on-chain bets — read straight from the Position accounts on
 * still-OPEN matches. This is the authoritative source for "Your bets": a bet
 * placed via placeCall shows here immediately, unlike the custodial dossier
 * (which only ever saw the old off-chain call path).
 */
export function useOpenPositions() {
  const { session } = useSession();
  const g = useGameData();
  const wallet = session.wallet;

  const openMatchIds = g.matches.filter((m) => m.status === "OPEN").map((m) => m.fixture.matchId);
  const key = openMatchIds.join(",");

  const q = useQuery({
    queryKey: ["onchain-open-positions", wallet, key],
    queryFn: async () => {
      const out: OpenPosition[] = [];
      for (const matchId of openMatchIds) {
        const position = await fetchPosition(matchId, wallet);
        if (!position || position.stake <= 0n) continue;
        out.push({
          matchId,
          match: g.matches.find((m) => m.fixture.matchId === matchId),
          bucket: position.bucket,
          stake: position.stake,
        });
      }
      return out;
    },
    enabled: !!wallet && openMatchIds.length > 0,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  return { open: q.data ?? [], isLoading: q.isLoading, refetch: q.refetch };
}

export function useClaimablePositions() {
  const { session } = useSession();
  const g = useGameData();
  const wallet = session.wallet;

  // A Pot can only be SETTLED/VOID once its match has kicked off — skip
  // still-OPEN matches so we don't burn an RPC round trip per open fixture.
  const candidateMatchIds = g.matches.filter((m) => m.status !== "OPEN").map((m) => m.fixture.matchId);
  const candidateKey = candidateMatchIds.join(",");

  const q = useQuery({
    queryKey: ["onchain-claimable", wallet, candidateKey],
    queryFn: async () => {
      const out: ClaimablePosition[] = [];
      for (const matchId of candidateMatchIds) {
        const pot = await fetchPot(matchId);
        if (!pot || !isClaimablePot(pot)) continue;
        const position = await fetchPosition(matchId, wallet);
        if (!position) continue; // no on-chain stake here, or already claimed (position account closed)
        out.push({
          matchId,
          match: g.matches.find((m) => m.fixture.matchId === matchId),
          pot,
          position,
          payout: estimateClaimPayout(pot, position),
          won: position.bucket === pot.winningBucket,
        });
      }
      return out;
    },
    enabled: !!wallet && candidateMatchIds.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  return {
    claimable: q.data ?? [],
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
