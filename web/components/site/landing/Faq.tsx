/**
 * FAQ ("Questions"): eight answers to what a newcomer asks first, in a
 * two-column checkerboard of pink and white cards (one column, alternating,
 * on phones). Each answer is checked against the Terms (/terms) and the app.
 * Keep each to two lines at 1440, its first line nearly full (the cards are
 * justified), so every row stays the same height and the spacing even.
 */

import { WEB_APP_URL } from "../config";
import { DecorLayer, Sparkle } from "../decor/Decor";

export const FAQS = [
  {
    id: "free",
    q: "Is it free?",
    a: "Yes. Calling, backing, fading and daring are free and move no money. Trading is optional.",
  },
  {
    id: "panta",
    q: "What is Panta?",
    a: "A prediction market on Solana where trades are in USDC. Every market on Chumbucket is on Panta.",
  },
  {
    id: "settle",
    q: "How is a call settled?",
    a: "By Panta. When it settles a market, every call on it settles too. We never type in a result.",
  },
  {
    id: "lose",
    q: "Can I lose money?",
    a: "Not on calls. If you trade, it’s real USDC on Panta, and you can lose what you put in.",
  },
  {
    id: "wallet",
    q: "Do I need a wallet?",
    a: "Not to call: sign in with a wallet, Google or X. To trade, you need a Solana wallet with USDC.",
  },
  {
    id: "web",
    q: "Is there a web app?",
    // Only says "yes" once the deploy names a web app that serves the calls
    // product (see WEB_APP_URL in config.ts).
    a: WEB_APP_URL
      ? "Yes: “open web app” at the top of the page. Shared calls and receipts open on the web too."
      : "Shared calls, receipts and profiles all open on the web. Calling and trading are in the Android app.",
  },
  {
    id: "where",
    q: "Where can I use it?",
    a: "Anywhere prediction markets are legal and Panta allows access, for people aged 18 and over.",
  },
  {
    id: "start",
    q: "How do I start?",
    a: "Get the Android app, follow some people who call it, then make your first call. It’s free.",
  },
];

/** A no-break space before the last word, so no answer ends on a word alone. */
const noWidow = (text: string) => text.replace(/ (\S+)$/, "\u00A0$1");

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
              <p className="cb-faq__a">{noWidow(item.a)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
