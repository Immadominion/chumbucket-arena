"use client";

/**
 * The FAQ cards as an accordion. Each question is a real button
 * (aria-expanded, aria-controls) over a panel whose height animates
 * (grid rows 0fr to 1fr, landing-motion.css "FAQ").
 *
 * Desktop (1024px and up) opens every answer, as the two-column card grid
 * always showed them; smaller screens start folded, so eight questions fit
 * on a screen or two. Until this hydrates CSS draws the same default from
 * the same breakpoint, so nothing moves when it does; without JavaScript a
 * <noscript> style in Faq.tsx opens them all.
 */

import { useEffect, useId, useRef, useState } from "react";

export type FaqItem = { id: string; q: string; a: string };

const DESKTOP = "(min-width: 1024px)";

export function FaqList({ items }: { items: FaqItem[] }) {
  // null until mounted: CSS decides (by breakpoint), so server and client agree.
  const [open, setOpen] = useState<Record<string, boolean> | null>(null);
  const touched = useRef(false);
  const uid = useId();

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = () => {
      if (!touched.current) setOpen(Object.fromEntries(items.map((i) => [i.id, mq.matches])));
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [items]);

  const toggle = (id: string) => {
    touched.current = true;
    setOpen((prev) => {
      const base = prev ?? Object.fromEntries(items.map((i) => [i.id, window.matchMedia(DESKTOP).matches]));
      return { ...base, [id]: !base[id] };
    });
  };

  return (
    <div className="cb-faq__grid">
      {items.map((item, i) => {
        const isOpen = open?.[item.id];
        const button = `${uid}-q-${item.id}`;
        const panel = `${uid}-a-${item.id}`;
        return (
          <article
            key={item.id}
            className="cb-faq__item"
            data-el={`faq.item.${item.id}`}
            data-open={isOpen === undefined ? undefined : String(isOpen)}
            data-reveal=""
            style={{ ["--i" as string]: i % 2 }}
          >
            <h3 className="cb-faq__q">
              <button
                id={button}
                type="button"
                className="cb-faq__toggle"
                aria-expanded={isOpen ?? undefined}
                aria-controls={panel}
                onClick={() => toggle(item.id)}
              >
                <span>{item.q}</span>
                <span className="cb-faq__icon" aria-hidden="true" />
              </button>
            </h3>
            <div id={panel} className="cb-faq__panel" inert={isOpen === false ? true : undefined}>
              <div className="cb-faq__panel-inner">
                <p className="cb-faq__a">{item.a}</p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
