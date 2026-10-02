/**
 * Shared frame for the legal pages (/terms, /privacy, /delete-account).
 * A server component: no client JavaScript, readable on a phone, and every
 * page carries the same unmistakable DRAFT banner until counsel signs off.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export const LEGAL_VERSION = "2026-10-02-draft";
export const LEGAL_DATE = "2 October 2026";

const INK = "#1A1013";
const BODY = "#493A40";
const CORAL = "#D81E4A";
const LINE = "#EFE6E9";

export function LegalDoc({
  title,
  intro,
  children,
  toc,
}: {
  title: string;
  intro: ReactNode;
  toc?: { id: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <div style={{ minHeight: "100vh", background: "#FAF6F7", color: BODY }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 96px" }}>
        <nav style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 14, fontWeight: 600, marginBottom: 28 }}>
          <Link href="/" style={{ color: CORAL, textDecoration: "none" }}>
            Chumbucket
          </Link>
          <Link href="/terms" style={{ color: INK, textDecoration: "none" }}>
            Terms
          </Link>
          <Link href="/privacy" style={{ color: INK, textDecoration: "none" }}>
            Privacy
          </Link>
          <Link href="/delete-account" style={{ color: INK, textDecoration: "none" }}>
            Delete your account
          </Link>
        </nav>

        <div
          role="note"
          style={{
            border: `1px solid ${CORAL}`,
            background: "#FFE7EC",
            color: "#7A0F2A",
            borderRadius: 14,
            padding: "12px 16px",
            fontSize: 14,
            lineHeight: 1.5,
            marginBottom: 24,
          }}
        >
          <strong>Draft for legal review.</strong> This text describes how Chumbucket actually works today and
          is awaiting review by counsel. Items in [square brackets] are still to be filled in. Version {LEGAL_VERSION},{" "}
          {LEGAL_DATE}.
        </div>

        <h1 className="cd" style={{ fontSize: 38, lineHeight: 1.08, color: INK, margin: 0, letterSpacing: -0.5 }}>
          {title}
        </h1>
        <div style={{ fontSize: 16, lineHeight: 1.65, margin: "14px 0 0" }}>{intro}</div>

        {toc && toc.length > 0 && (
          <ol
            style={{
              margin: "28px 0 0",
              padding: "16px 16px 16px 36px",
              background: "#fff",
              border: `1px solid ${LINE}`,
              borderRadius: 14,
              fontSize: 14,
              lineHeight: 1.9,
            }}
          >
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`} style={{ color: INK }}>
                  {t.label}
                </a>
              </li>
            ))}
          </ol>
        )}

        <div style={{ marginTop: 12 }}>{children}</div>

        <footer style={{ marginTop: 56, paddingTop: 20, borderTop: `1px solid ${LINE}`, fontSize: 13, lineHeight: 1.6 }}>
          Chumbucket shows markets from and routes funded trades to Panta. Powered by Panta. Chumbucket is not
          affiliated with or endorsed by Panta unless stated in writing.
        </footer>
      </div>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} style={{ marginTop: 36, scrollMarginTop: 24 }}>
      <h2 className="cd" style={{ fontSize: 22, color: INK, margin: "0 0 10px", lineHeight: 1.2 }}>
        {title}
      </h2>
      <div style={{ fontSize: 15.5, lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p style={{ margin: "0 0 12px" }}>{children}</p>;
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: "0 0 12px", paddingLeft: 22 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 6 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: CORAL }}>
      {children}
    </a>
  );
}
