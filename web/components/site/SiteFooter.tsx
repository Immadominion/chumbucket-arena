/**
 * Site footer: brand, three link columns, the follow-along box, the plain
 * statement of what money is and is not involved, and the copyright line.
 * Server component.
 */

import Image from "next/image";
import { GET_APP_HREF, PANTA_URL, X_HANDLE, X_URL } from "./config";
import { ChartIcon, PhoneIcon } from "./icons";

const COLUMNS = [
  {
    id: "links",
    title: "links",
    items: [
      { href: "/", label: "Home" },
      { href: "/#features", label: "Features" },
      { href: "/#benefits", label: "Benefits" },
      { href: X_URL, label: "twitter / x", external: true },
    ],
  },
  {
    id: "more",
    title: "more",
    items: [
      { href: "/terms", label: "terms" },
      { href: "/privacy", label: "privacy" },
      { href: "/delete-account", label: "delete account" },
    ],
  },
  {
    id: "product",
    title: "product",
    items: [
      { href: GET_APP_HREF, label: "get the app" },
      { href: "/#live", label: "live calls" },
      { href: "/#faq", label: "questions" },
    ],
  },
] as const;

export function SiteFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="cb-footer" data-section="footer">
      <div className="cb-container">
        <div className="cb-footer__grid">
          <div className="cb-footer__brand" data-el="footer.brand">
            <a href="/" className="cb-footer__logo" aria-label="Chumbucket home">
              <Image src="/img/bucket.png" alt="" width={1024} height={1536} sizes="24px" />
              <span aria-hidden="true">
                CHUMBUCKET<span className="cb-footer__tm">TM</span>
              </span>
            </a>
            <ul className="cb-footer__facts">
              <li>
                <PhoneIcon className="cb-footer__icon" />
                <a href={GET_APP_HREF}>Android · dApp Store</a>
              </li>
              <li>
                <ChartIcon className="cb-footer__icon" />
                <a href={PANTA_URL} target="_blank" rel="noopener">
                  Markets by Panta
                </a>
              </li>
            </ul>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.id} className="cb-footer__col" aria-labelledby={`footer-${col.id}`} data-el={`footer.${col.id}`}>
              <h2 id={`footer-${col.id}`} className="cb-footer__title">
                {col.title}
              </h2>
              <ul>
                {col.items.map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      {...("external" in item && item.external ? { target: "_blank", rel: "noopener" } : {})}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}

          <div className="cb-footer__updates" data-el="footer.updates">
            <h2 className="cb-footer__title">Updates</h2>
            <p>Follow along</p>
            <a className="cb-follow" href={X_URL} target="_blank" rel="noopener" data-el="footer.follow">
              <span className="cb-follow__handle">@{X_HANDLE}</span>
              <span className="cb-follow__button">Follow</span>
            </a>
          </div>
        </div>

        <p className="cb-footer__money" data-el="footer.money">
          Calls are free and move no money. Trading is optional: a trade is real USDC on{" "}
          <a href={PANTA_URL} target="_blank" rel="noopener">
            Panta
          </a>{" "}
          (Solana mainnet), paid from your own wallet, and you can lose what you put in. Check that prediction markets are
          legal where you live.
        </p>
        <p className="cb-footer__copy" data-el="footer.copyright">
          Copyright {year} Chumbucket. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
