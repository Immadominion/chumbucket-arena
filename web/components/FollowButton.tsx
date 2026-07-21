"use client";

/**
 * Follow/Following toggle for a caller — turns the predictions feed into the
 * follow-acquisition surface the mobile app already is. Signs the same
 * wallet-signature "follow"/"unfollow" proof (lib/walletSign) the backend's
 * verifySocialAction expects, and optimistically flips state. A cancelled
 * signature just reverts — never a hard error.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import { useTRPC } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { signSocialAction } from "@/lib/walletSign";

export function FollowButton({ target, initialFollowing = false }: { target: string; initialFollowing?: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { session } = useSession();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  const followM = useMutation(trpc.follow.mutationOptions());
  const unfollowM = useMutation(trpc.unfollow.mutationOptions());

  const wallet = wallets.find((w) => w.address === session.wallet) ?? wallets[0];

  const toggle = async () => {
    if (!wallet || busy || wallet.address === target) return;
    setBusy(true);
    const next = !following;
    setFollowing(next); // optimistic
    try {
      const proof = await signSocialAction({ action: next ? "follow" : "unfollow", target, wallet, signMessage });
      await (next ? followM : unfollowM).mutateAsync({ wallet: wallet.address, target, timestamp: proof.timestamp, signature: proof.signature });
      await qc.invalidateQueries({ queryKey: trpc.followingFeed.queryKey() }).catch(() => {});
    } catch {
      setFollowing(!next); // revert on cancel/error
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      style={{
        flex: "none",
        cursor: busy ? "default" : "pointer",
        border: following ? "1.5px solid #EFE6E9" : "none",
        background: following ? "#fff" : "#FF3355",
        color: following ? "#6A5A60" : "#fff",
        fontWeight: 700,
        fontSize: 12,
        padding: "6px 14px",
        borderRadius: 20,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
