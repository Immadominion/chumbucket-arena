"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Modal from "@/components/ui/Modal";
import { CheckCircle, PencilSimple } from "@/components/icons";
import { PROFILE_IMAGE_IDS, profileImageUrl } from "@/lib/supabase";
import { fetchSupabaseProfile, setSupabaseProfileImage, updateSupabaseProfile } from "@/lib/social";
import { useSession } from "@/lib/session";

/* eslint-disable @next/next/no-img-element */

/**
 * Profile edit — full_name/bio + one of the 5 preset avatars, all written to the
 * SAME Supabase `users` row the mobile app reads/writes (see lib/social.ts).
 *
 * Mobile has no free-form photo upload today: its picker
 * (widgets/profile_picture_selection_modal.dart) offers exactly these 5 bundled
 * images and writes `profile_image_id` directly (there's an
 * `update_user_profile_with_pfp` RPC defined server-side, but mobile's own live
 * code never calls it — only a commented-out call site exists). This mirrors
 * mobile's REAL behavior: full_name/bio via `update_user_profile`, avatar via a
 * direct `users` table update.
 */
export default function EditProfileModal({
  open,
  onClose,
  currentHandle,
}: {
  open: boolean;
  onClose: () => void;
  /** Fallback display name if Supabase has none yet (e.g. the signup handle). */
  currentHandle: string;
}) {
  const { session } = useSession();
  const wallet = session.wallet || "";
  const qc = useQueryClient();

  const profileQ = useQuery({
    queryKey: ["supabase-profile", wallet],
    queryFn: () => fetchSupabaseProfile(wallet),
    enabled: open && !!wallet,
    staleTime: 0,
  });

  const [fullName, setFullName] = useState("");
  const [bio, setBio] = useState("");
  const [imageId, setImageId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (profileQ.data) {
      setFullName(profileQ.data.full_name ?? currentHandle);
      setBio(profileQ.data.bio ?? "");
      setImageId(profileQ.data.profile_image_id ?? null);
    } else if (!profileQ.isLoading) {
      setFullName(currentHandle);
      setBio("");
      setImageId(null);
    }
  }, [open, profileQ.data, profileQ.isLoading, currentHandle]);

  const saveM = useMutation({
    mutationFn: async () => {
      const trimmedName = fullName.trim() || currentHandle || "Chum";
      await updateSupabaseProfile(wallet, trimmedName, bio.trim());
      if (imageId !== null && imageId !== profileQ.data?.profile_image_id) {
        await setSupabaseProfileImage(wallet, imageId);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["supabase-profile", wallet] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save your profile. Try again."),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    saveM.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} width={440} label="Edit profile">
      <div style={{ padding: 28 }}>
        <h2 className="cd" style={{ fontSize: 22, margin: "0 0 4px" }}>Edit profile</h2>
        <p style={{ fontSize: 12.5, color: "#7C6D72", margin: "0 0 20px", lineHeight: 1.45 }}>
          Shown to friends on web and in the ChumBucket app.
        </p>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990", marginBottom: 10 }}>AVATAR</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          {PROFILE_IMAGE_IDS.map((id) => {
            const selected = imageId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setImageId(id)}
                aria-pressed={selected}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  padding: 0,
                  border: selected ? "2.5px solid #F2385A" : "2.5px solid transparent",
                  cursor: "pointer",
                  background: "#F5EEF1",
                  position: "relative",
                  flex: "none",
                }}
              >
                <img
                  src={profileImageUrl(id) ?? ""}
                  alt={`Avatar ${id}`}
                  style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
                />
                {selected && (
                  <span style={{ position: "absolute", bottom: -2, right: -2, background: "#F2385A", borderRadius: "50%", padding: 2, display: "flex" }}>
                    <CheckCircle size={13} weight="fill" color="#fff" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <form onSubmit={submit}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990", marginBottom: 8 }}>DISPLAY NAME</div>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value.slice(0, 60))}
            placeholder="Your name"
            style={{ width: "100%", border: "1.5px solid #EFE6E9", borderRadius: 13, padding: "13px 15px", fontSize: 15, fontWeight: 700, color: "#221217", marginBottom: 14 }}
          />

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".6px", color: "#988990", marginBottom: 8 }}>BIO</div>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, 160))}
            placeholder="A line about yourself"
            rows={3}
            style={{ width: "100%", border: "1.5px solid #EFE6E9", borderRadius: 13, padding: "13px 15px", fontSize: 13.5, fontWeight: 500, color: "#221217", resize: "none", fontFamily: "inherit", marginBottom: 18 }}
          />

          <button type="submit" disabled={saveM.isPending} className="btnp" style={{ width: "100%", padding: 14, borderRadius: 14, fontSize: 15, opacity: saveM.isPending ? 0.6 : 1 }}>
            <PencilSimple size={17} weight="fill" />
            {saveM.isPending ? "Saving…" : "Save profile"}
          </button>
        </form>
        {error && <p style={{ fontSize: 12, color: "#C2373B", textAlign: "center", marginTop: 12, fontWeight: 600 }}>{error}</p>}
      </div>
    </Modal>
  );
}
