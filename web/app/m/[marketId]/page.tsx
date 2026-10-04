/**
 * https://chumbucket.fun/m/<marketId> — a market people are calling.
 *
 * Shows the question, the rules, the current Panta price and the deadline.
 * How the crowd called it is deliberately absent: the BFF only reveals the
 * split to someone who has made their own call, and a stranger has not.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OpenInApp from "@/components/public/OpenInApp";
import { ExternalIcon, PublicShell, Unavailable } from "@/components/public/PublicShell";
import {
  NotFound,
  priceLabel,
  priceUnit,
  getMarket,
  sideLabel,
  statusCopy,
  venueUrl,
  whenLabel,
  type MarketDetail,
} from "@/lib/callsBff";

type Params = { marketId: string };

async function load(id: string): Promise<MarketDetail | "missing" | "unavailable"> {
  try {
    return await getMarket(decodeURIComponent(id));
  } catch (err) {
    return err instanceof NotFound ? "missing" : "unavailable";
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { marketId } = await params;
  const detail = await load(marketId);
  if (typeof detail === "string") return { title: "Chumbucket", robots: { index: false } };
  const { market } = detail;
  const title = market.question;
  const description = `${statusCopy(market.status)} on Panta. Make your call on Chumbucket and keep the receipt.`;
  return {
    title: `${title} · Chumbucket`,
    description,
    alternates: { canonical: `/m/${market.id}` },
    openGraph: { title, description, url: `/m/${market.id}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function MarketPage({ params }: { params: Promise<Params> }) {
  const { marketId } = await params;
  const detail = await load(marketId);
  if (detail === "missing") notFound();

  return (
    <PublicShell>
      {detail === "unavailable" ? (
        <Unavailable what="market" href={`/m/${encodeURIComponent(marketId)}`} />
      ) : (
        <MarketBody detail={detail} />
      )}
    </PublicShell>
  );
}

function MarketBody({ detail }: { detail: MarketDetail }) {
  const { market, sharePrice } = detail;
  const yes = priceLabel(sharePrice?.yesPrice, sharePrice?.currency);
  const no = priceLabel(sharePrice?.noPrice, sharePrice?.currency);
  const venue = venueUrl(market);
  const open = market.status === "OPEN";
  const closes = whenLabel(market.closesAt);
  const priced = whenLabel(sharePrice?.observedAt);

  return (
    <section className="pub-wrap pub-narrow pub-stack">
      <p className="pub-eyebrow">{market.category ? market.category.replace(/-/g, " ") : "Market"}</p>
      <article className="pub-card pub-market" aria-labelledby="market-q">
        <div className="pub-market-head">
          <span className={`pub-status ${open ? "pub-status-open" : ""}`}>{statusCopy(market.status)}</span>
          {closes ? (
            <span className="pub-muted">
              {open ? "Closes" : "Closed"} {closes}
            </span>
          ) : null}
        </div>
        <h1 id="market-q" className="pub-question pub-question-lg">
          {market.question}
        </h1>

        <div className="pub-prices" role="group" aria-label="Current price per share">
          <div className="pub-price pub-price-yes">
            <span className="pub-price-label">{sideLabel(market, "YES")}</span>
            <span className="pub-price-value">{yes ?? "–"}</span>
          </div>
          <div className="pub-price pub-price-no">
            <span className="pub-price-label">{sideLabel(market, "NO")}</span>
            <span className="pub-price-value">{no ?? "–"}</span>
          </div>
        </div>
        <p className="pub-muted pub-small">
          {yes || no
            ? `Indicative price per share in ${priceUnit(sharePrice?.currency)} on Panta${priced ? `, as of ${priced}` : ""}.`
            : "No live price right now."}
        </p>

        {market.rulesText ? (
          <details className="pub-rules">
            <summary>How it resolves</summary>
            <p>{market.rulesText}</p>
          </details>
        ) : null}

        {venue ? (
          <a href={venue} rel="noopener" target="_blank" className="pub-link">
            View on Panta <ExternalIcon />
          </a>
        ) : null}
      </article>

      <OpenInApp
        kind="m"
        id={market.id}
        label={open ? "Make your call before it closes" : "See who called it"}
      />
    </section>
  );
}
