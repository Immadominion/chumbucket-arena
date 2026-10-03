/**
 * Features ("What you can do"): a phone in its orbit on the left, three
 * actions on the right.
 */

import { DecorLayer, Glow, Orbit, Phone, Sparkle, at } from "../decor/Decor";
import { CubeIcon, CubeOutlineIcon, StarIcon } from "../icons";

const FEATURES = [
  {
    id: "call",
    Icon: StarIcon,
    title: "Make a call",
    body: "Pick YES or NO on a real Panta market. It’s free, and it goes on your record.",
  },
  {
    id: "back-fade",
    Icon: CubeIcon,
    title: "Back or fade",
    body: "Side with someone’s call, take the other side, or dare a friend to call it.",
  },
  {
    id: "receipt",
    Icon: CubeOutlineIcon,
    title: "Get the receipt",
    body: "When Panta settles the market, your call gets a receipt. Right or wrong.",
  },
];

export function Features() {
  return (
    <section id="features" className="cb-features" data-section="features" aria-labelledby="features-title">
      <div className="cb-container cb-features__inner">
        <DecorLayer>
          <Glow shape="pair" style={at(1096, 167.709)} el="features.glow-2" />
          <Sparkle x={-153.059} y={127.709} size={48} r={45} el="features.sparkle" />
        </DecorLayer>

        <div className="cb-features__visual cb-stage" data-el="features.visual" aria-hidden="true">
          <Glow shape="pairLarge" style={at(-78, 280.851, { t: "scaleY(-1)" })} el="features.glow-1" />
          <Orbit shape="feature" style={at(-235, -108)} el="features.orbit" />
          <Phone screen="home" el="features.phone" />
        </div>

        <div className="cb-features__copy">
          <p className="cb-eyebrow" data-el="features.eyebrow">
            features
          </p>
          <h2 id="features-title" className="cb-h2" data-el="features.title">
            What you can do
          </h2>
          <ul className="cb-features__list">
            {FEATURES.map(({ id, Icon, title, body }) => (
              <li key={id} className="cb-feature" data-el={`features.item.${id}`}>
                <h3 className="cb-feature__title">
                  <Icon className="cb-feature__icon" />
                  {title}
                </h3>
                <p className="cb-feature__body">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
