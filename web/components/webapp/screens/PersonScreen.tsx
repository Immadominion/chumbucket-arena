"use client";

/**
 * A person: their picture, name, record and calls. Your own profile adds
 * edit and settings; anyone else's adds follow and share.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isSettled, joined, recordA11y, recordToken, shortWallet, compact } from "@/lib/webapp/format";
import { publicPath } from "@/lib/webapp/paths";
import type { PersonDetail } from "@/lib/webapp/types";
import { GET_APP_HREF } from "@/components/site/config";
import { CallCard, FollowButton, useShare } from "../cards";
import { actionError, useToast } from "../data";
import { Icon } from "../Icon";
import { keys, useMe, usePerson } from "../queries";
import { useApi, useAuth, useViewer } from "../session";
import { Avatar, Segmented, Sheet, Spinner, StateScreen, TopBar } from "../ui";
import { screenError } from "./common";

type Tab = "open" | "settled";

export function MeScreen() {
  const viewer = useViewer();
  return <PersonScreen personRef={viewer.handle ?? viewer.userId} mine />;
}

export function PersonScreen({ personRef, mine = false }: { personRef: string; mine?: boolean }) {
  const viewer = useViewer();
  const q = usePerson(personRef);
  const share = useShare();
  const [editing, setEditing] = useState(false);
  const [settings, setSettings] = useState(false);
  const d = q.data;
  const self = mine || (d ? d.person.id === viewer.userId : false);

  return (
    <>
      <TopBar title={self ? "Profile" : undefined} back={!mine}>
        {d ? (
          <button type="button" className="wa-iconbtn" aria-label="Share profile" onClick={() => share(publicPath.profile(d.person.handle), d.person.displayName)}>
            <Icon name="share" size={22} />
          </button>
        ) : null}
        {self ? (
          <button type="button" className="wa-iconbtn" aria-label="Settings" onClick={() => setSettings(true)}>
            <Icon name="settings" size={22} />
          </button>
        ) : null}
      </TopBar>
      {d ? (
        <ProfileBody detail={d} self={self} onEdit={() => setEditing(true)} />
      ) : q.isPending ? (
        <div className="wa-card wa-profile" aria-hidden style={{ minHeight: 220 }}>
          <div style={{ display: "flex", gap: 14 }}>
            <div className="wa-skel" style={{ width: 76, height: 76, borderRadius: "50%" }} />
            <div style={{ flex: 1 }}>
              <div className="wa-skel" style={{ width: "50%", height: 20, marginTop: 8 }} />
              <div className="wa-skel" style={{ width: "30%", height: 12, marginTop: 10 }} />
            </div>
          </div>
        </div>
      ) : (
        screenError(q.error, () => void q.refetch(), "This person isn’t here")
      )}
      {self ? <EditProfileSheet open={editing} onClose={() => setEditing(false)} /> : null}
      {self ? <SettingsSheet open={settings} onClose={() => setSettings(false)} /> : null}
    </>
  );
}

function ProfileBody({ detail, self, onEdit }: { detail: PersonDetail; self: boolean; onEdit: () => void }) {
  const { person, calls, record } = detail;
  const open = calls.filter((c) => !isSettled(c));
  const settled = calls.filter((c) => isSettled(c));
  const [tab, setTab] = useState<Tab>(open.length || !settled.length ? "open" : "settled");
  const list = tab === "open" ? open : settled;
  const token = recordToken(record);

  return (
    <>
      <section className="wa-card wa-profile">
        <div className="wa-profile-top">
          <Avatar person={person} size={76} />
          <div className="wa-profile-names">
            {self ? <h2>{person.displayName}</h2> : <h1>{person.displayName}</h1>}
            <p>
              @{person.handle}
              {joined(person.joinedAt) ? ` · ${joined(person.joinedAt)}` : ""}
            </p>
          </div>
          {self ? (
            <button type="button" className="wa-iconbtn wa-iconbtn--surface" aria-label="Edit profile" onClick={onEdit}>
              <Icon name="edit" size={20} />
            </button>
          ) : (
            <FollowButton person={person} following={detail.viewerIsFollowing} />
          )}
        </div>
        {person.bio ? <p className="wa-bio">{person.bio}</p> : null}
        <div className="wa-stats">
          <div className="wa-stat">
            <strong>{compact(detail.followerCount)}</strong>
            <span>Followers</span>
          </div>
          <div className="wa-stat">
            <strong>{compact(detail.followingCount)}</strong>
            <span>Following</span>
          </div>
          <div className="wa-stat" aria-label={`Record: ${recordA11y(record)}`}>
            <strong aria-hidden style={{ color: token ? "var(--wa-yes-ink)" : undefined }}>
              {token ?? "—"}
            </strong>
            <span aria-hidden>
              <Icon name="check-solid" size={13} />
              Record
            </span>
          </div>
        </div>
      </section>

      {calls.length ? (
        <>
          <div style={{ margin: "18px 0 12px" }}>
            <Segmented
              options={[
                { id: "open", label: `Open ${open.length || ""}`.trim() },
                { id: "settled", label: `Settled ${settled.length || ""}`.trim() },
              ]}
              value={tab}
              onChange={setTab}
              label="Calls"
            />
          </div>
          {list.length ? (
            <ul className="wa-list">
              {list.map((e) => (
                <li key={e.call.id}>
                  <CallCard entry={e} showAuthor={false} />
                </li>
              ))}
            </ul>
          ) : (
            <StateScreen art={tab === "open" ? "empty_calls" : "record"} line={tab === "open" ? "No open calls" : "Nothing settled yet"} full={false} compact />
          )}
        </>
      ) : (
        <StateScreen
          art="empty_calls"
          line={self ? "Your calls show up here" : "No calls yet"}
          action={self ? { label: "Make a call", href: "/app/markets" } : undefined}
          full={false}
        />
      )}
    </>
  );
}

const PRESETS = [1, 2, 3, 4, 5];

function EditProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const viewer = useViewer();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const profile = me.data?.profile;
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarId, setAvatarId] = useState<number | null>(null);

  useEffect(() => {
    if (open && profile) {
      setName(profile.displayName ?? "");
      setBio(profile.bio ?? "");
      setAvatarId(profile.avatarId);
    }
  }, [open, profile]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        ...(name.trim() && name.trim() !== profile?.displayName ? { displayName: name.trim() } : {}),
        ...(bio !== (profile?.bio ?? "") ? { bio } : {}),
        ...(avatarId !== null && avatarId !== profile?.avatarId ? { avatarId } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(keys.me, res);
      void qc.invalidateQueries({ queryKey: ["person"] });
      void qc.invalidateQueries({ queryKey: ["feed"] });
      toast("Saved");
      onClose();
    },
    onError: (e) => toast(actionError(e), "error"),
  });
  const changed =
    !!profile &&
    ((name.trim() && name.trim() !== profile.displayName) || bio !== (profile.bio ?? "") || (avatarId !== null && avatarId !== profile.avatarId));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={save.isPending}
      title="Edit profile"
      footer={
        <button type="button" className="wa-btn wa-btn--primary wa-btn--block" disabled={!changed || save.isPending || bio.length > 280} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : null}
          Save
        </button>
      }
    >
      {profile ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="wa-field">
            <span className="wa-field-label" id="wa-avatar-label">
              Picture
            </span>
            <div className="wa-avatars" role="group" aria-labelledby="wa-avatar-label">
              {PRESETS.map((id) => (
                <button key={id} type="button" aria-pressed={avatarId === id} aria-label={`Picture ${id}`} onClick={() => setAvatarId(id)}>
                  <Avatar person={{ displayName: viewer.handle ?? "", avatarUrl: null, avatarId: id }} size={52} />
                </button>
              ))}
            </div>
          </div>
          <div className="wa-field">
            <label htmlFor="wa-edit-name">Name</label>
            <input id="wa-edit-name" className="wa-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="wa-field">
            <label htmlFor="wa-edit-bio">Bio</label>
            <textarea id="wa-edit-bio" value={bio} maxLength={300} onChange={(e) => setBio(e.target.value)} />
            <span className="wa-counter">{bio.length}/280</span>
          </div>
        </div>
      ) : me.isError ? (
        <p className="wa-hint wa-hint--error">Couldn’t load your profile. Try again.</p>
      ) : (
        <div style={{ display: "grid", placeItems: "center", minHeight: 120 }}>
          <Spinner />
        </div>
      )}
    </Sheet>
  );
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const wallet = useMe().data?.profile.walletAddress ?? null;
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <ul className="wa-menu">
        {wallet ? (
          <li>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(wallet);
                  toast("Wallet address copied");
                } catch {
                  // Nothing copied.
                }
              }}
            >
              <Icon name="wallet" size={20} />
              Wallet
              <span className="wa-menu-end">{shortWallet(wallet)}</span>
            </button>
          </li>
        ) : null}
        <li>
          <a href={GET_APP_HREF}>
            <Icon name="android-solid" size={20} />
            Get the Android app
            <span className="wa-menu-end">
              <Icon name="arrow-right" size={18} />
            </span>
          </a>
        </li>
        <li>
          <a href="/terms">
            <Icon name="document" size={20} />
            Terms of Use
          </a>
        </li>
        <li>
          <a href="/privacy">
            <Icon name="eye" size={20} />
            Privacy Policy
          </a>
        </li>
        <li>
          <a href="/delete-account">
            <Icon name="trash" size={20} />
            Delete account
          </a>
        </li>
        <li>
          <button type="button" onClick={() => void auth.signOut()} style={{ color: "var(--wa-pink-ink)" }}>
            <Icon name="logout" size={20} />
            Sign out
          </button>
        </li>
      </ul>
      <p className="wa-credit">
        Calls are free. Trades on Panta use real USDC and can lose money. Icons: Basil by Craftwork (CC BY 4.0).
      </p>
    </Sheet>
  );
}
