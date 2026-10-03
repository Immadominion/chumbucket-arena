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
