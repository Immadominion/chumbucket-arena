"use client";

/**
 * The small-screen menu: a button that opens the primary links in a panel
 * under the header. The only client JS the site header ships.
 */

import { useEffect, useId, useRef, useState } from "react";
import { MenuIcon } from "./icons";

type Item = { href: string; label: string; current?: boolean };

export default function MobileMenu({ items, getApp }: { items: Item[]; getApp: { href: string; label: string } }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="cb-menu" data-el="header.menu" data-open={open || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="cb-menu__button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <MenuIcon />
        <span className="cb-visually-hidden">{open ? "Close menu" : "Menu"}</span>
      </button>
      <nav id={panelId} className="cb-menu__panel" aria-label="Menu" hidden={!open}>
        <ul>
          {items.map((item) => (
            <li key={item.href}>
              <a href={item.href} aria-current={item.current ? "page" : undefined} onClick={() => setOpen(false)}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <a className="cb-btn cb-btn--dark cb-menu__cta" href={getApp.href} onClick={() => setOpen(false)}>
          {getApp.label}
        </a>
      </nav>
    </div>
  );
}
