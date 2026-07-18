"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ArrowRight, CursorClick } from "@/components/icons";

export type TourStep = {
  sel: string; // CSS selector for the reference element
  title: string;
  body: string;
};

type Rect = { x: number; y: number; w: number; h: number };

const PAD = 10;
const NOTE_W = 308;

/**
 * Spotlight coach-tour. Dims the whole screen, punches a hole around the current
 * reference element, and shows a numbered note + a pointing cursor. Everything
 * else is inert — only the note's button advances the tour.
 */
export default function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const step = steps[i];
    if (!step) return;
    const el = document.querySelector(step.sel) as HTMLElement | null;
    setVp({ w: window.innerWidth, h: window.innerHeight });
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
  }, [i, steps]);

  // on step change: scroll the target into view, then measure
  useLayoutEffect(() => {
    const step = steps[i];
    const el = step ? (document.querySelector(step.sel) as HTMLElement | null) : null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(measure, el ? 320 : 0);
    return () => clearTimeout(t);
  }, [i, steps, measure]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [measure]);

  const next = () => (i >= steps.length - 1 ? onDone() : setI(i + 1));
  const step = steps[i];
  if (!step) return null;

  const hole = rect
    ? { x: rect.x - PAD, y: rect.y - PAD, w: rect.w + PAD * 2, h: rect.h + PAD * 2 }
    : { x: vp.w / 2 - 80, y: vp.h / 2 - 40, w: 160, h: 80 };

  // place the note below the hole if there's room, else above; clamp horizontally
  const noteBelow = hole.y + hole.h + 190 < vp.h || hole.y < 200;
  const noteTop = noteBelow ? hole.y + hole.h + 16 : Math.max(16, hole.y - 172);
  const noteLeft = Math.min(Math.max(16, hole.x), Math.max(16, vp.w - NOTE_W - 16));

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 95 }}>
      {/* dim + spotlight hole */}
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <mask id="tour-hole">
            <rect width="100%" height="100%" fill="white" />
            <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx={16} ry={16} fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(8,16,12,.74)" mask="url(#tour-hole)" />
        <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx={16} ry={16} fill="none" stroke="rgba(242,58,92,.9)" strokeWidth={2} />
      </svg>

      {/* pointing cursor at the hole's lower-right */}
      <div
        style={{
          position: "absolute",
          left: hole.x + hole.w - 6,
          top: hole.y + hole.h - 6,
          animation: "tour-bounce 1s ease-in-out infinite",
          color: "#FF5A76",
          filter: "drop-shadow(0 4px 8px rgba(0,0,0,.4))",
          pointerEvents: "none",
        }}
      >
        <CursorClick size={30} weight="fill" />
      </div>

      {/* note */}
      <div
        style={{
          position: "absolute",
          top: noteTop,
          left: noteLeft,
          width: NOTE_W,
          background: "#1a1013",
          color: "#fff",
          borderRadius: 18,
          padding: 18,
          boxShadow: "0 24px 60px rgba(8,16,12,.5)",
          animation: "popin .2s cubic-bezier(.2,.8,.2,1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          <span className="cd" style={{ fontSize: 11, letterSpacing: "1px", color: "#FFB0C0" }}>
            {i + 1} OF {steps.length}
          </span>
          <button onClick={onDone} style={{ background: "none", border: "none", color: "#7E8C84", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Skip
          </button>
        </div>
        <div className="cd" style={{ fontSize: 17, marginBottom: 5 }}>{step.title}</div>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, color: "#B8C6BD", fontWeight: 500 }}>{step.body}</p>
        <div style={{ display: "flex", gap: 4, margin: "14px 0" }}>
          {steps.map((_, n) => (
            <span key={n} style={{ flex: 1, height: 4, borderRadius: 4, background: n <= i ? "#FF5A76" : "rgba(255,255,255,.12)" }} />
          ))}
        </div>
        <button onClick={next} className="btnp" style={{ width: "100%", padding: 11, borderRadius: 12, fontSize: 14 }}>
          {i >= steps.length - 1 ? "Got it" : "Next"}
          {i < steps.length - 1 && <ArrowRight size={15} weight="bold" />}
        </button>
      </div>
    </div>
  );
}
