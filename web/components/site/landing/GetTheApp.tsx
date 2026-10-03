/**
 * Call to action ("Call it before it happens."): the black panel with its
 * white orbits, a glow, two sparkles and three phones rising from the bottom
 * edge. The section the header, hero and floating "get the app" links jump
 * to.
 *
 * Motion (landing-motion.css, "Call to action"): the panel rises in, its
 * copy follows, the phones rise out of the bottom edge one after another
 * and then float; the white sparkles twinkle.
 */

import Image from "next/image";
import type { CSSProperties } from "react";
import { INSTALL_URL, SCREENS, type ScreenName } from "../config";
import { DecorLayer, Glow, Orbit, Sparkle, at } from "../decor/Decor";
import { AndroidIcon } from "../icons";

/**
 * A phone rising out of the panel: a dark bezel (CSS) and a screenshot.
 * Coordinates are the Figma ones, relative to the panel.
 */
function PanelPhone({
  screen,
  x,
  y,
  w,
  inset,
  band,
  radius,
  shot,
  notch = true,
  el,
}: {
  screen: ScreenName;
  x: number;
  y: number;
  w: number;
  /** Bezel width at the sides. */
  inset: number;
  /** Height of the black band above the screen. */
  band: number;
  radius: number;
  /** The screenshot's box inside the screen (top offset and height). */
  shot: { top: number; height: number };
  /** The camera pill in the top band (the Figma centre phone has none). */
  notch?: boolean;
  el: string;
}) {
  const style = {
    ...at(x, y, { w }),
    "--inset": inset,
    "--band": band,
    "--radius": radius,
    "--shot-top": shot.top,
    "--shot-h": shot.height,
  } as CSSProperties;
  return (
    <div className="cb-panel-phone cb-at" style={style} data-el={el} data-screen={screen}>
      {notch ? <span className="cb-panel-phone__notch" /> : null}
      <div className="cb-panel-phone__screen">
        <div className="cb-panel-phone__shot">
          <Image src={SCREENS[screen].src} alt="" fill sizes="(max-width: 1023px) 34vw, 220px" />
        </div>
      </div>
    </div>
  );
}

export function GetTheApp() {
  return (
    <section id="get" className="cb-cta" data-section="cta" aria-labelledby="cta-title">
      <div className="cb-container cb-cta__inner">
        <DecorLayer>
          <Glow shape="pair" style={at(-141, -87)} el="cta.glow-outside" />
          <Sparkle x={1090} y={-74} size={64} el="cta.sparkle-1" />
          <Sparkle x={-151.059} y={137} size={48} r={45} el="cta.sparkle-2" />
        </DecorLayer>

        <div className="cb-cta__panel" data-el="cta.panel" data-reveal="panel">
          <div className="cb-cta__decor" aria-hidden="true">
            <Orbit shape="feature" className="cb-orbit--light" style={at(-328, 192)} el="cta.orbit-1" />
            <Orbit shape="feature" className="cb-orbit--light" style={at(730, -248)} el="cta.orbit-2" />
            <Glow shape="panel" grain={false} style={at(732, 269.838, { t: "matrix(0.767, 0.641, 0.641, -0.767, 0, 0)" })} el="cta.glow" />
            <Sparkle x={649} y={34} size={64} className="cb-sparkle--light" el="cta.sparkle-3" />
            <Sparkle x={445.941} y={338} size={48} r={45} className="cb-sparkle--light" el="cta.sparkle-4" />
          </div>

          <div className="cb-cta__copy">
            <h2 id="cta-title" className="cb-cta__title" data-el="cta.title">
              {/* The app's Welcome title, on two lines at every width: as one
                  line (768px) it runs under the panel's top-right sparkle. */}
              <span className="cb-line">Call it before</span> <span className="cb-line">it happens.</span>
            </h2>
            <p className="cb-cta__text" data-el="cta.text">
              Get the Android app, follow a few people and make your first call. It’s&nbsp;free.
            </p>
            {INSTALL_URL ? (
              <a className="cb-btn cb-btn--light cb-cta__button" href={INSTALL_URL} rel="noopener" data-el="cta.button">
                get the app
                <AndroidIcon className="cb-cta__glyph" />
              </a>
            ) : (
              <p className="cb-cta__store" data-el="cta.button">
                <span>
                  <span className="cb-cta__store-small">Search “Chumbucket” in the</span>
                  Solana dApp Store
                </span>
                <AndroidIcon className="cb-cta__glyph" />
              </p>
            )}
          </div>

          <div className="cb-cta__phones" data-el="cta.phones" aria-hidden="true">
            <PanelPhone screen="call" x={557.06} y={222.472} w={209.333} inset={8.898} band={33.087} radius={28} shot={{ top: -16.12, height: 421.93 }} el="cta.phone-left" />
            <PanelPhone screen="profile" x={861.726} y={227.741} w={209.333} inset={8.838} band={27.818} radius={28} shot={{ top: -16.12, height: 421.93 }} el="cta.phone-right" />
            <PanelPhone screen="welcome" x={698} y={160.291} w={234} inset={7.762} band={29.007} radius={30} shot={{ top: -18.275, height: 478.342 }} notch={false} el="cta.phone-centre" />
          </div>
        </div>
      </div>
    </section>
  );
}
