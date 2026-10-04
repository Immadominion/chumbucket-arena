"use client";

/**
 * Who is signed in, as the Android app decides it (`chumbucket_session.dart`):
 *
 *   Supabase session (wallet, Google or X)
 *        │  auth.whoami(token)        the BFF verifies the token itself
 *        ▼
 *   { userId, handle }               the canonical public.users.id
 *
 * An account is the way in, as on the phone: without one the web app shows
 * the sign-in screen, and a new account claims its @username first.
 *
 * The last confirmed identity is remembered per auth user, so a returning
 * visit opens straight into the app on its cached data while whoami confirms
 * it in the background. Only a refusal from the BFF signs someone out; a
 * slow or failed network never does.
 *
 * The access token never leaves this module except as the BFF's bearer
 * header and as the body of the identity mutations.
 */

import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { makeApi, type Api } from "@/lib/webapp/api";
import { bffCall, BffOffline, BffRejected, BffSignedOut } from "@/lib/webapp/bff";
import { identityCopy, nameHint, suggestUsername, WALLET_COPY, xUsernameHint } from "@/lib/webapp/identity";
import { clearCache } from "@/lib/webapp/cache";
import { safeReturnPath } from "@/lib/webapp/paths";
import { signInMessage } from "@/lib/webapp/siws";
import { accessToken, authClient } from "./authClient";
import { browserStorage } from "./data";
import { noteLinkReturn } from "./linking";
import { connect, signMessage, WalletDeclined, type StandardWallet } from "./wallets";

export type AuthStatus = "loading" | "signedOut" | "needsAccount" | "needsHandle" | "ready" | "offline";
export type SignInMethod = "wallet" | "google" | "x";

export interface Identity {
  authUserId: string;
  userId: string;
  handle: string | null;
}

export interface ProfileHints {
  name: string;
  username: string;
}

/** Why the first identity check could not finish: the network, or the BFF (with its line). */
export interface AuthFailure {
  offline: boolean;
  line: string;
}

