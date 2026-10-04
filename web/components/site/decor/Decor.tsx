/**
 * Decorative building blocks shared by every section: the soft pink glows,
 * the thin orbit rings, the sparkles and the phone mockups.
 *
 * Geometry comes straight from the Figma file. Every size is written in
 * "design pixels" (the 1440-wide artboard) and multiplied by `--u`, the
 * current size of one design pixel, so a composition keeps its proportions
 * at any width. On desktop `--u` follows the 1090px content column; small
 * screens set it per composition (see site.css).
 *
 * All of it is aria-hidden: it illustrates, it never carries meaning.
 */

import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { SCREENS, type ScreenName } from "../config";
import { SparkleIcon } from "../icons";

/* ── placement ──────────────────────────────────────────────────────────── */

type AtExtra = { w?: number; s?: number; r?: number; t?: string; z?: number };

/**
 * Inline style for a `.cb-at` element: absolutely placed at (x, y) design
 * pixels from its positioned parent, optionally rotated about its top-left
 * corner (`r`, degrees) or given a full `t` transform, as the Figma nodes are.
 */
export function at(x: number, y: number, extra: AtExtra = {}): CSSProperties {
  const style: Record<string, string | number> = { "--x": x, "--y": y };
  if (extra.w !== undefined) style["--w"] = extra.w;
  if (extra.s !== undefined) style["--s"] = extra.s;
  if (extra.r !== undefined) style["--r"] = `${extra.r}deg`;
  if (extra.t !== undefined) style["--t"] = extra.t;
  if (extra.z !== undefined) style.zIndex = extra.z;
  return style as CSSProperties;
}

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(" ");

/* ── shared SVG filters ─────────────────────────────────────────────────── */

/**
 * The Figma page's film grain, as the live page drew it: its 220px tile of
 * black noise (each pixel a random alpha), shown at 160px, repeated, in
 * soft-light at 45% over everything under the content. Soft light leaves
 * white and black as they are, so on the page it only shows on the pink:
 * the glows and the ribbon.
 */
const GRAIN = { src: "/site/grain.png", size: 160, strength: 0.45 };

/** The ribbon's artboard (HeroRibbon), with room for its swing. */
const RIBBON_BOX = { x: -30, y: -30, w: 648, h: 418 };

/**
 * Render once per page. `cb-glow` is the 60px blur that turns an ellipse
 * into a glow; `cb-grain-<shape>` grains a whole glow after its 70% opacity,
 * as the Figma texture sat over the finished glow; `cb-grain` grains the
 * ribbon. Each grain filter covers its artwork's own box in user space, so
 * the tile (anchored at 0,0) always lies inside it and the grain scales with
 * the artwork, as the Figma page scaled with the screen.
 */
export function DecorDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <defs>
        <filter id="cb-glow" x="-100%" y="-150%" width="300%" height="400%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
        {(Object.keys(GLOWS) as GlowShape[]).map((shape) => {
          const g = GLOWS[shape];
          return (
            <filter
              key={shape}
              id={`cb-grain-${shape}`}
              filterUnits="userSpaceOnUse"
              x={-GLOW_PAD}
              y={-GLOW_PAD}
              width={g.w + 2 * GLOW_PAD}
              height={g.h + 2 * GLOW_PAD}
              colorInterpolationFilters="sRGB"
            >
              <GrainSteps />
            </filter>
          );
        })}
        <filter
          id="cb-grain"
          filterUnits="userSpaceOnUse"
          x={RIBBON_BOX.x}
          y={RIBBON_BOX.y}
          width={RIBBON_BOX.w}
          height={RIBBON_BOX.h}
          colorInterpolationFilters="sRGB"
        >
          <GrainSteps />
        </filter>
      </defs>
    </svg>
  );
}

/**
 * The grain over the filtered artwork, as the Figma page composited it: the
 * noise tile in soft-light over the artwork on white paper, mixed in at the
 * layer's 45%. The white is then taken back out (minus white where the
 * artwork is absent), so the result is the artwork's own alpha with grain
 * inside it: over the white page it looks exactly like the composite, and
 * no grain leaks around it.
 */
