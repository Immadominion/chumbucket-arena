"use client";

/**
 * The site's one motion script. Mounted once by SiteShell; renders nothing.
 * Everything it does is a data attribute or a CSS variable on markup the
 * server already rendered, and every visual change lives in CSS
 * (motion.css, landing-motion.css), so the page is complete without it.
 *
 * - Reveals: `[data-reveal]` elements below the fold are hidden once this
 *   runs and get `data-inview="in"` as they scroll into view (once). Those
 *   already on screen get `data-inview="static"` first, so nothing visible
 *   ever blinks out.
 * - Loops: each `[data-section]` gets `data-playing` while on screen; CSS
 *   pauses a section's looping animations (float, twinkle, nudge) otherwise.
 * - Header: `data-js` on the root (the desktop header sticks only then) and
 *   `data-scrolled` on `.cb-header` once the page leaves the top.
 * - Floating button: `data-fab="away"` on the root while the get-the-app
 *   panel is on screen (it would repeat the panel's own button).
 * - Hero depth: `--px`/`--py` (pointer, -1..1, eased) and `--sy` (scroll
 *   through the hero, 0..1) on the hero section, for its phone layers.
 * - Tilt: `[data-tilt]` elements get `--tilt-x`/`--tilt-y` (degrees) and
 *   `--glow-x`/`--glow-y` (%) from the pointer while it is over them.
 *
 * With prefers-reduced-motion only the header and floating-button states
 * run (they are state, not motion; their transitions are off in CSS).
 */

import { useEffect } from "react";

export function MotionRoot() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".cb-site");
    if (!root) return;
    // Script is running: the desktop header may stick (its backdrop needs
    // `data-scrolled`, which only this sets).
    root.setAttribute("data-js", "");
    const cleanups: Array<() => void> = [];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* header: compact once the page has scrolled */
    const header = root.querySelector<HTMLElement>(".cb-header");
    if (header) {
      let last: boolean | null = null;
      const onScroll = () => {
        const scrolled = window.scrollY > 24;
        if (scrolled === last) return;
        last = scrolled;
        if (scrolled) header.setAttribute("data-scrolled", "");
        else header.removeAttribute("data-scrolled");
      };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener("scroll", onScroll));
    }

    /* floating button: tucked away while the get-the-app panel shows */
    const cta = root.querySelector('[data-section="cta"]');
    if (cta) {
      const io = new IntersectionObserver(([e]) => {
        if (e?.isIntersecting) root.setAttribute("data-fab", "away");
        else root.removeAttribute("data-fab");
      }, { rootMargin: "0px 0px -20% 0px" });
      io.observe(cta);
      cleanups.push(() => io.disconnect());
    }

    if (reduce) return () => cleanups.forEach((f) => f());

    /* reveals */
    const reveals = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    const fold = window.innerHeight * 0.92;
    for (const el of reveals) {
      if (el.getBoundingClientRect().top < fold) el.setAttribute("data-inview", "static");
    }
    root.setAttribute("data-motion", "on");
    const revealIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute("data-inview", "in");
          revealIO.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of reveals) if (!el.hasAttribute("data-inview")) revealIO.observe(el);
    cleanups.push(() => revealIO.disconnect());

    /* loops play only while their section is on screen */
    const playIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) e.target.setAttribute("data-playing", "");
          else e.target.removeAttribute("data-playing");
        }
      },
      { rootMargin: "10% 0px" },
    );
    root.querySelectorAll("[data-section]").forEach((s) => playIO.observe(s));
    cleanups.push(() => playIO.disconnect());

    /* hero depth: pointer (fine pointers only) and scroll */
    const hero = root.querySelector<HTMLElement>('[data-section="hero"]');
    if (hero) {
      const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      let tx = 0, ty = 0, cx = 0, cy = 0, sy = -1, frame = 0;
      const write = () => {
        frame = 0;
        cx += (tx - cx) * 0.08;
        cy += (ty - cy) * 0.08;
        if (Math.abs(tx - cx) < 0.0005) cx = tx;
        if (Math.abs(ty - cy) < 0.0005) cy = ty;
        hero.style.setProperty("--px", cx.toFixed(4));
        hero.style.setProperty("--py", cy.toFixed(4));
        if (cx !== tx || cy !== ty) frame = requestAnimationFrame(write);
      };
      const kick = () => {
        if (!frame) frame = requestAnimationFrame(write);
      };
      const onPointer = (e: PointerEvent) => {
        if (!hero.hasAttribute("data-playing")) return;
        tx = (e.clientX / window.innerWidth - 0.5) * 2;
        ty = (e.clientY / window.innerHeight - 0.5) * 2;
        kick();
      };
      const onLeave = () => {
        tx = 0;
        ty = 0;
        kick();
      };
      const onScroll = () => {
        const next = Math.min(1, Math.max(0, window.scrollY / Math.max(1, hero.offsetHeight)));
        if (Math.abs(next - sy) < 0.002) return;
        sy = next;
        hero.style.setProperty("--sy", sy.toFixed(3));
      };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener("scroll", onScroll));
      if (finePointer) {
        window.addEventListener("pointermove", onPointer, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
        cleanups.push(() => {
          window.removeEventListener("pointermove", onPointer);
          document.documentElement.removeEventListener("pointerleave", onLeave);
        });
      }
      cleanups.push(() => cancelAnimationFrame(frame));
    }

    /* tilt: the live call card leans toward the pointer */
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      root.querySelectorAll<HTMLElement>("[data-tilt]").forEach((el) => {
        const onMove = (e: PointerEvent) => {
          const r = el.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          const y = (e.clientY - r.top) / r.height;
          el.style.setProperty("--tilt-x", `${((x - 0.5) * 6).toFixed(2)}deg`);
          el.style.setProperty("--tilt-y", `${((0.5 - y) * 6).toFixed(2)}deg`);
          el.style.setProperty("--glow-x", `${(x * 100).toFixed(1)}%`);
          el.style.setProperty("--glow-y", `${(y * 100).toFixed(1)}%`);
        };
        const onLeave = () => {
          el.style.setProperty("--tilt-x", "0deg");
          el.style.setProperty("--tilt-y", "0deg");
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerleave", onLeave);
        cleanups.push(() => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerleave", onLeave);
        });
      });
    }

    return () => cleanups.forEach((f) => f());
  }, []);

  return null;
}