interface AuthContextValue {
  status: AuthStatus;
  /** Set while `status` is "offline": what stopped the first identity check. */
  failure: AuthFailure | null;
  identity: Identity | null;
  hints: ProfileHints;
  error: string | null;
  busy: SignInMethod | "claim" | null;
  lastMethod: SignInMethod | null;
  api: Api;
  signInWithWallet(wallet: StandardWallet): Promise<void>;
  signInWithProvider(provider: "google" | "x"): Promise<void>;
  completeProfile(name: string, handle: string): Promise<string | null>;
  claimUsername(handle: string): Promise<string | null>;
  skipHandle(): void;
  signOut(): Promise<void>;
  retry(): void;
  clearError(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const IDENTITY_KEY = "cb.app.identity";
const LAST_METHOD_KEY = "cb.app.lastSignIn";
/** "Later" on Pick your @username: asked once per browser, as the app asks once per install. */
const handleLaterKey = (userId: string) => `cb.app.handleLater.${userId}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering is a convenience; the session still works.
  }
}

function cachedIdentity(authUserId: string): Identity | null {
  const id = readJson<Identity>(IDENTITY_KEY);
  return id && id.authUserId === authUserId && typeof id.userId === "string" ? id : null;
}

function hintsOf(session: Session | null): ProfileHints {
  const meta = (session?.user.user_metadata ?? {}) as Record<string, unknown>;
  const provider = (session?.user.app_metadata?.provider as string | undefined) ?? null;
  const name = nameHint(meta);
  return {
    name,
    username: suggestUsername({ xUsername: xUsernameHint(meta, provider), name, email: session?.user.email ?? null }),
  };
}

/** The BFF caller every screen uses: the session's token as the bearer. */
const authedCaller = async <T,>(path: string, input: unknown, kind: "query" | "mutation") =>
  bffCall<T>({ path, input, kind, token: await accessToken() });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [hints, setHints] = useState<ProfileHints>({ name: "", username: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SignInMethod | "claim" | null>(null);
  const [lastMethod, setLastMethod] = useState<SignInMethod | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const epoch = useRef(0);

  const api = useMemo(() => makeApi(authedCaller), []);

  const adopt = useCallback((next: Identity | null, nextStatus: AuthStatus) => {
    setIdentity(next);
    setStatus(nextStatus);
    if (next) writeJson(IDENTITY_KEY, next);
  }, []);

  /** Ask the BFF who this session is. `background`: we are already showing a cached identity. */
  const resolve = useCallback(
    async (session: Session, background: boolean) => {
      const mine = ++epoch.current;
      try {
        const who = await api.whoami(session.access_token);
        if (mine !== epoch.current) return;
        const prior = cachedIdentity(session.user.id);
        const handle = who.handle === undefined ? (prior?.handle ?? null) : who.handle;
        const next = { authUserId: session.user.id, userId: who.userId, handle };
        if (handle === null && !background && !readJson<boolean>(handleLaterKey(next.userId))) adopt(next, "needsHandle");
        else adopt(next, "ready");
      } catch (e) {
        if (mine !== epoch.current) return;
        if (e instanceof BffRejected && e.message === "AUTH_USER_UNLINKED") {
          writeJson(IDENTITY_KEY, null);
          setIdentity(null);
          setStatus("needsAccount");
          return;
        }
        if (e instanceof BffSignedOut) {
          writeJson(IDENTITY_KEY, null);
          await authClient().auth.signOut({ scope: "local" }).catch(() => undefined);
          setIdentity(null);
          setError(identityCopy("AUTH_TOKEN_INVALID"));
          setStatus("signedOut");
          return;
        }
        // Offline or the BFF failed: never a reason to sign anyone out. Say
        // which, truthfully: "offline" only when the request never completed.
        if (!background) {
          setFailure(
            e instanceof BffOffline
              ? { offline: true, line: "You’re offline" }
              : { offline: false, line: e instanceof BffRejected ? identityCopy(e.message) : "Couldn’t reach Chumbucket" },
          );
          setStatus("offline");
        }
      }
    },
    [api, adopt],
  );

  const onSession = useCallback(
    (session: Session | null) => {
      sessionRef.current = session;
      if (!session) {
        epoch.current++;
        setIdentity(null);
        setStatus("signedOut");
        return;
      }
      setHints(hintsOf(session));
      const cached = cachedIdentity(session.user.id);
      if (cached) {
        // Straight in on what we knew; whoami confirms it behind.
        adopt(cached, cached.handle === null && !readJson<boolean>(handleLaterKey(cached.userId)) ? "needsHandle" : "ready");
        void resolve(session, true);
      } else {
        setStatus("loading");
        void resolve(session, false);
      }
    },
    [adopt, resolve],
  );

  useEffect(() => {
    setLastMethod(readJson<SignInMethod>(LAST_METHOD_KEY));
    // An OAuth error comes back on the URL: say it once, then clean the URL.
    // Back from linking X or Google in Settings, Settings says what happened
    // (an identity already on another account is the start of a move).
    try {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.replace(/^#/, ""));
      const desc = url.searchParams.get("error_description") ?? params.get("error_description");
      const code = url.searchParams.get("error_code") ?? params.get("error_code");
      const linking = noteLinkReturn(desc ? (code ?? "cancelled") : null);
      if (desc) {
        if (!linking) setError("Sign-in was cancelled. Nothing changed.");
        for (const k of ["error", "error_code", "error_description"]) url.searchParams.delete(k);
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
    } catch {
      // Nothing to read.
    }
    const auth = authClient().auth;
    let alive = true;
    auth
      .getSession()
      .then(({ data }) => alive && onSession(data.session))
      .catch(() => alive && onSession(null));
    const { data } = auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === "TOKEN_REFRESHED") {
        sessionRef.current = session;
        return;
      }
      // Out of the callback: Supabase holds its auth lock while it runs, and
      // resolving the session reads the session again.
      setTimeout(() => {
        if (!alive) return;
        if (event === "SIGNED_IN" && session && session.user.id !== sessionRef.current?.user.id) onSession(session);
        else if (event === "SIGNED_OUT") onSession(null);
      }, 0);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [onSession]);

  const remember = (method: SignInMethod) => {
    setLastMethod(method);
    writeJson(LAST_METHOD_KEY, method);
  };

  const signInWithWallet = useCallback(
    async (wallet: StandardWallet) => {
      setError(null);
      setBusy("wallet");
      try {
        const account = await connect(wallet);
        const message = signInMessage({
          domain: window.location.host,
          uri: window.location.origin,
          address: account.address,
          issuedAt: new Date(),
        });
        const signature = await signMessage(wallet, account, new TextEncoder().encode(message));
        const { error: authError } = await authClient().auth.signInWithWeb3({ chain: "solana", message, signature });
        if (authError) {
          const code = (authError as { code?: string }).code ?? "";
          setError(
            code.includes("provider_disabled")
              ? WALLET_COPY.disabled
              : authError.status === 0 || authError.name === "AuthRetryableFetchError"
                ? WALLET_COPY.network
                : WALLET_COPY.refused,
          );
          return;
        }
        remember("wallet");
      } catch (e) {
        setError(e instanceof WalletDeclined ? WALLET_COPY.declined : WALLET_COPY.network);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const signInWithProvider = useCallback(async (provider: "google" | "x") => {
    setError(null);
    setBusy(provider);
    remember(provider);
    const here = `${window.location.origin}${safeReturnPath(window.location.pathname)}`;
    const { error: authError } = await authClient().auth.signInWithOAuth({ provider, options: { redirectTo: here } });
    // On success the browser is already leaving for the provider.
    if (authError) {
      setBusy(null);
      setError(identityCopy("NETWORK"));
    }
  }, []);

  const confirmAfterClaim = useCallback(async () => {
    const session = sessionRef.current;
    if (session) await resolve(session, false);
  }, [resolve]);

  const claimError = (e: unknown): string =>
    e instanceof BffOffline ? identityCopy("NETWORK") : e instanceof BffRejected ? identityCopy(e.message) : identityCopy("NETWORK");

  const completeProfile = useCallback(
    async (name: string, handle: string) => {
      // The freshest token: Supabase refreshes it on its own schedule.
      const token = (await accessToken()) ?? sessionRef.current?.access_token;
      if (!token) return identityCopy("AUTH_TOKEN_MISSING");
      setBusy("claim");
      try {
        await api.completeProfile(token, name.trim(), handle);
        await confirmAfterClaim();
        return null;
      } catch (e) {
        return claimError(e);
      } finally {
        setBusy(null);
      }
    },
    [api, confirmAfterClaim],
  );

  const claimUsername = useCallback(
    async (handle: string) => {
      // The freshest token: Supabase refreshes it on its own schedule.
      const token = (await accessToken()) ?? sessionRef.current?.access_token;
      if (!token) return identityCopy("AUTH_TOKEN_MISSING");
      setBusy("claim");
      try {
        const claimed = await api.claimUsername(token, handle);
        setIdentity((prev) => {
          const next = prev ? { ...prev, handle: claimed.handle } : prev;
          if (next) writeJson(IDENTITY_KEY, next);
          return next;
        });
        setStatus("ready");
        return null;
      } catch (e) {
        return claimError(e);
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  const skipHandle = useCallback(() => {
    if (identity) writeJson(handleLaterKey(identity.userId), true);
    setStatus("ready");
  }, [identity]);

  const signOut = useCallback(async () => {
    epoch.current++;
    // Nothing of this account stays in the browser after signing out.
    const saved = readJson<Identity>(IDENTITY_KEY);
    if (saved) clearCache(browserStorage(), saved.userId);
    writeJson(IDENTITY_KEY, null);
    await authClient().auth.signOut().catch(() => undefined);
    setIdentity(null);
    setStatus("signedOut");
  }, []);

  const retry = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      setStatus("loading");
      void resolve(session, false);
    } else setStatus("signedOut");
  }, [resolve]);

  const value: AuthContextValue = {
    status,
    failure,
    identity,
    hints,
    error,
    busy,
    lastMethod,
    api,
    signInWithWallet,
    signInWithProvider,
    completeProfile,
    claimUsername,
    skipHandle,
    signOut,
    retry,
    clearError: () => setError(null),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The signed-in viewer (only rendered inside the ready app). */
export function useViewer(): Identity {
  const { identity } = useAuth();
  if (!identity) throw new Error("useViewer before sign-in");
  return identity;
}

export function useApi(): Api {
  return useAuth().api;
}
