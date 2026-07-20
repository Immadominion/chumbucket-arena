"use client";

/**
 * A team's country flag, with a graceful fallback. A team whose name isn't in
 * the flag lookup (or a flag that fails to load) would otherwise render a broken
 * image (flagcdn.com/w80/.png → 404); instead we show the team's initials in a
 * neutral circle. Pass a resolved `code`, or a `name` to resolve from.
 */

import { useState, type CSSProperties } from "react";
import { flagCode, initials } from "@/lib/format";

export function Flag({
  code,
  name,
  size = 40,
  style,
}: {
  code?: string | null;
  name?: string;
  size?: number;
  style?: CSSProperties;
}) {
  const resolved = (code && code.trim()) || (name ? flagCode(name) : null);
  const [broken, setBroken] = useState(false);
  const w = size > 80 ? 160 : 80;

  if (resolved && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://flagcdn.com/w${w}/${resolved}.png`}
        onError={() => setBroken(true)}
        alt=""
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", ...style }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#EFE6E9",
        color: "#8A7A80",
        fontWeight: 800,
        fontSize: Math.round(size * 0.34),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        ...style,
      }}
    >
      {initials(name ?? "")}
    </div>
  );
}
