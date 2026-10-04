"use client";

/**
 * Open-in-app / install fallback for a shared link.
 *
 * With the app installed and Android App Links verified, tapping a
 * chumbucket.fun/c|u|m link opens the app directly and this page is never
 * seen. When it is seen, the person either has no app or verification has not
 * happened yet, so:
 *
 *  - Android: "Open in the app" is an intent:// URL on the app's own
 *    `chumbucket` scheme (registered in AndroidManifest.xml, no verification
 *    needed). If the app is missing, Chrome follows the fallback: the install
 *    page when NEXT_PUBLIC_ANDROID_INSTALL_URL is set, otherwise back to this
 *    page with ?app=missing so it can say so instead of failing silently.
 *  - Elsewhere: an honest note that Chumbucket is an Android app — or, once
 *    the deploy names a web app (NEXT_PUBLIC_WEB_APP_URL, e.g. "/app"),
 *    "Open in web app", which opens the same call, person or market there
 *    (the web app's paths mirror these: /app/c, /app/u, /app/m).
 */

import { useEffect, useState } from "react";
import { webAppHref } from "@/lib/webAppLink";

const PACKAGE = "dev.cleva.chumbucket";
const INSTALL_URL = process.env.NEXT_PUBLIC_ANDROID_INSTALL_URL || null;

type Kind = "c" | "u" | "m";

export default function OpenInApp({ kind, id, label }: { kind: Kind; id: string; label: string }) {
  const web = webAppHref(process.env.NEXT_PUBLIC_WEB_APP_URL || null, kind, id);
  const [platform, setPlatform] = useState<"android" | "other" | null>(null);
  const [missing, setMissing] = useState(false);
  const [intentUrl, setIntentUrl] = useState<string | null>(null);

  useEffect(() => {
    const android = /Android/i.test(navigator.userAgent);
    setPlatform(android ? "android" : "other");
    const here = new URL(window.location.href);
    setMissing(here.searchParams.get("app") === "missing");
    here.searchParams.set("app", "missing");
    const fallback = INSTALL_URL ?? here.toString();
    setIntentUrl(
      `intent://${kind}/${encodeURIComponent(id)}#Intent;scheme=chumbucket;package=${PACKAGE};` +
        `S.browser_fallback_url=${encodeURIComponent(fallback)};end`,
    );
  }, [kind, id]);

  return (
    <div className="pub-cta" id="get">
      <div className="pub-cta-copy">
        <p className="pub-cta-title">{label}</p>
        {missing && !INSTALL_URL ? (
          <p role="status">
            Chumbucket isn&rsquo;t installed on this phone. Search for <strong>Chumbucket</strong> in the Solana dApp
            Store.
          </p>
        ) : platform === "other" && !web ? (
          <p>Chumbucket is an Android app. Open this link on your Android phone to jump straight in.</p>
        ) : (
          <p>Back it, fade it, or dare a friend to call it. Calls are free.</p>
        )}
      </div>
      <div className="pub-cta-actions">
        {platform === "android" && intentUrl ? (
          <a className="pub-btn pub-btn-primary" href={intentUrl}>
            Open in the app
          </a>
        ) : null}
        {web && platform !== null ? (
          <a className={`pub-btn ${platform === "android" ? "pub-btn-ghost" : "pub-btn-primary"}`} href={web}>
            Open in web app
          </a>
        ) : null}
        {INSTALL_URL ? (
          <a className="pub-btn pub-btn-ghost" href={INSTALL_URL} rel="noopener">
            Get Chumbucket for Android
          </a>
        ) : platform === null ? (
          <span className="pub-btn pub-btn-primary pub-btn-placeholder" aria-hidden>
            Open in the app
          </span>
        ) : null}
      </div>
    </div>
  );
}
