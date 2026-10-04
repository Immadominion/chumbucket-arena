"use client";

/**
 * Every read the screens make, as React Query hooks with stable keys. Reads
 * refetch quietly (on focus, on reconnect, and on an interval where the data
 * moves), and the cache is saved per account (data.tsx), so a screen never
 * opens blank twice.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogInput, type MarketFilters } from "@/lib/webapp/filters";
import type { CallFeedEntry, FeedPage, MarketDetail, PersonDetail } from "@/lib/webapp/types";
import { useApi } from "./session";

export const keys = {
  feed: (mode: "following" | "global") => ["feed", mode] as const,
  call: (id: string) => ["call", id] as const,
  market: (id: string) => ["market", id] as const,
  catalog: (f: Omit<MarketFilters, "window">) => ["catalog", f.query.trim(), f.topic, f.sort] as const,
  openMarkets: ["openMarkets"] as const,
  person: (ref: string) => ["person", ref.replace(/^@+/, "").toLowerCase()] as const,
  me: ["me"] as const,
  inbox: ["inbox"] as const,
  unread: ["unread"] as const,
  following: ["following"] as const,
  suggested: ["suggested"] as const,
  leaderboard: (w: string) => ["leaderboard", w] as const,
};

const MINUTE = 60_000;

export function useFeed(mode: "following" | "global") {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.feed(mode),
    queryFn: ({ pageParam }) => api.feed(mode, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: FeedPage) => last.nextCursor,
    refetchInterval: MINUTE,
  });
}

export function useCallDetail(callId: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.call(callId), queryFn: () => api.call(callId), refetchInterval: MINUTE });
}

/**
 * A market and its Panta prices. `live` (the market's own screen) keeps the
 * prices fresh every minute; a card in a list reads them once and on focus.
 */
export function useMarket(marketId: string, opts: { enabled?: boolean; live?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.market(marketId),
    queryFn: () => api.market(marketId),
    refetchInterval: opts.live ? MINUTE : false,
    staleTime: opts.live ? MINUTE : 2 * MINUTE,
    enabled: opts.enabled ?? true,
  });
}

export function useCatalog(filters: MarketFilters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.catalog(filters),
    queryFn: ({ pageParam }) => api.catalog(catalogInput(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 2 * MINUTE,
    placeholderData: (prev) => prev,
  });
}

/** Markets a call can be locked on right now (a fresh Panta price exists). */
export function useOpenMarkets() {
  const api = useApi();
  return useQuery({ queryKey: keys.openMarkets, queryFn: () => api.openMarkets(), staleTime: 2 * MINUTE });
}

export function usePerson(ref: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.person(ref), queryFn: () => api.person(ref) });
}

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 5 * MINUTE });
}

export function useInbox() {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.inbox,
    queryFn: ({ pageParam }) => api.inbox(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: MINUTE,
  });
}

export function useUnread() {
  const api = useApi();
  return useQuery({ queryKey: keys.unread, queryFn: () => api.unread(), refetchInterval: MINUTE, select: (d) => d.unread });
}

export function useFollowing() {
  const api = useApi();
  return useQuery({ queryKey: keys.following, queryFn: () => api.following() });
}

export function useSuggested() {
  const api = useApi();
  return useQuery({ queryKey: keys.suggested, queryFn: () => api.suggested(), staleTime: 5 * MINUTE });
}

export function useLeaderboard(window: "7d" | "30d" | "all") {
  const api = useApi();
  return useQuery({ queryKey: keys.leaderboard(window), queryFn: () => api.leaderboard(window), staleTime: 5 * MINUTE });
}

/**
 * Follow / unfollow, optimistically: the button flips at once and flips back
 * only if the BFF refuses.
 */
export function useFollow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, follow }: { ref: string; follow: boolean }) => (follow ? api.follow(ref) : api.unfollow(ref)),
    onMutate: async ({ ref, follow }) => {
      const key = keys.person(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PersonDetail>(key);
      if (prev) {
        qc.setQueryData<PersonDetail>(key, {
          ...prev,
          viewerIsFollowing: follow,
          followerCount: Math.max(0, prev.followerCount + (follow === prev.viewerIsFollowing ? 0 : follow ? 1 : -1)),
        });
      }
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["person"] });
      void qc.invalidateQueries({ queryKey: keys.following });
      void qc.invalidateQueries({ queryKey: keys.suggested });
      void qc.invalidateQueries({ queryKey: ["feed", "following"] });
    },
  });
}

/**
 * After a new call: the market shows "You called …" at once (no flash of the
 * YES / NO picks while it re-reads), and every list that could show the call
 * learns about it.
 */
export function useAfterCall() {
  const qc = useQueryClient();
  return (entry: CallFeedEntry | null, marketId: string) => {
    if (entry) {
      qc.setQueryData<MarketDetail>(keys.market(marketId), (old) => (old && !old.viewerCall ? { ...old, viewerCall: entry } : old));
    }
    void qc.invalidateQueries({ queryKey: keys.market(marketId) });
    void qc.invalidateQueries({ queryKey: ["feed"] });
    void qc.invalidateQueries({ queryKey: ["call"] });
    void qc.invalidateQueries({ queryKey: ["person"] });
    if (entry) qc.setQueryData(keys.call(entry.call.id), (old: unknown) => old ?? { entry, parent: null, responses: [] });
  };
}
