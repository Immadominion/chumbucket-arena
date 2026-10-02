/**
 * Link-preview images (1200x630) for shared calls, people and markets.
 *
 * Rendered with next/og (Satori): flexbox only, every multi-child element is
 * display:flex. Fonts and the logo are read from /public at render time, which
 * the Node runtime traces into the function bundle; if a read fails the card
 * still renders with the built-in font rather than erroring the preview.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#1A1013";
const PAPER = "#FAF6F7";
const CORAL = "#FF3355";
const MUTED = "#6A5A60";
const LINE = "#EFE6E9";
const WON = "#0F7A4F";
const LOST = "#B4232A";

async function asset(path: string): Promise<Buffer | null> {
  try {
    return await readFile(join(process.cwd(), "public", path));
  } catch {
    return null;
  }
}

async function fonts() {
  const [regular, bold] = await Promise.all([
    asset("fonts/PPNeueMachina-Regular.otf"),
    asset("fonts/PPNeueMachina-Ultrabold.otf"),
  ]);
  const out: Array<{ name: string; data: Buffer; weight: 400 | 800; style: "normal" }> = [];
  if (regular) out.push({ name: "Machina", data: regular, weight: 400, style: "normal" });
  if (bold) out.push({ name: "Machina", data: bold, weight: 800, style: "normal" });
  return out;
}

async function logoDataUrl(): Promise<string | null> {
  const png = await asset("img/logo-192.png");
  return png ? `data:image/png;base64,${png.toString("base64")}` : null;
}

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export interface OgCardInput {
  /** Small coral label above the headline, e.g. "ON THE RECORD". */
  eyebrow: string;
  /** e.g. "Dominion called" */
  lead: string;
  /** The side pill, e.g. "YES"; omitted for person/market cards. */
  pill?: { text: string; side: "YES" | "NO" } | null;
  /** e.g. "at 50¢" */
  trailing?: string | null;
  /** The market question or a person's record line. */
  body: string;
  /** Bottom-right stamp, e.g. "CORRECT". */
  stamp?: { text: string; tone: "won" | "lost" | "neutral" } | null;
  footer: string;
}

export async function ogCard(input: OgCardInput): Promise<ImageResponse> {
  const [fontList, logo] = await Promise.all([fonts(), logoDataUrl()]);
  const family = fontList.length ? "Machina" : undefined;
  const stampColor = input.stamp?.tone === "won" ? WON : input.stamp?.tone === "lost" ? LOST : MUTED;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: PAPER,
          fontFamily: family,
          color: INK,
          padding: 56,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {logo ? <img src={logo} width={64} height={64} alt="" /> : null}
            <div style={{ display: "flex", fontSize: 34, fontWeight: 800, letterSpacing: -0.5 }}>Chumbucket</div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              fontWeight: 800,
              color: CORAL,
              letterSpacing: 2,
            }}
          >
            {input.eyebrow}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            marginTop: 36,
            background: "#FFFFFF",
            borderRadius: 32,
            border: `2px solid ${LINE}`,
            padding: "40px 48px",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40 }}>
              <div style={{ display: "flex" }}>{clamp(input.lead, 40)}</div>
              {input.pill ? (
                <div
                  style={{
                    display: "flex",
                    fontSize: 34,
                    fontWeight: 800,
                    padding: "6px 22px",
                    borderRadius: 999,
                    color: input.pill.side === "YES" ? WON : LOST,
                    background: input.pill.side === "YES" ? "#E3F5EC" : "#FBE6E7",
                  }}
                >
                  {clamp(input.pill.text, 18)}
                </div>
              ) : null}
              {input.trailing ? <div style={{ display: "flex", color: MUTED }}>{input.trailing}</div> : null}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 28,
                fontSize: 54,
                fontWeight: 800,
                lineHeight: 1.12,
                letterSpacing: -1,
              }}
            >
              {clamp(input.body, 120)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", fontSize: 24, color: MUTED }}>{input.footer}</div>
            {input.stamp ? (
              <div
                style={{
                  display: "flex",
                  fontSize: 28,
                  fontWeight: 800,
                  color: stampColor,
                  border: `4px solid ${stampColor}`,
                  borderRadius: 14,
                  padding: "6px 18px",
                  letterSpacing: 2,
                }}
              >
                {input.stamp.text}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 24, fontSize: 24, color: MUTED }}>chumbucket.fun</div>
      </div>
    ),
    { ...OG_SIZE, fonts: fontList.length ? fontList : undefined },
  );
}
