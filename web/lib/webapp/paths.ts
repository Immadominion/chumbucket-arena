/**
 * Where everything lives. The web app is served under /app, so a deploy can
 * set NEXT_PUBLIC_WEB_APP_URL=/app and the landing's hero opens it.
 * The public share pages (/c, /u, /m) stay outside it: they work without an
 * account, and they are what a shared link opens.
 */

export const APP_BASE = "/app";

const enc = encodeURIComponent;
const bare = (handle: string) => handle.replace(/^@+/, "");

export const appPath = {
  home: APP_BASE,
  markets: `${APP_BASE}/markets`,
  market: (id: string) => `${APP_BASE}/m/${enc(id)}`,
  call: (id: string) => `${APP_BASE}/c/${enc(id)}`,
  person: (handle: string) => `${APP_BASE}/u/${enc(bare(handle))}`,
  me: `${APP_BASE}/me`,
  /** Settings → Sign-in methods, open on arrival: where a wallet is linked with its proof. */
  signInMethods: `${APP_BASE}/me?settings=sign-in`,
  activity: `${APP_BASE}/activity`,
  friends: `${APP_BASE}/friends`,
  leaderboard: `${APP_BASE}/leaderboard`,
} as const;

/** The public, shareable pages: what "Share" copies. */
export const publicPath = {
  receipt: (id: string) => `/c/${enc(id)}`,
  profile: (handle: string) => `/u/${enc(bare(handle))}`,
  market: (id: string) => `/m/${enc(id)}`,
} as const;

/**
 * Only paths inside the web app may be returned to after sign-in: an open
 * redirect would let a link send someone anywhere once they signed in.
 */
export function safeReturnPath(path: string | null | undefined): string {
  if (!path || !path.startsWith(APP_BASE)) return APP_BASE;
  if (path.startsWith("//") || /[\\\u0000-\u001f]/.test(path)) return APP_BASE;
  const rest = path.slice(APP_BASE.length);
  if (rest && !/^[/?#]/.test(rest)) return APP_BASE;
  return path;
}

/**
 * The screens this visit has walked through inside the web app, newest last,
 * so the top bar's Back can go back only to one of them and never off the
 * site (a call opened from a link on X has nothing in the app to go back to).
 *
 * A path change to the screen just before the current one is read as going
 * back (the browser's Back, or ours): the trail shortens. Anything else is a
 * step forward. The same path again changes nothing. Capped, so a long visit
 * cannot grow it without bound.
 */
export const TRAIL_MAX = 50;

export function nextTrail(trail: readonly string[], path: string): string[] {
  const last = trail[trail.length - 1];
  if (last === path) return [...trail];
  if (trail.length >= 2 && trail[trail.length - 2] === path) return trail.slice(0, -1);
  return [...trail, path].slice(-TRAIL_MAX);
}

/** Back has somewhere inside the app to go; otherwise it goes Home. */
export const canGoBack = (trail: readonly string[]): boolean => trail.length > 1;

/** A route segment, decoded once; a malformed escape is kept as it came. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
