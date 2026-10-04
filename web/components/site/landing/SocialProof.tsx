/**
 * Social proof ("See who’s calling it"). Where the Figma page had invented
 * testimonials, this shows real Chumbucket people and a real public call:
 *
 * - The circles are the top callers from the public BFF (people.leaderboard,
 *   then people.suggested and recent public calls; lib/landingPeople.ts),
 *   each with the picture the app shows for them (their X or Google photo,
 *   else the preset they picked, else initials) and a link to /u/<handle>.
 *   With fewer people than circles the rest stay open seats, and the line
 *   under the title says how many there really are.
 * - The card is the newest settled public call: the market, who called
 *   which side at what price, and how Panta settled it.
 *
 * Rendered on the server and refreshed every minute; honest empty and
 * failure states otherwise. Motion (landing-motion.css, "Social proof"):
 * the circles pop in one after another, the call card leans toward the
 * pointer (MotionRoot's `data-tilt`) and glows.
 */

import Image from "next/image";
import { avatarSrc, initials, type Person } from "@/lib/callsBff";
import { callerRecord, callersLine, type Caller } from "@/lib/landingPeople";
import { callSentence, statusLine, type ProofState } from "@/lib/landingProof";
import { GET_APP_HREF } from "../config";
import { DecorLayer, Glow, Orbit, Sparkle, at } from "../decor/Decor";
import { QuoteIcon } from "../icons";

/** The five circles in the illustration, in the order people fill them: biggest first. */
const SEATS = [
  { id: "centre", x: 122.483, y: 120.236, d: 213.503 },
  { id: "top-right", x: 329.244, y: 0, d: 110.122 },
  { id: "bottom-left", x: 0, y: 318.007, d: 93.267 },
  { id: "top-left", x: 3.371, y: 0, d: 87.648 },
  { id: "bottom-right", x: 346.099, y: 340.48, d: 76.411 },
];

function Face({ src, name, size }: { src: string | null; name: string; size: number }) {
  if (!src) return <span className="cb-proof__initials">{initials(name)}</span>;
  // Remote photos (X, Google) skip the optimizer, which has no remote hosts
  // configured; the app's preset pictures are local and get resized.
  return <Image src={src} alt="" fill sizes={`${Math.ceil(size)}px`} unoptimized={src.startsWith("https://")} />;
}

/** The app's own preset avatars (the cartoon faces people pick in the app). */
const PRESETS = [1, 2, 3, 4, 5];

function Seats({ callers }: { callers: Caller[] }) {
  // Open seats wear the app's preset avatar art, never a real person's
  // photo, with a plus badge: room for someone. Art a real caller already
  // uses is skipped so the two never read as the same person.
  const used = new Set(
    callers.map((c) => Number(/^\/img\/profile\/(\d)\.png$/.exec(c.avatar ?? "")?.[1] ?? NaN)).filter((n) => !Number.isNaN(n)),
  );
  const art = [...PRESETS.filter((n) => !used.has(n)), ...PRESETS.filter((n) => used.has(n))];
  return (
    <>
      {/* Seats nobody is in yet: decoration only. */}
      <span className="cb-proof__open" aria-hidden="true">
        {SEATS.slice(callers.length).map((s, i) => (
          <span
            key={s.id}
            className="cb-proof__seat cb-at cb-proof__seat--open cb-proof__seat--art"
            style={{ ...at(s.x, s.y, { w: s.d }), ["--i" as string]: callers.length + i }}
            data-el={`proof.circle.${s.id}`}
          >
            <Image src={`/img/profile/${art[i % art.length]}.png`} alt="" fill sizes={`${Math.ceil(s.d)}px`} />
            <span className="cb-proof__plus" />
          </span>
        ))}
      </span>
      {callers.length ? (
        <ul className="cb-proof__people-art" aria-label="People calling it on Chumbucket">
          {callers.map((c, i) => {
            const s = SEATS[i]!;
            return (
              <li
                key={c.id}
                className={`cb-proof__seat cb-proof__seat--person cb-at${i === 0 ? " cb-proof__seat--lead" : ""}`}
                style={{ ...at(s.x, s.y, { w: s.d }), ["--i" as string]: i }}
                data-el={`proof.circle.${s.id}`}
              >
                <a className="cb-proof__face" href={`/u/${encodeURIComponent(c.handle)}`}>
                  <Face src={c.avatar} name={c.displayName} size={s.d} />
                  <span className="cb-visually-hidden">
                    {c.displayName} (@{c.handle}), {callerRecord(c).toLowerCase()}
                  </span>
                </a>
                <span className="cb-proof__tag" aria-hidden="true">
                  @{c.handle}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

function Avatar({ person, lead }: { person: Person; lead: boolean }) {
  const src = avatarSrc(person);
  return (
    <a
      href={`/u/${encodeURIComponent(person.handle)}`}
      className={`cb-proof__person${lead ? " cb-proof__person--lead" : ""}`}
      data-el="proof.person"
    >
      <span className="cb-proof__person-face" aria-hidden="true">
        {src ? <Image src={src} alt="" fill sizes="40px" unoptimized={src.startsWith("https://")} /> : initials(person.displayName)}
      </span>
      <span className="cb-visually-hidden">
        {person.displayName} (@{person.handle})
      </span>
    </a>
  );
}

export function SocialProof({ state, callers }: { state: ProofState; callers: Caller[] }) {
  const status = state.kind === "call" ? statusLine(state.featured) : null;
  const line = callersLine(callers);
  return (
    <section id="live" className="cb-proof" data-section="social-proof" aria-labelledby="proof-title">
      <div className="cb-container cb-proof__inner">
        <DecorLayer>
          <Sparkle x={-151.059} y={734} size={48} r={45} el="proof.sparkle" />
        </DecorLayer>

        <header className="cb-proof__head" data-reveal="">
          <p className="cb-eyebrow cb-eyebrow--ink" data-el="proof.eyebrow">
            on record
          </p>
          <h2 id="proof-title" className="cb-h2 cb-proof__title" data-el="proof.title">
            See who’s calling it
          </h2>
          {line ? (
            <p className="cb-proof__callers" data-el="proof.callers-line">
              {line}
            </p>
          ) : null}
        </header>

        <div className="cb-proof__art" data-el="proof.art" data-reveal="stage">
          <div className="cb-proof__art-decor" aria-hidden="true">
            <Glow shape="pair" style={at(117, 249)} el="proof.glow" />
            <Orbit shape="proof" style={at(0, 0)} el="proof.orbit" />
          </div>
          <div className="cb-proof__circles cb-at" style={at(126.43, 138.79, { w: 439.366 })}>
            <Seats callers={callers} />
            <span className="cb-proof__quote cb-at" style={at(295.533, 187.658, { w: 79.783 })} data-el="proof.quote-badge" aria-hidden="true">
              <QuoteIcon />
            </span>
          </div>
        </div>

        <div className="cb-proof__call" data-el="proof.call" data-reveal="" data-tilt="">
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
