/**
 * Frame for the public, shareable pages (/, /c, /u, /m): a slim header, the
 * page, and a footer that says plainly what the product is and is not.
 * Server component; no client JS of its own.
 */

import Link from "next/link";
import "./public.css";

/* eslint-disable @next/next/no-img-element */

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pub">
      <a href="#main" className="pub-skip">
        Skip to content
      </a>
      <header className="pub-header">
        <div className="pub-wrap pub-header-row">
          <Link href="/" className="pub-brand" aria-label="Chumbucket home">
            <img src="/img/logo-192.png" alt="" width={36} height={36} />
            <span>Chumbucket</span>
          </Link>
          <nav aria-label="Primary" className="pub-nav">
            <Link href="/#how">How it works</Link>
            <Link href="/#get" className="pub-nav-cta">
              Get the app
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" className="pub-main">
        {children}
      </main>
      <footer className="pub-footer">
        <div className="pub-wrap">
          <p>
            Calls on Chumbucket are free and carry no money. A funded position is a real trade on{" "}
            <a href="https://panta.market" rel="noopener" target="_blank">
              Panta
            </a>
            , paid in USDC on Solana mainnet from your own wallet. Prices move, and you can lose what you put in.
          </p>
          <p className="pub-footer-meta">
            <span>© {new Date().getUTCFullYear()} Cleva Labs</span>
            <span>Markets and prices by Panta. Check that prediction markets are legal where you live before you trade.</span>
          </p>
        </div>
      </footer>
    </div>
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
