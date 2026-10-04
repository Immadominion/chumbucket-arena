"use client";

/**
 * /app/link — where a proof window lands after X or Google (see linking.ts).
 *
 * It hands the asking window only what it needs — the attempt's nonce and
 * Supabase's one-time PKCE code (useless without the verifier in that
 * window's memory) — wipes both from the address bar, and closes. It never
 * starts this site's own auth client, so the session of the page that asked
 * is never touched, and it never forwards a token.
 */

import { useEffect, useState } from "react";
import { LINK_CHANNEL } from "@/lib/webapp/linking";

/* eslint-disable @next/next/no-img-element */

export function LinkCallback() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const nonce = url.searchParams.get("n");
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = url.searchParams.get("code");
    const error =
      url.searchParams.get("error_code") ?? hash.get("error_code") ?? url.searchParams.get("error") ?? hash.get("error");
    window.history.replaceState(null, "", url.pathname);
    if (nonce && typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(LINK_CHANNEL);
      channel.postMessage(code ? { n: nonce, code } : { n: nonce, error: error ?? "cancelled" });
      channel.close();
    }
    window.close();
    // A window the browser won't let a page close: say where to go.
    const t = window.setTimeout(() => setStuck(true), 800);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="wa-splash" aria-busy={!stuck}>
      {stuck ? (
        <p style={{ fontWeight: 600 }}>Done. Close this window.</p>
      ) : (
        <img src="/img/logo-192.png" alt="" width={64} height={64} />
      )}
    </div>
  );
}
