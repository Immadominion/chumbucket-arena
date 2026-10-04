/**
 * What makes the web app open where you left it: the last answers the BFF
 * gave, kept in the browser per account and shown at once on the next visit
 * while fresh ones load quietly behind them. There is no "updated 3 min ago"
 * and no refresh button anywhere: cached data is shown, then replaced.
 *
 * Pure over a storage interface (localStorage in the browser), so the rules
 * are tested in the BFF repo: one slot per account, a version, a maximum
 * age, a size cap, and infinite lists trimmed to their first page.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const VERSION = 1;
const PREFIX = "cb.app.cache";
/** Older than a week, a cache is more misleading than useful. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Well under the ~5 MB localStorage budget. */
export const CACHE_MAX_BYTES = 1_500_000;

export const cacheKey = (userId: string): string => `${PREFIX}.v${VERSION}.${userId}`;

interface Envelope {
  v: number;
  savedAt: number;
  state: unknown;
}

/** A dehydrated react-query state, loosely: only the parts trimmed here. */
interface DehydratedLike {
  queries?: Array<{ state?: { data?: unknown } } & Record<string, unknown>>;
  mutations?: unknown[];
}

/** Infinite queries keep their first page only: enough to open instantly. */
export function trimForStorage(state: unknown): unknown {
  const s = state as DehydratedLike | null;
  if (!s || !Array.isArray(s.queries)) return state;
  return {
    ...s,
    mutations: [],
    queries: s.queries.map((q) => {
      const data = q.state?.data as { pages?: unknown[]; pageParams?: unknown[] } | undefined;
      if (data && Array.isArray(data.pages) && Array.isArray(data.pageParams) && data.pages.length > 1) {
        return { ...q, state: { ...q.state, data: { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } } };
      }
      return q;
    }),
  };
}

/** Save; never throws (private windows and full storage just skip it). Returns whether it saved. */
export function saveCache(storage: KeyValueStorage | null, userId: string, state: unknown, now: number): boolean {
  if (!storage) return false;
  try {
    const json = JSON.stringify({ v: VERSION, savedAt: now, state: trimForStorage(state) } satisfies Envelope);
    if (json.length > CACHE_MAX_BYTES) {
      storage.removeItem(cacheKey(userId));
      return false;
    }
    storage.setItem(cacheKey(userId), json);
    return true;
  } catch {
    return false;
  }
}

/** Load the account's cache, or null when there is none, it is too old, or it is unreadable. */
export function loadCache(storage: KeyValueStorage | null, userId: string, now: number): unknown | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKey(userId));
    if (!raw) return null;
    const env = JSON.parse(raw) as Partial<Envelope>;
    if (env.v !== VERSION || typeof env.savedAt !== "number" || now - env.savedAt > CACHE_MAX_AGE_MS) {
      storage.removeItem(cacheKey(userId));
      return null;
    }
    return env.state ?? null;
  } catch {
    return null;
  }
}

export function clearCache(storage: KeyValueStorage | null, userId: string): void {
  try {
    storage?.removeItem(cacheKey(userId));
  } catch {
    // Nothing to clear.
  }
}

/** Small per-viewer conveniences (the Home tab, Markets filters). Never throws. */
export function readPref<T>(storage: KeyValueStorage | null, key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = storage?.getItem(`cb.app.pref.${key}`);
    return raw ? parse(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(storage: KeyValueStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(`cb.app.pref.${key}`, JSON.stringify(value));
  } catch {
    // A convenience only.
  }
}
