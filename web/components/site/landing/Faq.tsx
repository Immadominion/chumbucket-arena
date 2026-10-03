/**
 * FAQ ("Questions"): six answers in a two-column checkerboard of pink and
 * white cards (one column, alternating, on phones).
 */

import { DecorLayer, Sparkle } from "../decor/Decor";

export const FAQS = [
  {
    id: "who-decides",
    q: "Who decides the result?",
    a: "Panta does. When a market settles, every call on it settles too. We never type in a result.",
  },
  {
    id: "cost",
    q: "Do calls cost anything?",
    a: "No. Calls are free and move no money. So are backing, fading and daring a friend.",
  },
  {
    id: "money",
    q: "Where does my money go?",
    a: "If you trade, your USDC buys a position on Panta from your own wallet. We never hold it.",
  },
  {
    id: "app",
    q: "Is there a phone app?",
    a: "Yes. Chumbucket is on Android, made for Solana phones like the Seeker, in the dApp Store.",
  },
  {
    id: "lose",
    q: "Can I lose money?",
    a: "Yes, if you trade. Trades are real USDC on Panta and you can lose what you put in.",
  },
  {
    id: "start",
    q: "How do I start?",
    a: "Get the app, follow a few people, then make your first call on a live market.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="cb-faq" data-section="faq" aria-labelledby="faq-title">
      <div className="cb-container cb-faq__inner">
        <DecorLayer>
          <Sparkle x={546} y={84} size={64} el="faq.sparkle" />
        </DecorLayer>

        <p className="cb-eyebrow" data-el="faq.eyebrow">
          faq
        </p>
        <h2 id="faq-title" className="cb-h2" data-el="faq.title">
          Questions
        </h2>

        <div className="cb-faq__grid">
          {FAQS.map((item) => (
            <article key={item.id} className="cb-faq__item" data-el={`faq.item.${item.id}`}>
              <h3 className="cb-faq__q">{item.q}</h3>
              <p className="cb-faq__a">{item.a}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
