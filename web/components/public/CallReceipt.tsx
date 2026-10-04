/**
 * A call, as its receipt: who said what, when, at what percent, and what the
 * venue later decided. The same five facts the app's receipt card shows, the
 * Free mark on a free call, and never "free" on a funded one.
 */

import Link from "next/link";
import {
  avatarSrc,
  callMark,
  entryPercent,
  fundedLabel,
  outcomeCopy,
  recordLabel,
  sideLabel,
  venueUrl,
  whenLabel,
  type CallFeedEntry,
} from "@/lib/callsBff";
import { Avatar, ExternalIcon, FreeMark, FundedMark, SidePill } from "./PublicShell";

/** Free, funded ("$5 on YES" when the amount is known), or nothing for a state in between (see callMark). */
function CallMark({ entry }: { entry: CallFeedEntry }) {
  const mark = callMark(entry);
  const stamp = mark === "funded" ? fundedLabel(entry) : null;
  return mark === "free" ? <FreeMark /> : mark !== "funded" ? null : stamp ? <FundedMark label={stamp} /> : <FundedMark />;
}

export function CallReceipt({ entry, headingLevel = 1 }: { entry: CallFeedEntry; headingLevel?: 1 | 2 }) {
  const { call, author, market, result } = entry;
  const side = sideLabel(market, call.side);
  const pct = entryPercent(call);
  const outcome = outcomeCopy(result);
  const venue = venueUrl(market);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const resolvedAt = whenLabel(result?.resolvedAt);

  return (
    <article className="pub-card pub-receipt" aria-labelledby={`q-${call.id}`}>
      <header className="pub-receipt-head">
        <Link href={`/u/${encodeURIComponent(author.handle)}`} className="pub-person">
          <Avatar name={author.displayName} url={avatarSrc(author)} size={44} />
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
        {pct ? <span className="pub-receipt-at"> at {pct}</span> : null} <CallMark entry={entry} />
      </p>
      <Heading id={`q-${call.id}`} className="pub-question">
        <Link href={`/m/${encodeURIComponent(market.id)}`}>{market.question}</Link>
      </Heading>

      {call.thesis ? <blockquote className="pub-thesis">&ldquo;{call.thesis}&rdquo;</blockquote> : null}

      <dl className="pub-facts">
        <div>
          <dt>Called</dt>
          <dd>
            <time dateTime={new Date(call.lockedAt).toISOString()}>{whenLabel(call.lockedAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Called at</dt>
          <dd>{pct ? `${pct} ${side}` : "Not recorded"}</dd>
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
      </footer>
    </article>
  );
}

/** A compact row for lists (a person's calls, the home feed). */
export function CallRow({ entry, showAuthor = true }: { entry: CallFeedEntry; showAuthor?: boolean }) {
  const { call, author, market, result } = entry;
  const outcome = outcomeCopy(result);
  const pct = entryPercent(call);
  return (
    <li className="pub-row">
      <Link href={`/c/${encodeURIComponent(call.id)}`} className="pub-row-link">
        {showAuthor ? <Avatar name={author.displayName} url={avatarSrc(author)} size={36} /> : null}
        <span className="pub-row-body">
          <span className="pub-row-top">
            {showAuthor ? <span className="pub-row-name">{author.displayName}</span> : null}
            <span className="pub-row-called">
              called <SidePill side={call.side} label={sideLabel(market, call.side)} />
              {pct ? ` at ${pct}` : ""} <CallMark entry={entry} />
            </span>
          </span>
          <span className="pub-row-q">{market.question}</span>
        </span>
        <span className={`pub-outcome pub-outcome-${outcome.tone} pub-outcome-sm`}>{outcome.label}</span>
      </Link>
    </li>
  );
}
