"use client";

/**
 * Calls, the live activity feed: every public call, copy, settlement and
 * claim across ChumBucket, mirroring the mobile app's Calls tab
 * (chumbucket/lib/features/arena/presentation/screens/calls_screen.dart) 1:1.
 *
 * Global reads trpc.activity (every public row); Following reads
 * trpc.followingFeed (same row shape, pre-filtered server-side to wallets you
 * follow + accepted friends). Both are already-live public procedures, no
 * backend changes here.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import ErrorState from "@/components/ErrorState";
import { FollowButton } from "@/components/FollowButton";
import { Target } from "@/components/icons";
import { avatar } from "@/lib/data";
import { shortWallet } from "@/lib/format";
import { toActivityCall, type ActivityCall } from "@/lib/adapters";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { useWalletProfiles } from "@/lib/useWalletProfiles";

/* eslint-disable @next/next/no-img-element */

const INK = "#1A1013";
const CORAL = "#FF3355";
const GRAY = "#988990";

// Raw status enums must never reach the UI, map to plain phrases (audit H2).
const STATUS_PHRASE: Record<string, string> = {
  OPEN: "Open to join",
  PENDING: "Match started",
  LOCKED: "Match started",
  MATCH_LOCKED: "Match started",
  VERIFIED: "Confirmed",
  SETTLED: "Result in",
  RESOLVED: "Result in",
  VOID: "Match void, money back",
  CLAIMABLE: "Winnings ready",
};
const statusPhrase = (s: string) => STATUS_PHRASE[s] ?? "In progress";

type FeedMode = "global" | "following";

export default function CallsPage() {
  const { session } = useSession();
  const wallet = session.wallet || "";
  const trpc = useTRPC();
  const [mode, setMode] = useState<FeedMode>("global");

  const globalQ = useQuery({
    ...trpc.activity.queryOptions({ limit: 50 }),
    enabled: mode === "global",
    refetchInterval: 15_000,
  });
  const followingQ = useQuery({
    ...trpc.followingFeed.queryOptions({ wallet, limit: 50 }),
    enabled: mode === "following" && !!wallet,
    refetchInterval: 15_000,
  });

  const active = mode === "global" ? globalQ : followingQ;
  // Depend on active.data (not a locally re-derived array) so this only
  // recomputes when the query actually resolves new rows, same idiom as
  // friends/page.tsx's friendWallets memo.
  const calls = useMemo(() => (active.data ?? []).map(toActivityCall), [active.data]);

  // Batch-resolve every distinct caller's linked X handle in one request, same
  // pattern as friends/page.tsx, falls back to a shortened wallet per row.
  const feedWallets = useMemo(() => Array.from(new Set(calls.map((c) => c.wallet))), [calls]);
  const profiles = useWalletProfiles(feedWallets);

  // A failed fetch must not masquerade as "no calls", show the real error,
  // as a top-level replacement (ErrorState carries its own midpad/60vh
  // treatment), matching matchday/results/arena's convention.
  if (active.isError && calls.length === 0) {
    return (
      <ErrorState
        onRetry={() => void active.refetch()}
        title="Couldn't load predictions"
        detail="We couldn't load the predictions feed just now. Check your connection and try again."
      />
    );
  }

  // M9: let Following switch even when signed out, and say why it's empty.
  const followingSignedOut = mode === "following" && !wallet;

  return (
    <div className="midpad" style={{ maxWidth: 760 }}>
      <div className="cd" style={{ fontSize: 24 }}>Predictions</div>
      <p style={{ fontSize: 13, color: "#7C6D72", marginTop: 4, lineHeight: 1.5 }}>
        See what everyone&rsquo;s predicting right now, who picked who, and how it turned out.
      </p>

      <FeedTabs mode={mode} onChange={setMode} />

      <div style={{ marginTop: 18 }}>
        {followingSignedOut ? (
          <div className="card" style={{ padding: 22, textAlign: "center", fontSize: 13, color: GRAY, fontWeight: 600 }}>
            Sign in to see picks from people you follow.
          </div>
        ) : active.isLoading ? (
          <div style={{ fontSize: 13, color: GRAY, fontWeight: 600, padding: "34px 0", textAlign: "center" }}>
            Loading predictions…
          </div>
        ) : calls.length === 0 ? (
          <div className="card" style={{ padding: 22, textAlign: "center", fontSize: 13, color: GRAY, fontWeight: 600 }}>
            {mode === "following"
              ? "Nobody you follow has made a pick yet, add friends on the Friends page to fill this feed."
              : "No predictions yet, the first public pick will show up here."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {calls.map((c) => (
              <CallCard
                key={c.id}
                call={c}
                isMe={!!wallet && c.wallet === wallet}
                xLabel={profiles.labelFor(c.wallet)}
                avatarUrl={profiles.profileFor(c.wallet)?.avatar_url ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedTabs({
  mode,
  onChange,
}: {
  mode: FeedMode;
  onChange: (m: FeedMode) => void;
}) {
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: "none",
    background: active ? INK : "transparent",
    color: active ? "#fff" : GRAY,
    fontWeight: 700,
    fontSize: 13,
    padding: "9px 20px",
    borderRadius: 26,
    cursor: "pointer",
  });
  return (
    <div
      style={{
        display: "inline-flex",
        background: "#fff",
        borderRadius: 30,
        padding: 4,
        boxShadow: "0 2px 8px rgba(40,16,24,.05)",
        marginTop: 18,
      }}
    >
      <button type="button" onClick={() => onChange("global")} style={tabStyle(mode === "global")}>
        Global
      </button>
      <button type="button" onClick={() => onChange("following")} style={tabStyle(mode === "following")}>
        Following
      </button>
    </div>
  );
}

function CallCard({
  call,
  isMe,
  xLabel,
  avatarUrl,
}: {
  call: ActivityCall;
  isMe: boolean;
  xLabel: string | null;
  avatarUrl: string | null;
}) {
  const identity = isMe ? "You" : xLabel ?? shortWallet(call.wallet);
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Link href={`/caller/${call.wallet}`} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", background: "#F5EEF1", flex: "none" }} />
          ) : (
            <img src={avatar(call.wallet, "d9f2e1")} alt="" style={{ width: 40, height: 40, borderRadius: "50%", background: "#d9f2e1", flex: "none" }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {identity}
            </div>
            <div style={{ fontSize: 11.5, color: GRAY, fontWeight: 600, marginTop: 1 }}>
              {call.verb} · {call.when}
            </div>
          </div>
        </Link>
        {!isMe && <FollowButton target={call.wallet} />}
      </div>

      <div className="cd" style={{ fontSize: 15, marginTop: 10, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {call.home} <span style={{ color: "#CBBFC3", fontWeight: 600 }}>vs</span> {call.away}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: call.bucketColor, background: call.bucketBg, padding: "6px 10px", borderRadius: 8 }}>
          {call.bucketLabel}
        </span>
        {call.stake != null && (
          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{call.stake.toFixed(1)} USDC</span>
        )}
        <div style={{ marginLeft: "auto" }}>
          {!call.isSettled && call.matchId ? (
            <Link
              href={`/bet/${call.matchId}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#fff", background: CORAL, padding: "7px 13px", borderRadius: 20, textDecoration: "none" }}
            >
              <Target size={12} weight="fill" /> Make this pick
            </Link>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 700, color: call.isSettled ? "#0A7E40" : GRAY }}>
              {statusPhrase(call.status)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
