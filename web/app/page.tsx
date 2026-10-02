/**
 * chumbucket.fun — the product as it is today: a people-first feed of calls
 * on real Panta prediction markets.
 *
 * Everything shown as activity is live from the public calls BFF (revalidated
 * every minute). When there is nothing to show, the page says so; it never
 * fills the gap with invented calls.
 *
 * The previous Arena landing (components/troof/*) is no longer routed; it is
 * left in place for the Arena web app's history.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { CallReceipt, CallRow } from "@/components/public/CallReceipt";
import { PublicShell } from "@/components/public/PublicShell";
import { getFeed, getOpenMarkets, maybe, whenLabel } from "@/lib/callsBff";

/* eslint-disable @next/next/no-img-element */

export const revalidate = 60;

const TITLE = "Chumbucket: see what people call on real prediction markets";
const DESCRIPTION =
  "Follow named people's calls on live Panta prediction markets. Back them, fade them, or challenge a friend, and keep a receipt nobody can edit.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", images: ["/img/logo-320.png"] },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

const INSTALL_URL = process.env.NEXT_PUBLIC_ANDROID_INSTALL_URL || null;

export default async function HomePage() {
  const [feed, markets] = await Promise.all([maybe(getFeed(7)), maybe(getOpenMarkets())]);
  const entries = feed?.entries ?? [];
  const [latest, ...rest] = entries;
  const open = (markets ?? []).filter((m) => m.status === "OPEN").slice(0, 6);

  return (
    <PublicShell>
      <section className="pub-wrap pub-hero" aria-labelledby="hero-title">
        <div>
          <p className="pub-eyebrow">Calls on real prediction markets</p>
          <h1 id="hero-title" className="pub-hero-title">
            See what people <em>call</em>. Back them or fade them.
          </h1>
          <p className="pub-hero-lede">
            Chumbucket is a feed of named people going on record on live Panta markets. Every call locks the price it was
            made at, and when the market resolves it becomes a receipt nobody can edit. Calls are free. Put money behind
            one only if you want to.
          </p>
          <div className="pub-hero-actions">
            <a className="pub-btn pub-btn-primary" href="#get">
              Get the Android app
            </a>
            <a className="pub-btn pub-btn-ghost" href="#live">
              See live calls
            </a>
          </div>
        </div>
        <div className="pub-hero-side">
          {latest ? (
            <>
              <p className="pub-eyebrow">Latest call</p>
              <CallReceipt entry={latest} headingLevel={2} />
            </>
          ) : (
            <div className="pub-hero-art">
              <img src="/img/logo-320.png" alt="" width={320} height={320} />
            </div>
          )}
        </div>
      </section>

      <section id="live" className="pub-wrap pub-section" aria-labelledby="live-title">
        <div className="pub-section-head">
          <div>
            <p className="pub-eyebrow">Right now</p>
            <h2 id="live-title" className="pub-section-title">
              Who&rsquo;s calling what
            </h2>
          </div>
        </div>
        {feed === null ? (
          <div className="pub-card pub-state" role="status">
            <p>Live calls can&rsquo;t be loaded right now. They&rsquo;re all still in the app.</p>
            <a className="pub-btn pub-btn-primary" href="/">
              Try again
            </a>
          </div>
        ) : rest.length === 0 ? (
          <div className="pub-card pub-state">
            <p>
              {latest
                ? "That's the only public call so far. Yours could be next."
                : "No public calls yet. Be the first one on record."}
            </p>
          </div>
        ) : (
          <ul className="pub-list">
            {rest.map((entry) => (
              <CallRow key={entry.call.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <section id="how" className="pub-wrap pub-section" aria-labelledby="how-title">
        <div className="pub-section-head">
          <div>
            <p className="pub-eyebrow">How it works</p>
            <h2 id="how-title" className="pub-section-title">
              People first. Receipts always.
            </h2>
          </div>
        </div>
        <div className="pub-grid pub-grid-3">
          <article className="pub-card pub-step">
            <span className="pub-step-n">01</span>
            <h3>Follow people, not tickers</h3>
            <p>See what the people you follow call on live markets, and how often they&rsquo;ve been right.</p>
          </article>
          <article className="pub-card pub-step">
            <span className="pub-step-n">02</span>
            <h3>Back, fade or challenge</h3>
            <p>Agree and back the call, take the other side, or dare a friend to go on record. All free.</p>
          </article>
          <article className="pub-card pub-step">
            <span className="pub-step-n">03</span>
            <h3>Keep the receipt</h3>
            <p>
              Each call locks who said it, which side, when and at what price. When the market resolves, the result
              comes from the venue, not from us.
            </p>
          </article>
        </div>
        <article className="pub-card pub-step pub-money" style={{ marginTop: 12 }}>
          <span className="pub-step-n">Optional</span>
          <h3>Put money behind a call</h3>
          <p>
            If you want skin in the game, take the position on Panta with USDC on Solana mainnet, approved in your own
            wallet. Chumbucket never holds your funds. This is real money: prices move and you can lose what you put
            in.
          </p>
        </article>
      </section>

      {open.length > 0 ? (
        <section className="pub-wrap pub-section" aria-labelledby="markets-title">
          <div className="pub-section-head">
            <div>
              <p className="pub-eyebrow">Open on Panta</p>
              <h2 id="markets-title" className="pub-section-title">
                Make a call before these close
              </h2>
            </div>
          </div>
          <ul className="pub-grid pub-grid-3 pub-list" style={{ display: "grid" }}>
            {open.map((m) => (
              <li key={m.id}>
                <Link href={`/m/${encodeURIComponent(m.id)}`} className="pub-card pub-market-tile">
                  <span className="pub-row-q">{m.question}</span>
                  <span className="pub-tile-meta">
                    <span>{m.category ? m.category.replace(/-/g, " ") : "Market"}</span>
                    <span>{m.closesAt ? `Closes ${whenLabel(m.closesAt)}` : ""}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section id="get" className="pub-wrap pub-section" aria-labelledby="get-title">
        <div className="pub-cta">
          <div className="pub-cta-copy">
            <p id="get-title" className="pub-cta-title">
              Chumbucket for Android
            </p>
            <p>Follow people, make your first call and share the receipt. Made for Solana phones like the Seeker.</p>
          </div>
          <div className="pub-cta-actions">
            {INSTALL_URL ? (
              <a className="pub-btn pub-btn-primary" href={INSTALL_URL} rel="noopener">
                Get the app
              </a>
            ) : (
              <div className="pub-cta-copy">
                <p>
                  Find <strong style={{ color: "#fff" }}>Chumbucket</strong> in the Solana dApp Store.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </PublicShell>
  );
}
