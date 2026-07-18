/**
 * Pure formatting helpers for the backend↔UI seam. Money crosses the wire as
 * FROST (bigint, 1 USDC = 1e6 FROST); the UI speaks USDC (number). Fixtures
 * carry full country names; the UI wants flag codes + human kickoff labels.
 */

export const FROST_PER_WAL = 1_000_000n;

/** FROST (bigint) → USDC (number). For display + the UI's number-based shapes. */
export function frostToWal(f: bigint): number {
  // Keep 4 dp of precision before handing to the UI's own rounding.
  return Number((f * 10_000n) / FROST_PER_WAL) / 10_000;
}

/** USDC (number) → FROST (bigint). For amounts going back to the backend. */
export function walToFrost(w: number): bigint {
  return BigInt(Math.round(w * Number(FROST_PER_WAL)));
}

export function fmtWal(f: bigint, dp = 1): string {
  return frostToWal(f).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * Country name → flag code (flagcdn / ISO 3166-1 alpha-2, with the UK nations).
 * Covers the realistic World Cup 2026 field; unknowns fall back to a neutral
 * marker the UI renders as a tidy placeholder rather than a broken image.
 */
const FLAG: Record<string, string> = {
  qatar: "qa", ecuador: "ec", senegal: "sn", netherlands: "nl", england: "gb-eng",
  iran: "ir", "united states": "us", usa: "us", wales: "gb-wls", argentina: "ar",
  "saudi arabia": "sa", mexico: "mx", poland: "pl", france: "fr", australia: "au",
  denmark: "dk", tunisia: "tn", spain: "es", "costa rica": "cr", germany: "de",
  japan: "jp", belgium: "be", canada: "ca", morocco: "ma", croatia: "hr",
  brazil: "br", serbia: "rs", switzerland: "ch", cameroon: "cm", portugal: "pt",
  ghana: "gh", uruguay: "uy", "south korea": "kr", "korea republic": "kr",
  "cape verde": "cv", "cape verde islands": "cv", norway: "no", italy: "it",
  egypt: "eg", nigeria: "ng", algeria: "dz", colombia: "co", chile: "cl",
  peru: "pe", "ivory coast": "ci", "côte d'ivoire": "ci", "cote d'ivoire": "ci",
  sweden: "se", austria: "at", ukraine: "ua", scotland: "gb-sct", turkey: "tr",
  türkiye: "tr", turkiye: "tr", greece: "gr", "czech republic": "cz", czechia: "cz",
  paraguay: "py", venezuela: "ve", bolivia: "bo", panama: "pa", jamaica: "jm",
  "new zealand": "nz", "south africa": "za", mali: "ml", "burkina faso": "bf",
  "dr congo": "cd", "democratic republic of congo": "cd", honduras: "hn",
  slovakia: "sk", slovenia: "si", romania: "ro", hungary: "hu", "united arab emirates": "ae",
  iraq: "iq", jordan: "jo", oman: "om", uzbekistan: "uz", qatar_: "qa",
  "new caledonia": "nc", curacao: "cw", curaçao: "cw", haiti: "ht", "el salvador": "sv",
  "trinidad and tobago": "tt", guatemala: "gt", suriname: "sr", angola: "ao",
  "equatorial guinea": "gq", gabon: "ga", benin: "bj", namibia: "na", zambia: "zm",
  tanzania: "tz", uganda: "ug", madagascar: "mg", mozambique: "mz", kenya: "ke",
};

export function flagCode(team: string): string | null {
  return FLAG[team.trim().toLowerCase()] ?? null;
}

const FLAG_BASE = "https://flagcdn.com";
/** Flag image URL for a team, or null when we don't have a code (UI shows initials). */
export function flagUrl(team: string, w: 80 | 160 = 80): string | null {
  const code = flagCode(team);
  return code ? `${FLAG_BASE}/w${w}/${code}.png` : null;
}

/** Two-letter initials fallback when there's no flag. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

const DAY = 86_400_000;

/** Human kickoff: { ko: "Today · 22:30", koTag: "KO 22:30" } relative to `now`. */
export function kickoffLabel(kickoffMs: number, now = Date.now()): { ko: string; koTag: string } {
  const d = new Date(kickoffMs);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((kickoffMs - startOfToday.getTime()) / DAY);
  if (days <= 0) return { ko: `Today · ${time}`, koTag: `KO ${time}` };
  if (days === 1) return { ko: `Tomorrow · ${time}`, koTag: `Tmrw ${time}` };
  const wd = d.toLocaleDateString([], { weekday: "short" });
  return { ko: `${wd} · ${time}`, koTag: `${wd} ${time}` };
}

/** Short Solana address: 7xKXt…gAsU */
export function shortWallet(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}
