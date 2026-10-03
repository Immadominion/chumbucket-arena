/**
 * Site header: the Chum Bucket logo and wordmark, the section links and the
 * "Get the app" button. Server component; the small-screen menu is the only
 * client piece.
 */

import Image from "next/image";
import { GET_APP_HREF, NAV_ITEMS } from "./config";
import MobileMenu from "./MobileMenu";

export function Brand({ className = "cb-brand", el = "header.brand" }: { className?: string; el?: string }) {
  return (
    <a href="/" className={className} data-el={el} aria-label="Chumbucket home">
      {/* The source PNG is 2.3 MB; next/image serves a 2x WebP of a few KB. */}
      <Image className="cb-brand__logo" src="/img/bucket.png" alt="" width={1024} height={1536} sizes="40px" priority />
      <span className="cb-brand__word" aria-hidden="true">
        CHUMBUCKET<span className="cb-brand__tm">TM</span>
      </span>
    </a>
  );
}

export function SiteHeader({ current }: { current?: "home" }) {
  const items = NAV_ITEMS.map((item) => ({ ...item, current: current === item.id }));
  return (
    <header className="cb-header" data-section="header">
      <div className="cb-container cb-header__row">
        <Brand />
        <nav className="cb-nav" aria-label="Primary" data-el="header.nav">
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <a href={item.href} className="cb-nav__link" data-el={`header.nav.${item.id}`} aria-current={item.current ? "page" : undefined}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="cb-btn cb-btn--dark cb-header__cta" href={GET_APP_HREF} data-el="header.cta">
          Get the app
        </a>
        <MobileMenu items={items} getApp={{ href: GET_APP_HREF, label: "Get the app" }} />
      </div>
    </header>
  );
}
