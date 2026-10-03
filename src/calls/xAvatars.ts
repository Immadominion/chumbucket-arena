/**
 * Public X profile pictures, for the add-a-friend card.
 *
 * Two sources, and nothing invented:
 *
 *   1. A person who signed in with X: the picture Supabase Auth recorded at
 *      their last X sign-in (auth.identities, read by
 *      person_x_identities_v1). Passed through `safeXAvatarUrl` only.
 *   2. An X handle with no Chumbucket account: unavatar.io's public lookup,
 *      asked in its JSON mode (`/x/<handle>?json&fallback=false`), which
 *      answers with the picture's own URL on X's image CDN — or 404 when it
 *      has none. The phone then loads the picture from X's CDN directly; no
 *      handle the person typed ever leaves the server except to unavatar.
 *
 * No paid X API key is involved. unavatar's free tier allows about 25
 * lookups a day per server address, so this is best effort and bounded:
 * answers are cached (a picture for a day, "none" for six hours, a failure
 * for ten minutes), concurrent asks for one handle share one request, a
 * daily budget stops asking before unavatar refuses, and a 429 pauses
 * lookups until unavatar's own reset time. Whenever no picture is known the
 * card shows initials — never a stand-in picture.
 *
 * Configuration (read here, like src/trust/config.ts, so the integration-owned
 * src/config.ts needs no edit):
 *
 *   X_AVATAR_LOOKUP=off          never ask unavatar (cards show initials)
 *   UNAVATAR_API_KEY             optional paid unavatar key, sent as a header
 *                                only; never logged
 *   X_AVATAR_LOOKUPS_PER_DAY     upstream budget (default 20, or 2000 with a key)
 */

import { registerSecret } from "../prediction/redact.ts";

/** What `people.find` asks for a handle nobody on Chumbucket has. */
export interface XAvatarLookup {
  /** An https picture on X's CDN, or null when none is known. Never throws. */
  avatarFor(handle: string): Promise<string | null>;
}

/** No lookups: the honest default for tests and an unconfigured server. */
export const noXAvatarLookup: XAvatarLookup = {
  async avatarFor() {
    return null;
  },
};

/** X usernames: 1–15 of A–Z, a–z, 0–9 and underscore. */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const X_IMAGE_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com"]);

/**
 * An X profile picture URL we are willing to hand a phone: https, on X's own
 * image hosts, no credentials or port. X serves `_normal` (48px) by default;
 * `_400x400` is the same picture at a size that stays sharp on a card.
 * Anything else is null, so a stored or upstream value can never point the
 * app at an arbitrary host.
 */
export function safeXAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!X_IMAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  url.hash = "";
  if (url.pathname.startsWith("/profile_images/")) {
    url.pathname = url.pathname.replace(/_normal(\.[A-Za-z0-9]+)$/, "_400x400$1");
  }
  return url.toString();
}

export interface XAvatarConfig {
  enabled: boolean;
  apiKey: string | null;
  lookupsPerDay: number;
  timeoutMs: number;
}

export function resolveXAvatarConfig(env: Record<string, string | undefined> = process.env): XAvatarConfig {
  const off = (env.X_AVATAR_LOOKUP ?? "").trim().toLowerCase();
  const apiKey = env.UNAVATAR_API_KEY?.trim() || null;
  const perDay = Number(env.X_AVATAR_LOOKUPS_PER_DAY);
  return {
    enabled: !["off", "false", "0", "no", "disabled"].includes(off),
    apiKey,
    lookupsPerDay: Number.isFinite(perDay) && perDay >= 0 ? Math.floor(perDay) : apiKey ? 2000 : 20,
    timeoutMs: 2500,
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How long each kind of answer is reused. */
export const X_AVATAR_TTL = {
  found: DAY,
  none: 6 * HOUR,
  failed: 10 * 60 * 1000,
} as const;

const MAX_CACHED = 5000;

export interface UnavatarDeps {
  config: XAvatarConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Where lookups go. Fixed in production; a test may point it elsewhere. */
  baseUrl?: string;
}

export class UnavatarXAvatarLookup implements XAvatarLookup {
  private readonly cache = new Map<string, { url: string | null; until: number }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly spent: number[] = [];
  private pausedUntil = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly deps: UnavatarDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.baseUrl = (deps.baseUrl ?? "https://unavatar.io").replace(/\/+$/, "");
    registerSecret(deps.config.apiKey);
  }

  async avatarFor(handle: string): Promise<string | null> {
    if (!this.deps.config.enabled || !X_HANDLE.test(handle)) return null;
    const key = handle.toLowerCase();
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.url;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (now < this.pausedUntil || !this.spendBudget(now)) return null;
    const lookup = this.ask(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /** Sliding 24-hour budget of upstream requests. */
  private spendBudget(now: number): boolean {
    while (this.spent.length > 0 && this.spent[0]! <= now - DAY) this.spent.shift();
    if (this.spent.length >= this.deps.config.lookupsPerDay) return false;
    this.spent.push(now);
    return true;
  }

  private remember(key: string, url: string | null, ttl: number): string | null {
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, { url, until: this.now() + ttl });
    return url;
  }

  private async ask(key: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/x/${encodeURIComponent(key)}?json&fallback=false`, {
        headers: {
          accept: "application/json",
          ...(this.deps.config.apiKey ? { "x-api-key": this.deps.config.apiKey } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.deps.config.timeoutMs),
      });
      if (res.status === 404) return this.remember(key, null, X_AVATAR_TTL.none);
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-rate-limit-reset"));
        const now = this.now();
        this.pausedUntil = Number.isFinite(reset) && reset > now ? Math.min(reset, now + DAY) : now + HOUR;
        return this.remember(key, null, X_AVATAR_TTL.failed);
      }
      if (!res.ok) return this.remember(key, null, X_AVATAR_TTL.failed);
      const body = (await res.json()) as { url?: unknown } | null;
      const url = safeXAvatarUrl(body?.url);
      return this.remember(key, url, url ? X_AVATAR_TTL.found : X_AVATAR_TTL.none);
    } catch {
      // Timeout, network, a non-JSON body: no picture this time.
      return this.remember(key, null, X_AVATAR_TTL.failed);
    }
  }
}
