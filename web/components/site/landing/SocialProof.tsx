/**
 * Social proof ("from people calling it"). Where the Figma page had invented
 * testimonials, this shows a real public call from the calls feed: the
 * market, who called which side at what price, and how Panta settled it,
 * with the people behind recent calls. Rendered on the server and refreshed
 * every minute; honest empty and failure states otherwise.
 */

import Image from "next/image";
import { initials, safeAvatar, type Person } from "@/lib/callsBff";
import { callSentence, statusLine, type ProofState } from "@/lib/landingProof";
import { GET_APP_HREF } from "../config";
import { DecorLayer, Glow, Orbit, Sparkle, at } from "../decor/Decor";
import { QuoteIcon } from "../icons";

/** The five circles in the illustration: centre, then the four around it. */
const CIRCLES = [
  { id: "centre", x: 122.483, y: 120.236, d: 213.503 },
  { id: "top-right", x: 329.244, y: 0, d: 110.122 },
  { id: "bottom-right", x: 346.099, y: 340.48, d: 76.411 },
  { id: "top-left", x: 3.371, y: 0, d: 87.648 },
  { id: "bottom-left", x: 0, y: 318.007, d: 93.267 },
];

function Face({ person, size }: { person: Person | undefined; size: number }) {
  const src = person ? safeAvatar(person.avatarUrl) : null;
  if (!src) return null;
  return <Image src={src} alt="" fill sizes={`${Math.ceil(size)}px`} unoptimized />;
}

function Avatar({ person, lead }: { person: Person; lead: boolean }) {
  const src = safeAvatar(person.avatarUrl);
  return (
    <a
      href={`/u/${encodeURIComponent(person.handle)}`}
      className={`cb-proof__person${lead ? " cb-proof__person--lead" : ""}`}
      data-el="proof.person"
    >
      {src ? (
        <Image src={src} alt="" fill sizes="40px" unoptimized />
      ) : (
        <span aria-hidden="true">{initials(person.displayName)}</span>
      )}
      <span className="cb-visually-hidden">
        {person.displayName} (@{person.handle})
      </span>
    </a>
  );
}

export function SocialProof({ state }: { state: ProofState }) {
  const people = state.kind === "call" ? state.people : [];
  const status = state.kind === "call" ? statusLine(state.featured) : null;
  return (
    <section id="live" className="cb-proof" data-section="social-proof" aria-labelledby="proof-title">
      <div className="cb-container cb-proof__inner">
        <DecorLayer>
          <Sparkle x={-151.059} y={734} size={48} r={45} el="proof.sparkle" />
        </DecorLayer>

        <header className="cb-proof__head">
          <p className="cb-eyebrow cb-eyebrow--ink" data-el="proof.eyebrow">
            on record
          </p>
          <h2 id="proof-title" className="cb-h2 cb-proof__title" data-el="proof.title">
            from people calling it
          </h2>
        </header>

        <div className="cb-proof__art" data-el="proof.art" aria-hidden="true">
          <Glow shape="pair" style={at(117, 249)} el="proof.glow" />
          <Orbit shape="proof" style={at(0, 0)} el="proof.orbit" />
          <div className="cb-proof__circles cb-at" style={at(126.43, 138.79, { w: 439.366 })}>
            {CIRCLES.map((c, i) => (
              <span key={c.id} className="cb-proof__circle cb-at" style={at(c.x, c.y, { w: c.d })} data-el={`proof.circle.${c.id}`}>
                <Face person={people[i]} size={c.d} />
              </span>
            ))}
            <span className="cb-proof__quote cb-at" style={at(295.533, 187.658, { w: 79.783 })} data-el="proof.quote-badge">
              <QuoteIcon />
            </span>
          </div>
        </div>

        <div className="cb-proof__call" data-el="proof.call">
          {state.kind === "call" && status ? (
            <>
              <p className="cb-proof__question" data-el="proof.question">
                <a href={`/m/${encodeURIComponent(state.featured.market.id)}`}>{state.featured.market.question}</a>
              </p>
              <p className="cb-proof__text" data-el="proof.text">
                {callSentence(state.featured)}
              </p>
              <ul className="cb-proof__people" aria-label="People behind recent public calls" data-el="proof.people">
                {state.people.map((p, i) => (
                  <li key={p.id}>
                    <Avatar person={p} lead={i === 0} />
                  </li>
                ))}
              </ul>
              <p className="cb-proof__status" data-el="proof.status">
                <strong>{status.label}</strong>
                <a className="cb-proof__link" href={status.href}>
                  {status.linkText}
                </a>
              </p>
            </>
          ) : state.kind === "empty" ? (
            <>
              <p className="cb-proof__question">No public calls yet.</p>
              <p className="cb-proof__text">
                Public calls show up here as people make them: who called it, which side, the price they locked and how
                Panta settled it.
              </p>
              <p className="cb-proof__status">
                <strong>Be the first on record</strong>
                <a className="cb-proof__link" href={GET_APP_HREF}>
                  Get the app
                </a>
              </p>
            </>
          ) : (
            <>
              <p className="cb-proof__question">Live calls can’t load right now.</p>
              <p className="cb-proof__text" role="status">
                The Chumbucket service didn’t answer in time. Every call is still in the app.
              </p>
              <p className="cb-proof__status">
                <strong>Nothing is lost</strong>
                <a className="cb-proof__link" href="/#live">
                  Try again
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