function GrainSteps() {
  return (
    <>
      <feImage href={GRAIN.src} x="0" y="0" width={GRAIN.size} height={GRAIN.size} preserveAspectRatio="none" result="tile" />
      <feTile in="tile" result="noise" />
      <feFlood floodColor="#fff" result="paper" />
      <feComposite in="SourceGraphic" in2="paper" operator="over" result="onPaper" />
      <feBlend in="noise" in2="onPaper" mode="soft-light" result="blended" />
      <feComposite in="blended" in2="onPaper" operator="arithmetic" k1="0" k2={GRAIN.strength} k3={1 - GRAIN.strength} k4="0" result="grained" />
      <feComposite in="paper" in2="SourceGraphic" operator="out" result="paperAround" />
      <feComposite in="grained" in2="paperAround" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0" />
    </>
  );
}

/* ── glows ──────────────────────────────────────────────────────────────── */

type Ellipse = { cx: number; cy: number; rx: number; ry: number; tone: "soft" | "hot"; rotate?: number };

/** The pink glows. Each is the Figma pair of ellipses (or one), blurred 60px at 70%. */
const GLOWS = {
  /** 327 x 237: the common pair (features, benefits, testimonial, CTA corner). */
  pair: {
    w: 327,
    h: 237.255,
    ellipses: [
      { cx: 149.574, cy: 158.342, rx: 149.574, ry: 78.913, tone: "soft" },
      { cx: 180.521, cy: 78.913, rx: 146.48, ry: 78.913, tone: "hot" },
    ],
  },
  /** 393 x 285: the larger pair, used flipped / rotated. */
  pairLarge: {
    w: 393,
    h: 285.142,
    ellipses: [
      { cx: 179.764, cy: 190.302, rx: 179.764, ry: 94.841, tone: "soft" },
      { cx: 216.956, cy: 94.841, rx: 176.045, ry: 94.841, tone: "hot" },
    ],
  },
  /** 317 x 230: behind the hero headline. */
  headline: {
    w: 317,
    h: 230,
    ellipses: [
      { cx: 145, cy: 153.5, rx: 145, ry: 76.5, tone: "soft" },
      { cx: 175, cy: 76.5, rx: 142, ry: 76.5, tone: "hot" },
    ],
  },
  /** 307 x 223: inside the black CTA panel. */
  panel: {
    w: 306.789,
    h: 222.592,
    ellipses: [
      { cx: 140.33, cy: 148.556, rx: 140.33, ry: 74.036, tone: "soft" },
      { cx: 169.363, cy: 74.036, rx: 137.427, ry: 74.036, tone: "hot" },
    ],
  },
  /** 457 x 717: one long glow under the hero phones. */
  phones: {
    w: 457.237,
    h: 717.137,
    ellipses: [{ cx: 231.62, cy: 525.07, rx: 198.714, ry: 107.054, tone: "hot", rotate: 150 }],
  },
} satisfies Record<string, { w: number; h: number; ellipses: Ellipse[] }>;

export type GlowShape = keyof typeof GLOWS;

/** Room for the blur (3 standard deviations) around every glow. */
const GLOW_PAD = 190;

export function Glow({
  shape,
  style,
  className,
  grain = true,
  el,
}: {
  shape: GlowShape;
  style?: CSSProperties;
  className?: string;
  /** Film grain over the glow (off inside the black CTA, as in Figma). */
  grain?: boolean;
  el?: string;
}) {
  const g = GLOWS[shape];
  const pad = GLOW_PAD;
  // `style` carries the Figma box position (--x, --y); the padded SVG starts
  // `pad` design px further up and left.
  const s = (style ?? {}) as Record<string, unknown>;
  const placed = {
    ...s,
    "--x": Number(s["--x"] ?? 0) - pad,
    "--y": Number(s["--y"] ?? 0) - pad,
    "--w": g.w + 2 * pad,
    "--pad": pad,
  } as CSSProperties;
  const glow = (
    <g opacity="0.7">
      {g.ellipses.map((e: Ellipse, i) => (
        <ellipse
          key={i}
          cx={e.cx}
          cy={e.cy}
          rx={e.rx}
          ry={e.ry}
          className={e.tone === "hot" ? "cb-glow__hot" : "cb-glow__soft"}
          transform={e.rotate ? `rotate(${e.rotate} ${e.cx} ${e.cy})` : undefined}
          filter="url(#cb-glow)"
        />
      ))}
    </g>
  );
  return (
    <svg
      className={cx("cb-glow cb-at", className)}
      data-el={el}
      viewBox={`${-pad} ${-pad} ${g.w + 2 * pad} ${g.h + 2 * pad}`}
      style={placed}
      aria-hidden="true"
      focusable="false"
    >
      {grain ? <g filter={`url(#cb-grain-${shape})`}>{glow}</g> : glow}
    </svg>
  );
}

