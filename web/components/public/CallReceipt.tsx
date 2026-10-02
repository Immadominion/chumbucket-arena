/**
 * A call, as its receipt: who said what, when, at what price, and what the
 * venue later decided. The same five facts the app's receipt card shows, and
 * nothing that looks like money on a free call.
 */

import Link from "next/link";
import {
  entryLabel,
  outcomeCopy,
  recordLabel,
  safeAvatar,
  sideLabel,
  venueUrl,
  whenLabel,
  type CallFeedEntry,
} from "@/lib/callsBff";
import { Avatar, ExternalIcon, SidePill } from "./PublicShell";

export function CallReceipt({ entry, headingLevel = 1 }: { entry: CallFeedEntry; headingLevel?: 1 | 2 }) {
  const { call, author, market, result } = entry;
  const side = sideLabel(market, call.side);
  const entryPrice = entryLabel(call);
  const outcome = outcomeCopy(result);
  const venue = venueUrl(market);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const resolvedAt = whenLabel(result?.resolvedAt);

  return (
    <article className="pub-card pub-receipt" aria-labelledby={`q-${call.id}`}>
      <header className="pub-receipt-head">
        <Link href={`/u/${encodeURIComponent(author.handle)}`} className="pub-person">
          <Avatar name={author.displayName} url={safeAvatar(author.avatarUrl)} size={44} />
          <span className="pub-person-text">
            <span className="pub-person-name">{author.displayName}</span>
            <span className="pub-person-meta">
              @{author.handle} · {recordLabel(author)}
            </span>
          </span>
        </Link>
        <span className={`pub-outcome pub-outcome-${outcome.tone}`}>{outcome.label}</span>
      </header>

      <p className="pub-receipt-says">
        called <SidePill side={call.side} label={side} />
        {entryPrice ? <span className="pub-receipt-at"> at {entryPrice}</span> : null}
      </p>
      <Heading id={`q-${call.id}`} className="pub-question">
        <Link href={`/m/${encodeURIComponent(market.id)}`}>{market.question}</Link>
      </Heading>

      {call.thesis ? <blockquote className="pub-thesis">&ldquo;{call.thesis}&rdquo;</blockquote> : null}

      <dl className="pub-facts">
        <div>
          <dt>Locked</dt>
          <dd>
            <time dateTime={new Date(call.lockedAt).toISOString()}>{whenLabel(call.lockedAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Entry price</dt>
          <dd>{entryPrice ? `${entryPrice} per ${side} share` : "Not recorded"}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>
            {result && result.outcome !== "PENDING" && result.resolution
              ? `Resolved ${result.resolution === "VOID" ? "void" : sideLabel(market, result.resolution)}${resolvedAt ? ` · ${resolvedAt}` : ""}`
              : "Not resolved yet"}
          </dd>
        </div>
        <div>
          <dt>Resolved by</dt>
          <dd>
            {venue ? (
              <a href={venue} rel="noopener" target="_blank" className="pub-link">
                Panta <ExternalIcon />
              </a>
            ) : (
              "The venue"
            )}
          </dd>
        </div>
      </dl>

      <footer className="pub-receipt-foot">
        <span>
          <strong>{entry.backCount}</strong> backed · <strong>{entry.fadeCount}</strong> faded
        </span>
        <span className="pub-receipt-free">Free call · no money at stake</span>
      </footer>
    </article>
  );
}

/** A compact row for lists (a person's calls, the home feed). */
export function CallRow({ entry, showAuthor = true }: { entry: CallFeedEntry; showAuthor?: boolean }) {
  const { call, author, market, result } = entry;
  const outcome = outcomeCopy(result);
  const entryPrice = entryLabel(call);
  return (
    <li className="pub-row">
      <Link href={`/c/${encodeURIComponent(call.id)}`} className="pub-row-link">
        {showAuthor ? <Avatar name={author.displayName} url={safeAvatar(author.avatarUrl)} size={36} /> : null}
        <span className="pub-row-body">
          <span className="pub-row-top">
            {showAuthor ? <span className="pub-row-name">{author.displayName}</span> : null}
            <span className="pub-row-called">
              called <SidePill side={call.side} label={sideLabel(market, call.side)} />
              {entryPrice ? ` at ${entryPrice}` : ""}
            </span>
          </span>
          <span className="pub-row-q">{market.question}</span>
        </span>
        <span className={`pub-outcome pub-outcome-${outcome.tone} pub-outcome-sm`}>{outcome.label}</span>
      </Link>
    </li>
  );
}
