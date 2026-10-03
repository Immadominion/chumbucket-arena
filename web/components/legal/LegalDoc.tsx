/**
 * Shared frame for the legal pages (/terms, /privacy, /delete-account), in
 * the site's design language: the site header and footer, a narrow reading
 * column set in PP Neue Machina, and the unmistakable DRAFT banner every
 * page carries until counsel signs off. Server component, no client JS.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { DecorLayer, Glow, Sparkle, at } from "@/components/site/decor/Decor";
import { SiteShell } from "@/components/site/SiteShell";
import "./legal.css";

export const LEGAL_VERSION = "2026-10-02-draft";
export const LEGAL_DATE = "2 October 2026";

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/delete-account", label: "Delete your account" },
];

export function LegalDoc({
  title,
  intro,
  children,
  toc,
  current,
}: {
  title: string;
  intro: ReactNode;
  toc?: { id: string; label: string }[];
  children: ReactNode;
  /** Which legal page this is, for the sub-navigation. */
  current?: "/terms" | "/privacy" | "/delete-account";
}) {
  return (
    <SiteShell>
      <div className="legal" data-section="legal">
        <div className="cb-container legal__decor-anchor">
          <DecorLayer className="legal__decor">
            <Glow shape="pair" style={at(800, 40)} el="legal.glow" />
            <Sparkle x={1010} y={90} size={64} el="legal.sparkle" />
          </DecorLayer>
        </div>

        <article className="legal__column">
          <nav className="legal__nav" aria-label="Legal">
            <ul>
              {LEGAL_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} aria-current={current === l.href ? "page" : undefined}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="legal__draft" role="note">
            <strong>Draft for legal review.</strong> This text describes how Chumbucket actually works today and is
            awaiting review by counsel. Items in [square brackets] are still to be filled in. Version {LEGAL_VERSION},{" "}
            {LEGAL_DATE}.
          </div>

          <p className="cb-eyebrow">legal</p>
          <h1 className="legal__title">{title}</h1>
          <div className="legal__intro">{intro}</div>

          {toc && toc.length > 0 && (
            <nav className="legal__toc" aria-label="On this page">
              <ol>
                {toc.map((t) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`}>{t.label}</a>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          <div className="legal__body">{children}</div>

          <p className="legal__venue">
            Chumbucket shows markets from and routes funded trades to Panta. Powered by Panta. Chumbucket is not
            affiliated with or endorsed by Panta unless stated in writing.
          </p>
        </article>
      </div>
    </SiteShell>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="legal__section">
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="legal__p">{children}</p>;
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="legal__list">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="legal__ext">
      {children}
    </a>
  );
}
