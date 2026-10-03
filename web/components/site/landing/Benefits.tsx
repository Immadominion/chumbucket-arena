/**
 * Benefits ("Why people use it"): two rows that swap sides. Row one follows
 * people (copy left, phone right, with a call card lifted off the screen);
 * row two is about who settles a call (phone left, copy right).
 */

import Image from "next/image";
import { SCREENS } from "../config";
import { DecorLayer, Glow, Orbit, Phone, Sparkle, at } from "../decor/Decor";
import { BellIcon, StarIcon } from "../icons";

export function Benefits() {
  return (
    <section id="benefits" className="cb-benefits" data-section="benefits" aria-labelledby="benefits-title">
      <div className="cb-container cb-benefits__row cb-benefits__row--follow" data-el="benefits.follow">
        <DecorLayer>
          <Sparkle x={1137} y={77.221} size={64} el="benefits.follow.sparkle" />
        </DecorLayer>

        <div className="cb-benefits__copy">
          <p className="cb-eyebrow" data-el="benefits.eyebrow">
            advantages
          </p>
          <h2 id="benefits-title" className="cb-h2" data-el="benefits.title">
            Why people use it
          </h2>
          <article className="cb-benefit" data-el="benefits.follow.item">
            <h3 className="cb-benefit__title">
              <span className="cb-benefit__badge" aria-hidden="true">
                <BellIcon className="cb-benefit__icon cb-benefit__icon--light" />
              </span>
              Follow people who call it
            </h3>
            <p className="cb-benefit__body">
              Their calls show up first on your Home, next to a record of how often they called it right.
            </p>
          </article>
        </div>

        <div className="cb-benefits__visual cb-stage" data-el="benefits.follow.visual" aria-hidden="true">
          <Glow shape="pair" style={at(-56, 204.221)} el="benefits.follow.glow" />
          <Orbit shape="feature" style={at(-235, -107)} el="benefits.follow.orbit" />
          <Phone screen="calls" width={249.593} el="benefits.follow.phone" />
          {/* A call card from the same screen, lifted off the phone. */}
          <div className="cb-benefits__card cb-at" style={at(112, 233.221, { w: 201 })} data-el="benefits.follow.card">
            <Image src={SCREENS.calls.src} alt="" fill sizes="(max-width: 1023px) 40vw, 201px" />
          </div>
        </div>
      </div>

      <div className="cb-container cb-benefits__row cb-benefits__row--settle" data-el="benefits.settle">
        <DecorLayer>
          <Sparkle x={431.941} y={7.733} size={48} r={45} el="benefits.settle.sparkle-1" />
          <Sparkle x={903} y={639.733} size={64} el="benefits.settle.sparkle-2" />
        </DecorLayer>

        <div className="cb-benefits__visual cb-stage" data-el="benefits.settle.visual" aria-hidden="true">
          <Glow shape="pairLarge" style={at(-31, 266.578, { t: "matrix(0.767, 0.641, 0.641, -0.767, 0, 0)" })} el="benefits.settle.glow" />
          <Orbit shape="feature" style={at(-235, -108)} el="benefits.settle.orbit" />
          <Phone screen="calls" el="benefits.settle.phone" />
        </div>

        <div className="cb-benefits__copy">
          <article className="cb-benefit" data-el="benefits.settle.item">
            <h3 className="cb-benefit__title">
              <span className="cb-benefit__badge" aria-hidden="true">
                <StarIcon className="cb-benefit__icon" />
              </span>
              Panta settles it
            </h3>
            <p className="cb-benefit__body">
              Nobody at Chumbucket types in a result. Every call settles from the Panta market it was made on.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
