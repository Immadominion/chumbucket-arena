"use client";

/**
 * Friends — same `friends` table the mobile app reads/writes (see lib/social.ts
 * for the exact query mirror of chumbucket/lib/shared/services/unified_database_service.dart).
 * Adding a friend here shows up in the mobile app's friends list too, and vice versa.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { PaperPlaneRight, UserPlus } from "@/components/icons";
import { useSession } from "@/lib/session";
import { addSupabaseFriend, listSupabaseFriends, type FriendRow } from "@/lib/social";
import { profileImageUrl } from "@/lib/supabase";
import { avatar } from "@/lib/data";
import { useWalletProfiles } from "@/lib/useWalletProfiles";

/* eslint-disable @next/next/no-img-element */

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1.5px solid #EFE6E9",
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 14,
  fontWeight: 600,
  color: "#221217",
};

export default function FriendsPage() {
  const { session } = useSession();
  const qc = useQueryClient();
  const wallet = session.wallet || "";
  const friendsKey = ["supabase-friends", wallet];

  const friendsQ = useQuery({
    queryKey: friendsKey,
    queryFn: () => listSupabaseFriends(wallet),
    enabled: !!wallet,
    staleTime: 15_000,
  });

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const addM = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      const trimmedAddress = address.trim();
      if (!trimmedName || !trimmedAddress) throw new Error("Enter both a name and a wallet address.");
      try {
        new PublicKey(trimmedAddress);
      } catch {
        throw new Error("That doesn't look like a valid Solana wallet address.");
      }
      if (session.wallet && trimmedAddress === session.wallet) {
        throw new Error("That's your own wallet address.");
      }
      return addSupabaseFriend({ walletAddress: wallet, friendWalletAddress: trimmedAddress, friendName: trimmedName });
    },
    onSuccess: (r) => {
      setNotice(r.alreadyFriends ? "You're already friends." : `Added ${name.trim()}.`);
      setName("");
      setAddress("");
      void qc.invalidateQueries({ queryKey: friendsKey });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't add that friend. Try again."),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    addM.mutate();
  };

  // Batch-resolve every friend's linked X handle in one request, so the row
  // list can show "@handle" instead of a bare wallet address where it's known.
  const friendWallets = useMemo(() => (friendsQ.data ?? []).map((f) => f.walletAddress), [friendsQ.data]);
  const profiles = useWalletProfiles(friendWallets);

  return (
    <div className="midpad" style={{ maxWidth: 760 }}>
      <div className="cd" style={{ fontSize: 24 }}>Friends</div>
      <p style={{ fontSize: 13, color: "#7C6D72", marginTop: 4, lineHeight: 1.5 }}>
        The same friends list as the ChumBucket app. Add someone by wallet address, then send them SOL directly.
      </p>

      <form onSubmit={submit} className="card" style={{ marginTop: 18, padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990", marginBottom: 10 }}>
          ADD A FRIEND
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="Their name"
            style={inputStyle}
          />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder="Wallet address"
            className="mono"
            style={inputStyle}
          />
        </div>
        <button
          type="submit"
          disabled={addM.isPending}
          className="btnp"
          style={{ width: "100%", padding: 13, borderRadius: 13, fontSize: 14, marginTop: 12, opacity: addM.isPending ? 0.6 : 1 }}
        >
          <UserPlus size={17} weight="fill" />
          {addM.isPending ? "Adding…" : "Add friend"}
        </button>
        {error && <p style={{ fontSize: 12, color: "#C2373B", marginTop: 10, fontWeight: 600 }}>{error}</p>}
        {notice && <p style={{ fontSize: 12, color: "#0A7E40", marginTop: 10, fontWeight: 600 }}>{notice}</p>}
      </form>

      <div className="cd" style={{ fontSize: 16, margin: "26px 0 12px" }}>Your friends</div>
      {friendsQ.isLoading ? (
        <div style={{ fontSize: 13, color: "#988990", fontWeight: 600 }}>Loading…</div>
      ) : friendsQ.isError ? (
        <div style={{ fontSize: 13, color: "#C2373B", fontWeight: 600 }}>Couldn&rsquo;t load friends. Try refreshing.</div>
      ) : !friendsQ.data || friendsQ.data.length === 0 ? (
        <div className="card" style={{ padding: 22, textAlign: "center", fontSize: 13, color: "#988990", fontWeight: 600 }}>
          No friends yet — add one by wallet address above.
        </div>
      ) : (
        <div className="card" style={{ padding: 6 }}>
          {friendsQ.data.map((f, i) => (
            <FriendRowItem
              key={f.walletAddress}
              friend={f}
              last={i === friendsQ.data.length - 1}
              xLabel={profiles.labelFor(f.walletAddress)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FriendRowItem({
  friend,
  last,
  xLabel,
}: {
  friend: FriendRow;
  last: boolean;
  xLabel: string | null;
}) {
  const img = profileImageUrl(friend.profileImageId);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderBottom: last ? "none" : "1px solid #F9F3F5",
      }}
    >
      {img ? (
        <img src={img} alt="" style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", background: "#F5EEF1" }} />
      ) : (
        <img src={avatar(friend.walletAddress, "d9f2e1")} alt="" style={{ width: 42, height: 42, borderRadius: "50%", background: "#d9f2e1" }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{friend.name}</div>
        {xLabel ? (
          <div style={{ fontSize: 11.5, color: "#F2385A", fontWeight: 700 }}>{xLabel}</div>
        ) : (
          <div className="mono" style={{ fontSize: 11.5, color: "#988990", fontWeight: 600 }}>
            {friend.walletAddress.slice(0, 6)}…{friend.walletAddress.slice(-4)}
          </div>
        )}
      </div>
      <Link
        href={`/send?to=${encodeURIComponent(friend.walletAddress)}&name=${encodeURIComponent(friend.name)}`}
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#F2385A", textDecoration: "none", flex: "none" }}
      >
        <PaperPlaneRight size={15} weight="fill" /> Send
      </Link>
    </div>
  );
}
