/**
 * https://chumbucket.fun/c/<id> — a shared call, as its receipt.
 *
 * The segment keeps its historical name: legacy Arena challenge links
 * (`chg_…` ids) live on the same path and still render the old challenge page.
 * Every other id is a call on the calls BFF, rendered server-side so the link
 * preview (OG image, title) and the page work with JavaScript off.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { CallReceipt } from "@/components/public/CallReceipt";
import OpenInApp from "@/components/public/OpenInApp";
import { PublicShell, Unavailable } from "@/components/public/PublicShell";
import { NotFound, callMark, entryPercent, getCall, sideLabel, type CallDetail } from "@/lib/callsBff";

type Params = { challengeId: string };

const isLegacyChallenge = (id: string) => id.startsWith("chg_");

async function load(id: string): Promise<CallDetail | "missing" | "unavailable"> {
  try {
    return await getCall(id);
  } catch (err) {
    return err instanceof NotFound ? "missing" : "unavailable";
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { challengeId } = await params;
  if (isLegacyChallenge(challengeId)) return { title: "A Chumbucket challenge" };
  const detail = await load(challengeId);
  if (typeof detail === "string") {
    return { title: "A call on Chumbucket", robots: { index: false } };
  }
  const { call, author, market } = detail.entry;
  const pct = entryPercent(call);
  const free = callMark(detail.entry) === "free";
  const title = `${author.displayName} called ${sideLabel(market, call.side)}${pct ? ` at ${pct}` : ""}${free ? " · Free" : ""}`;
  const description = `“${market.question}” — see the receipt, then back or fade it on Chumbucket.`;
  return {
    title: `${title} · Chumbucket`,
    description,
    alternates: { canonical: `/c/${call.id}` },
    openGraph: { title, description, type: "article", url: `/c/${call.id}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function CallPage({ params }: { params: Promise<Params> }) {
  const { challengeId } = await params;
  // next.config.ts rewrites chg_ links before they get here; this is the backstop.
  if (isLegacyChallenge(challengeId)) redirect(`/legacy-challenge/${encodeURIComponent(challengeId)}`);

  const detail = await load(challengeId);
  if (detail === "missing") notFound();
  return (
    <PublicShell>
      {detail === "unavailable" ? (
        <Unavailable what="call" href={`/c/${encodeURIComponent(challengeId)}`} />
      ) : (
        <section className="pub-wrap pub-narrow pub-stack">
          <p className="pub-eyebrow">On the record</p>
          <CallReceipt entry={detail.entry} />
          {detail.parent ? (
            <p className="pub-note">
              In response to{" "}
              <a className="pub-link" href={`/c/${encodeURIComponent(detail.parent.call.id)}`}>
                {detail.parent.author.displayName}&rsquo;s call
              </a>
              .
            </p>
          ) : null}
          <OpenInApp
            kind="c"
            id={detail.entry.call.id}
            label={`Think ${detail.entry.author.displayName} is wrong?`}
          />
        </section>
      )}
    </PublicShell>
  );
}
