/**
 * Hero: the headline, the lead, the two actions, the ribbon illustration
 * and the fanned-out phones.
 */

import { GET_APP_HREF } from "../config";
import { DecorLayer, Glow, Orbit, Phone, Sparkle, at } from "../decor/Decor";
import { ArrowIcon, PlayIcon } from "../icons";
import { HeroRibbon } from "./HeroRibbon";

export function Hero({ proofLink }: { proofLink: { href: string; label: string } }) {
  return (
    <section className="cb-hero" data-section="hero" aria-labelledby="hero-title">
      <div className="cb-container cb-hero__inner">
        {/* Under the copy: the glow behind the headline. */}
        <DecorLayer className="cb-hero__back">
          <Glow shape="headline" style={at(166, 52)} el="hero.glow" />
        </DecorLayer>

        {/* Placed under the actions on desktop; in flow after them on phones. */}
        <HeroRibbon className="cb-hero__ribbon cb-at" style={at(-34, 423.75, { w: 588 })} />

        <div className="cb-hero__copy">
          <h1 id="hero-title" className="cb-hero__title" data-el="hero.title">
            <span className="cb-line">Don’t miss</span> <span className="cb-line">the call.</span>
          </h1>
          {/* The app's Welcome line (onboarding_copy.dart), word for word. */}
          <p className="cb-hero__lead" data-el="hero.lead">
            See what people call on real prediction markets. Back them, fade them, or make your own call.
          </p>
          <div className="cb-hero__actions" data-el="hero.actions">
            <a className="cb-btn cb-btn--dark cb-hero__primary" href={GET_APP_HREF} data-el="hero.cta">
              get the app
              <ArrowIcon className="cb-hero__arrow" />
            </a>
            <a className="cb-hero__secondary" href={proofLink.href} data-el="hero.proof-link">
              <span className="cb-hero__play" aria-hidden="true">
                <PlayIcon />
              </span>
              {proofLink.label}
            </a>
          </div>
        </div>

        <div className="cb-hero__visual" data-el="hero.visual" aria-hidden="true">
          <Glow shape="phones" style={at(155, 91)} el="hero.visual.glow" />
          <Orbit shape="hero" style={at(24, 53)} el="hero.visual.orbit" />
          <Sparkle x={333.941} y={589} size={48} r={45} el="hero.visual.sparkle-1" />
          <Phone screen="friends" className="cb-at" style={at(256, 285.51, { r: -15 })} el="hero.phone-3" />
          <Sparkle x={561} y={17} size={64} el="hero.visual.sparkle-2" />
          <Sparkle x={193.569} y={684.569} size={48} r={150} el="hero.visual.sparkle-3" />
          <Phone screen="calls" width={249.593} className="cb-at" style={at(133, 217.599, { r: -15 })} el="hero.phone-2" />
          <Phone screen="home" className="cb-at" style={at(11, 140.51, { r: -15 })} el="hero.phone-1" priority />
        </div>

        {/* Over the copy: the two sparkles beside the logo and the button. */}
        <DecorLayer className="cb-hero__front">
          <Sparkle x={-95.059} y={16} size={48} r={45} el="hero.sparkle-1" />
          <Sparkle x={139.941} y={469} size={48} r={45} el="hero.sparkle-2" />
        </DecorLayer>
      </div>
    </section>
  );
}
