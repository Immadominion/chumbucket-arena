"use client";

/**
 * Data that stays put. One React Query cache per account, saved to the
 * browser as answers arrive and restored before the first frame of the next
 * visit, so every screen opens on what it showed last time and refreshes
 * quietly: on focus, on reconnect, and on a slow interval while visible.
 * No screen shows how old its data is, and none has a refresh button.
 */

import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
  type DehydratedState,
} from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BffRejected, BffSignedOut } from "@/lib/webapp/bff";
import { CACHE_MAX_AGE_MS, clearCache, loadCache, saveCache, type KeyValueStorage } from "@/lib/webapp/cache";

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Kept as long as the saved cache, so restored answers are not dropped.
        gcTime: CACHE_MAX_AGE_MS,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // A refusal will not change on retry; a network blip might.
        retry: (count, error) => !(error instanceof BffSignedOut || error instanceof BffRejected) && count < 2,
      },
    },
  });
}

/** Restore the account's cache before rendering, then keep saving it. */
export function DataProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [client] = useState(makeClient);
  const restoredFor = useRef<string | null>(null);
  if (restoredFor.current !== userId) {
    client.clear();
    const saved = loadCache(browserStorage(), userId, Date.now());
    if (saved) {
      try {
        hydrate(client, saved as DehydratedState);
      } catch {
        clearCache(browserStorage(), userId);
      }
    }
    restoredFor.current = userId;
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      timer = null;
      saveCache(
        browserStorage(),
        userId,
        dehydrate(client, { shouldDehydrateQuery: (q) => q.state.status === "success" }),
        Date.now(),
      );
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || timer) return;
      timer = setTimeout(save, 1500);
    });
    const flush = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", flush);
      if (timer) clearTimeout(timer);
    };
  }, [client, userId]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export { useQueryClient };

// ── toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => undefined);

/** One short line that confirms an action or says why it failed, then leaves. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = ++next.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="wa-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`wa-toast wa-toast--${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** The line a failed action shows: the BFF's own words for a refusal, a plain one otherwise. */
export function actionError(e: unknown): string {
  if (e instanceof BffRejected) return e.message;
  if (e instanceof BffSignedOut) return "Sign in again to do that.";
  return "Couldn’t reach Chumbucket. Try again.";
}

/** Ticks once a minute, so countdowns ("5h") stay true without a reload. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