/* ── orbit rings ────────────────────────────────────────────────────────── */

/** Three tilted ellipses, 45 degrees, offset along the diagonal. */
const ORBITS = {
  hero: {
    w: 725.488,
    h: 705.488,
    rx: 191.085,
    ry: 275.281,
    centres: [
      [330.43, 375.0],
      [362.69, 342.73],
      [394.96, 330.47],
    ],
  },
  feature: {
    w: 719.488,
    h: 719.488,
    rx: 189.5,
    ry: 273,
    centres: [
      [327.69, 391.74],
      [359.69, 359.74],
      [391.69, 327.74],
    ],
  },
  proof: {
    w: 713,
    h: 713,
    rx: 187.725,
    ry: 270.472,
    centres: [
      [324.74, 388.2],
      [356.45, 356.49],
      [388.16, 324.78],
    ],
  },
} as const;

export type OrbitShape = keyof typeof ORBITS;

export function Orbit({
  shape,
  style,
  className,
  el,
}: {
  shape: OrbitShape;
  style?: CSSProperties;
  className?: string;
  el?: string;
}) {
  const o = ORBITS[shape];
  return (
    <svg
      className={cx("cb-orbit cb-at", className)}
      data-el={el}
      viewBox={`0 0 ${o.w} ${o.h}`}
      style={{ ...style, ["--w" as string]: o.w } as CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      {o.centres.map(([x, y], i) => (
        <ellipse
          key={i}
          className="cb-orbit__ring"
          data-ring={i + 1}
          cx={x}
          cy={y}
          rx={o.rx}
          ry={o.ry}
          transform={`rotate(-45 ${x} ${y})`}
        />
      ))}
    </svg>
  );
}

/* ── sparkles ───────────────────────────────────────────────────────────── */

/**
 * A sparkle placed at (x, y), `size` 64 or 48, rotated `r` degrees about its
 * corner. `--tw` offsets its twinkle (motion.css) by an amount derived from
 * its place, so neighbouring sparkles never pulse in step.
 */
export function Sparkle({ x, y, size = 64, r, className, el }: { x: number; y: number; size?: number; r?: number; className?: string; el?: string }) {
  const style = { ...at(x, y, { w: size, r }), "--tw": `${-Math.round(Math.abs(x * 7 + y * 13) % 4200)}ms` } as CSSProperties;
  return (
    <span className={cx("cb-sparkle cb-at", className)} data-el={el} style={style} aria-hidden="true">
      {/* The inner span pops in; the icon inside it twinkles. */}
      <span className="cb-sparkle__pop">
        <SparkleIcon />
      </span>
    </span>
  );
}

/**
 * A parallax layer: fills its placed parent, so the decor inside keeps its
 * coordinates, and moves by `depth` (0..1) with the pointer and the scroll
 * (`--px`, `--py`, `--sy`, set on the hero by MotionRoot).
 */
export function Depth({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="cb-depth" style={{ ["--d" as string]: depth } as CSSProperties} aria-hidden="true">
      {children}
    </div>
  );
}

/* ── phones ─────────────────────────────────────────────────────────────── */

/**
 * A phone: the device frame from the Figma file with an app screenshot in
 * its screen. `width` is in design pixels (249.2 in every Figma mockup).
 */
export function Phone({
  screen,
  width = 249.246,
  style,
  className,
  el,
  priority = false,
}: {
  screen: ScreenName;
  width?: number;
  style?: CSSProperties;
  className?: string;
  el?: string;
  priority?: boolean;
}) {
  const shot = SCREENS[screen];
  return (
    <div
      className={cx("cb-phone", className)}
      data-el={el}
      data-screen={screen}
      style={{ ["--w" as string]: width, ...style } as CSSProperties}
      aria-hidden="true"
    >
      <Image className="cb-phone__frame" src="/site/phone-frame.png" alt="" width={428} height={866} priority={priority} />
      <div className="cb-phone__screen">
        <div className="cb-phone__shot">
          <Image src={shot.src} alt="" fill sizes="(max-width: 1023px) 45vw, 230px" priority={priority} />
        </div>
      </div>
    </div>
  );
}

/** Wrapper for a group of absolutely placed decor inside a section. */
export function DecorLayer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("cb-decor", className)} aria-hidden="true">
      {children}
    </div>
  );
}
