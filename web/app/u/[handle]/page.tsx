/**
 * https://chumbucket.fun/u/<handle> — a person's public record and calls.
 * `handle` may also be a canonical user id; never a wallet.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CallRow } from "@/components/public/CallReceipt";
import OpenInApp from "@/components/public/OpenInApp";
import { Avatar, PublicShell, Unavailable } from "@/components/public/PublicShell";
import { NotFound, avatarSrc, getPerson, recordLabel, type PersonDetail } from "@/lib/callsBff";

type Params = { handle: string };

async function load(ref: string): Promise<PersonDetail | "missing" | "unavailable"> {
  try {
    return await getPerson(decodeURIComponent(ref));
  } catch (err) {
    return err instanceof NotFound ? "missing" : "unavailable";
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { handle } = await params;
  const detail = await load(handle);
  if (typeof detail === "string") return { title: "Chumbucket", robots: { index: false } };
  const { person } = detail;
  const title = `${person.displayName} (@${person.handle}) on Chumbucket`;
  const description = `${recordLabel(person)}. See their calls on real prediction markets.`;
  return {
    title,
    description,
    alternates: { canonical: `/u/${person.handle}` },
    openGraph: { title, description, type: "profile", url: `/u/${person.handle}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PersonPage({ params }: { params: Promise<Params> }) {
  const { handle } = await params;
  const detail = await load(handle);
  if (detail === "missing") notFound();

  return (
    <PublicShell>
      {detail === "unavailable" ? (
        <Unavailable what="profile" href={`/u/${encodeURIComponent(handle)}`} />
      ) : (
        <section className="pub-wrap pub-narrow pub-stack">
          <div className="pub-card pub-profile">
            <Avatar name={detail.person.displayName} url={avatarSrc(detail.person)} size={72} />
            <div className="pub-profile-text">
              <h1 className="pub-h1">{detail.person.displayName}</h1>
              <p className="pub-muted">@{detail.person.handle}</p>
            </div>
            <dl className="pub-stats">
              <div>
                <dt>Settled</dt>
                <dd>{detail.person.settledCalls}</dd>
              </div>
              <div>
                <dt>Right</dt>
                <dd>{detail.person.correctCalls}</dd>
              </div>
              <div>
                <dt>Hit rate</dt>
                <dd>
                  {detail.person.settledCalls > 0
                    ? `${Math.round((detail.person.correctCalls / detail.person.settledCalls) * 100)}%`
                    : "–"}
                </dd>
              </div>
            </dl>
          </div>

          <h2 className="pub-h2">Calls</h2>
          {detail.calls.length === 0 ? (
            <div className="pub-card pub-state">
              <p>No public calls yet.</p>
            </div>
          ) : (
            <ul className="pub-list">
              {detail.calls.map((entry) => (
                <CallRow key={entry.call.id} entry={entry} showAuthor={false} />
              ))}
            </ul>
          )}

          <OpenInApp kind="u" id={detail.person.handle} label={`Follow ${detail.person.displayName}`} />
        </section>
      )}
    </PublicShell>
  );
}
