"use client";

/**
 * Linking sign-ins, in the browser.
 *
 *   linkProviderHere   X or Google onto the account you are in: Supabase's own
 *                      manual identity linking (a full redirect, back to
 *                      /app/me). Needs "Allow manual linking" in Supabase Auth.
 *   linkWalletHere     a browser wallet: the BFF's SIWS challenge, signed, and
 *                      auth.linkWallet. A message, never a transaction.
 *   proveWithProvider  the OTHER side of a link Supabase can't make (the X or
 *   proveWithWallet    Google is already on another sign-in; the wallet already
 *                      signs in somewhere): a sign-in made only to prove it, in
 *                      a separate in-memory client (and, for X/Google, a
 *                      separate window). This page's own session never changes,
 *                      and the proof's token is released when done.
 *
 * The proof window answers on a BroadcastChannel, not window.opener: a
 * provider's Cross-Origin-Opener-Policy can sever the opener on the way back.
 * Only the access token crosses; the refresh token is dropped where it lands.
 */

import { createClient, type SupabaseClient, type UserIdentity } from "@supabase/supabase-js";
import bs58 from "bs58";
import type { Api } from "@/lib/webapp/api";
import { LINK_CALLBACK_PATH, LINK_CHANNEL, LINKING_KEY } from "@/lib/webapp/linking";
import { signInMessage } from "@/lib/webapp/siws";
import { authClient } from "./authClient";
import { connect, signMessage, WalletDeclined, type StandardWallet } from "./wallets";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Where a link stopped: a BFF/Supabase code, "cancelled", "popup" or "network". */
export class LinkStopped extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LinkStopped";
  }
}

const LINK_RETURN_KEY = "cb.app.linkReturn";

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** A client for one proof: nothing stored, nothing refreshed, never this page's session. */
function proofClient(): SupabaseClient {
  return createClient(SUPABASE_URL || "https://unconfigured.invalid", SUPABASE_KEY || "unconfigured", {
    auth: {
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "cb.web.link",
    },
  });
}

// ── X / Google onto this account (Supabase manual linking) ───────────────────

export async function linkProviderHere(provider: "x" | "google"): Promise<void> {
  session()?.setItem(LINKING_KEY, provider);
  const redirectTo = `${window.location.origin}/app/me?signin=${provider}`;
  const { error } = await authClient().auth.linkIdentity({ provider, options: { redirectTo } });
  // On success the browser is already leaving for the provider.
  if (error) {
    session()?.removeItem(LINKING_KEY);
    throw new LinkStopped((error as { code?: string }).code ?? "network");
  }
}

/**
 * Called once at load by the session (it reads the URL first): what came back
 * from a linkIdentity round trip, if one was under way.
 */
export function noteLinkReturn(errorCode: string | null, returned: boolean): boolean {
  const store = session();
  const method = store?.getItem(LINKING_KEY);
  if (!store || !method) return false;
  store.removeItem(LINKING_KEY);
  // Left at the provider and came back some other way: nothing to report.
  if (!returned && !errorCode) return false;
  store.setItem(LINK_RETURN_KEY, JSON.stringify({ method, error: errorCode }));
  return true;
}

/** Settings reads it once: which method came back, and whether Supabase refused it. */
export function takeLinkReturn(): { method: "x" | "google"; error: string | null } | null {
  const store = session();
  const raw = store?.getItem(LINK_RETURN_KEY);
  if (!store || !raw) return null;
  store.removeItem(LINK_RETURN_KEY);
  try {
    const v = JSON.parse(raw) as { method?: unknown; error?: unknown };
    if (v.method !== "x" && v.method !== "google") return null;
    return { method: v.method, error: typeof v.error === "string" ? v.error : null };
  } catch {
    return null;
  }
}

// ── a wallet onto this account (SIWS proof) ──────────────────────────────────

export async function linkWalletHere(api: Api, token: string, wallet: StandardWallet): Promise<void> {
  const account = await connect(wallet);
  const challenge = await api.requestWalletNonce(token, account.address, window.location.host, window.location.origin);
  const signature = await signMessage(wallet, account, new TextEncoder().encode(challenge.message));
  await api.linkWallet(token, account.address, challenge.message, bs58.encode(signature));
}

// ── the other side's proof ───────────────────────────────────────────────────

/** Open the proof window inside the click, before anything awaits (or it is a blocked pop-up). */
export function openProofWindow(): Window | null {
  try {
    return window.open("", "cb-sign-in-link", "popup,width=480,height=720");
  } catch {
    return null;
  }
}

export async function proveWithProvider(
  provider: "x" | "google",
  popup: Window,
  signal: AbortSignal,
): Promise<string> {
  const nonce = crypto.randomUUID();
  const redirectTo = `${window.location.origin}${LINK_CALLBACK_PATH}?n=${nonce}`;
  const { data, error } = await proofClient().auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data?.url) {
    popup.close();
    throw new LinkStopped("network");
  }
  popup.location.href = data.url;
  return new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(LINK_CHANNEL);
    const timer = window.setTimeout(() => done(new LinkStopped("cancelled")), 5 * 60_000);
    const onAbort = () => {
      try {
        popup.close();
      } catch {
        // Already gone.
      }
      done(new LinkStopped("cancelled"));
    };
    function done(result: string | LinkStopped) {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      channel.close();
      if (typeof result === "string") resolve(result);
      else reject(result);
    }
    signal.addEventListener("abort", onAbort);
    channel.onmessage = (event: MessageEvent) => {
      const d = event.data as { n?: unknown; accessToken?: unknown; error?: unknown } | null;
      if (!d || d.n !== nonce) return;
      if (typeof d.accessToken === "string" && d.accessToken) done(d.accessToken);
      else done(new LinkStopped(typeof d.error === "string" && d.error ? d.error : "cancelled"));
    };
  });
}

export async function proveWithWallet(wallet: StandardWallet): Promise<string> {
  let message: string;
  let signature: Uint8Array;
  try {
    const account = await connect(wallet);
    message = signInMessage({
      domain: window.location.host,
      uri: window.location.origin,
      address: account.address,
      issuedAt: new Date(),
    });
    signature = await signMessage(wallet, account, new TextEncoder().encode(message));
  } catch (e) {
    throw new LinkStopped(e instanceof WalletDeclined ? "cancelled" : "network");
  }
  const { data, error } = await proofClient().auth.signInWithWeb3({ chain: "solana", message, signature });
  const token = data?.session?.access_token;
  if (error || !token) throw new LinkStopped("network");
  return token;
}

/** End a proof's session at Supabase. Best effort: it also simply expires. */
export function releaseProof(token: string | null): void {
  if (!token || !SUPABASE_URL) return;
  void fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

// ── unlink on this session's own sign-in (Supabase) ─────────────────────────

export async function unlinkHere(identityId: string): Promise<void> {
  const auth = authClient().auth;
  const { error } = await auth.unlinkIdentity({ identity_id: identityId } as UserIdentity);
  if (error) throw new LinkStopped((error as { code?: string }).code ?? "network");
  await auth.refreshSession().catch(() => undefined);
}
