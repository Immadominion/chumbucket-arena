/**
 * Frame for the public, shareable pages (/c, /u, /m): the site header and
 * footer (components/site), the page on a soft pink glow, nothing else.
 * Server component; no client JS of its own.
 */

import Link from "next/link";
import { DecorLayer, Glow, Sparkle, at } from "@/components/site/decor/Decor";
import { SiteShell } from "@/components/site/SiteShell";
import "./public.css";

/* eslint-disable @next/next/no-img-element */

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell>
      <div className="pub" data-section="share-page">
        <div className="cb-container pub-decor-anchor">
          <DecorLayer className="pub-decor">
            <Glow shape="pair" style={at(760, 40)} el="share.glow" />
            <Sparkle x={1000} y={10} size={64} el="share.sparkle-1" />
            <Sparkle x={-120} y={260} size={48} r={45} el="share.sparkle-2" />
          </DecorLayer>
        </div>
        {children}
      </div>
    </SiteShell>
  );
}

export function Avatar({ name, url, size = 48 }: { name: string; url: string | null; size?: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className="pub-avatar"
        style={{ width: size, height: size }}
        loading="lazy"
        decoding="async"
      />
    );
  }
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  return (
    <span aria-hidden className="pub-avatar pub-avatar-initials" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {letters || "?"}
    </span>
  );
}

export function SidePill({ side, label }: { side: "YES" | "NO"; label: string }) {
  return <span className={`pub-side pub-side-${side === "YES" ? "yes" : "no"}`}>{label}</span>;
}

/**
 * The one Free marker, as in the app: a ghost chip with the gift icon (Basil
 * present-outline), so a free call never reads as money.
 */
export function FreeMark() {
  return (
    <span className="pub-mark pub-mark-free" title="Free call">
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24">
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M6.25 5.5A3.25 3.25 0 0 1 12 3.423a3.25 3.25 0 0 1 5.24 3.827H18A2.75 2.75 0 0 1 20.75 10v2a1.75 1.75 0 0 1-1.281 1.687c.144 1.826.06 3.665-.25 5.473a2.46 2.46 0 0 1-2.15 2.028l-.915.102a37.4 37.4 0 0 1-8.309 0l-.914-.102a2.46 2.46 0 0 1-2.15-2.028a22 22 0 0 1-.25-5.473A1.75 1.75 0 0 1 3.25 12v-2A2.75 2.75 0 0 1 6 7.25h.76a3.24 3.24 0 0 1-.51-1.75m5 0a1.75 1.75 0 1 0-3.5 0a1.75 1.75 0 0 0 3.5 0m3.25 1.75a1.75 1.75 0 1 0 0-3.5a1.75 1.75 0 0 0 0 3.5M4.75 10c0-.69.56-1.25 1.25-1.25h5.25v3.5H5a.25.25 0 0 1-.25-.25zm8 3.75h5.219c.14 1.72.064 3.453-.228 5.156a.96.96 0 0 1-.839.791l-.914.103q-1.615.18-3.238.214zm0-1.5H19a.25.25 0 0 0 .25-.25v-2c0-.69-.56-1.25-1.25-1.25h-5.25zm-1.5 1.5v6.264a36 36 0 0 1-3.238-.214l-.914-.103a.96.96 0 0 1-.839-.79a20.6 20.6 0 0 1-.228-5.157z" />
      </svg>
      <span className="cb-visually-hidden">Free call</span>
      <span aria-hidden>Free</span>
    </span>
  );
}

/** Money in, solid pink: only for a fill Panta confirmed (Basil wallet-solid). */
/** A confirmed fill: "$5 on YES" when the amount is known, else "Funded". */
export function FundedMark({ label }: { label?: string | null }) {
  return (
    <span className="pub-mark pub-mark-funded" title="Funded on Panta">
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24">
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="m21.01 10.171l.003 3.623q-.039.518-.099 1.034a1.27 1.27 0 0 1-1.122 1.105c-1.84.206-3.744.206-5.584 0a1.27 1.27 0 0 1-1.122-1.105a24.3 24.3 0 0 1 0-5.656a1.27 1.27 0 0 1 1.122-1.105a25.4 25.4 0 0 1 5.584 0c.587.065 1.055.53 1.122 1.105q.058.499.096 1M17 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3" />
        <path fill="currentColor" d="M20.404 6.04c.155.269-.137.57-.446.536a27 27 0 0 0-5.916 0a2.77 2.77 0 0 0-2.446 2.422a26 26 0 0 0 0 6.004a2.77 2.77 0 0 0 2.446 2.422a27 27 0 0 0 5.916 0c.311-.035.606.269.449.54a4.97 4.97 0 0 1-3.78 2.45l-.652.068a44.7 44.7 0 0 1-9.956-.069l-.432-.051a3.93 3.93 0 0 1-3.432-3.384a37.6 37.6 0 0 1 0-9.956a3.93 3.93 0 0 1 3.432-3.384l.432-.051a44.7 44.7 0 0 1 9.956-.069l.652.069a4.96 4.96 0 0 1 3.777 2.453" />
      </svg>
      {label ?? "Funded"}
    </span>
  );
}

export function ExternalIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** The honest "couldn't load" state, with a way to try again. */
export function Unavailable({ what, href }: { what: string; href: string }) {
  return (
    <section className="pub-wrap pub-narrow">
      <div className="pub-card pub-state" role="status">
        <h1 className="pub-h2">We couldn&rsquo;t load this {what} right now</h1>
        <p>The Chumbucket service didn&rsquo;t answer in time. Nothing is wrong with the link.</p>
        <a className="pub-btn pub-btn-primary" href={href}>
          Try again
        </a>
      </div>
    </section>
  );
}

export function Missing({ what }: { what: string }) {
  return (
    <section className="pub-wrap pub-narrow">
      <div className="pub-card pub-state">
        <h1 className="pub-h2">This {what} isn&rsquo;t here</h1>
        <p>It may have been removed, or it&rsquo;s only visible to the people its author shares with.</p>
        <Link className="pub-btn pub-btn-primary" href="/">
          See what people are calling
        </Link>
      </div>
    </section>
  );
}
