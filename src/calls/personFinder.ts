/**
 * people.find — "is this them?" before adding a friend.
 *
 * Adding a friend is a follow of a real Chumbucket person, and the app shows
 * who that person is BEFORE anything is written: their picture, name,
 * @username, X handle and public record. This module answers the lookup.
 *
 * WHAT A PERSON CAN TYPE
 *
 *   an X profile link   x.com/name, twitter.com/name (www., mobile., http(s))
 *                       -> X accounts only
 *   @name or name       -> both: an X account with that username (1–15
 *                          characters) AND a Chumbucket @username (3–20)
 *   a Solana wallet     -> the real person holding it (never a placeholder)
 *
 * A .skr name is resolved to its wallet on the phone (AllDomains, as before)
 * and arrives here as a wallet.
 *
 * WHAT COMES BACK
 *
 *   matches            people, most likely first: an X match (they signed in
 *                      with that X account), then the @username, then the
 *                      wallet. At most three — normally one. Each carries
 *                      the same PersonCard (record included) people lists
 *                      show, their X handle and X picture when known, and
 *                      whether it is the viewer.
 *   notOnChumbucket    only when nobody matched and the query can be an X
 *                      handle: that handle, and its public X picture when one
 *                      could be found (src/calls/xAvatars.ts), so the app can
 *                      say "not on Chumbucket yet" and offer an invite.
 *
 * WHAT IT NEVER DOES
 *
 *   - write anything: no pending friend, no placeholder, no follow;
 *   - put a wallet, an email or a provider subject in the answer (a wallet
 *     query is answered with a person and is not echoed);
 *   - guess: if a lookup cannot run (the database or its functions are
 *     unavailable), the whole answer fails rather than claim nobody matched.
 *
 * Blocks are enforced where they bite: people.follow refuses a blocked pair
 * with its own message. Profiles are public (people.get), so hiding a card
 * here would protect nothing.
 */

import { isUsableSolanaAddress } from "../auth/SolanaKey.ts";
import { isSolanaAddress } from "../auth/WalletLinkService.ts";
import type { Clock } from "../prediction/clock.ts";
import { isDeletedAccount, type PeopleDirectory } from "./people.ts";
import type { CallsStore } from "./store.ts";
import type { Person, PersonLookup, PersonLookupKind, PersonMatch, PersonMatchedBy } from "./types.ts";
import { X_HANDLE, type XAvatarLookup } from "./xAvatars.ts";

// ── identities ───────────────────────────────────────────────────────────────

/** One person's X account, as Supabase Auth (or the old link flow) recorded it. */
export interface XIdentity {
  userId: string;
  /** Their X username, without @, as X spells it. */
  xHandle: string;
  /** Already passed through `safeXAvatarUrl`. */
  xAvatarUrl: string | null;
  /** unix ms they were last seen signing in with it, when known. */
  seenAt: number | null;
}

/**
 * Who holds an X account or a wallet. Every method throws when it cannot
 * answer, so "unknown" is never mistaken for "nobody".
 */
export interface PersonIdentityReader {
  /** People whose X account has this username (lowercase, no @), most recently seen first. */
  byXHandle(handle: string): Promise<XIdentity[]>;
  /** The X account of each of these people that has one (at most 50 ids). */
  xIdentitiesOf(userIds: readonly string[]): Promise<XIdentity[]>;
  /** The real person (not a placeholder, not deleted) holding this wallet, or null. */
  personForWallet(wallet: string): Promise<string | null>;
}

/**
 * The in-memory answer: nobody has signed in with X here, and a wallet is
 * whatever the person directory says. Used by tests and a server with no
 * database.
 */
export function directoryIdentityReader(store: CallsStore): PersonIdentityReader {
  return {
    async byXHandle() {
      return [];
    },
    async xIdentitiesOf() {
      return [];
    },
    async personForWallet(wallet) {
      return store.getPersonByWallet(wallet)?.id ?? null;
    },
  };
}

// ── parsing ──────────────────────────────────────────────────────────────────

export interface FindQuery {
  kind: PersonLookupKind;
  /** Lowercase, no @. Set when the query can be an X username. */
  xHandle: string | null;
  /** Lowercase, no @. Set when the query can be a Chumbucket @username. */
  username: string | null;
  wallet: string | null;
}

/** Chumbucket usernames: handle_status_v1's rule (3–20 of a–z 0–9 _). */
const USERNAME = /^[a-z0-9_]{3,20}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
/** X paths that are pages, not people. */
const X_RESERVED = new Set([
  "home", "explore", "search", "i", "intent", "settings", "messages", "notifications",
  "compose", "hashtag", "share", "login", "logout", "signup", "tos", "privacy", "about",
]);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_X_LINK = /^(?:www\.|mobile\.)?(?:x|twitter)\.com(?:[/?#]|$)/i;

/** undefined: not a link. null: a link, but not to an X profile. */
function xHandleFromLink(value: string): string | null | undefined {
  if (!SCHEME.test(value) && !BARE_X_LINK.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(SCHEME.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  // x.com/name, x.com/name/status/123 (a post's author) — the first segment.
  const first = url.pathname.split("/").filter(Boolean)[0];
  if (!first || X_RESERVED.has(first.toLowerCase()) || !X_HANDLE.test(first)) return null;
  return first.toLowerCase();
}

/** What a typed query can mean, or null when it is none of them. */
export function parseFindQuery(raw: string): FindQuery | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 200) return null;
  if (isSolanaAddress(value) && isUsableSolanaAddress(value)) {
    return { kind: "wallet", xHandle: null, username: null, wallet: value };
  }
  const fromLink = xHandleFromLink(value);
  if (fromLink !== undefined) {
    return fromLink === null ? null : { kind: "x", xHandle: fromLink, username: null, wallet: null };
  }
  const bare = value.replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,20}$/.test(bare)) return null;
  const lower = bare.toLowerCase();
  const xHandle = X_HANDLE.test(bare) ? lower : null;
  const username = USERNAME.test(lower) ? lower : null;
  if (xHandle === null && username === null) return null;
  return { kind: "handle", xHandle, username, wallet: null };
}

export const FIND_QUERY_COPY = "Enter their X handle, Chumbucket @username or Solana wallet.";

// ── the lookup ───────────────────────────────────────────────────────────────

/** Normally one; a stale X sign-in or a username someone else holds can add more. */
export const MAX_MATCHES = 3;

export interface PersonFinderDeps {
  store: CallsStore;
  people: PeopleDirectory;
  identities: PersonIdentityReader;
  xAvatars: XAvatarLookup;
  clock: Clock;
  /**
   * Read one person the mirror has not seen yet — an account made after boot.
   * Resolves when done (found or not); throws when the read failed.
   */
  refreshById?: (userId: string) => Promise<void>;
  /** The same, for a @username. */
  refreshByHandle?: (handle: string) => Promise<void>;
}

export async function findPerson(
  deps: PersonFinderDeps,
  query: FindQuery,
  viewerUserId: string,
): Promise<PersonLookup> {
  const order: { id: string; matchedBy: PersonMatchedBy; x: XIdentity | null }[] = [];
  const add = (id: string, matchedBy: PersonMatchedBy, x: XIdentity | null): void => {
    if (!order.some((c) => c.id === id)) order.push({ id, matchedBy, x });
  };

  const [byX, walletOwner] = await Promise.all([
    query.xHandle ? deps.identities.byXHandle(query.xHandle) : Promise.resolve([] as XIdentity[]),
    query.wallet ? deps.identities.personForWallet(query.wallet) : Promise.resolve(null),
  ]);
  for (const x of byX) add(x.userId, "x", x);

  if (query.username) {
    const byHandle = (): Person | undefined => {
      const p = deps.store.getPersonByHandle(query.username!);
      return p && p.handle.replace(/^@/, "").toLowerCase() === query.username ? p : undefined;
    };
    let person = byHandle();
    if (!person && deps.refreshByHandle) {
      await deps.refreshByHandle(query.username);
      person = byHandle();
    }
    if (person) add(person.id, "username", null);
  }
  if (walletOwner) add(walletOwner, "wallet", null);

  const found: { person: Person; matchedBy: PersonMatchedBy; x: XIdentity | null }[] = [];
  for (const candidate of order) {
    if (found.length >= MAX_MATCHES) break;
    let person = deps.store.getPerson(candidate.id);
    if (!person && deps.refreshById) {
      await deps.refreshById(candidate.id);
      person = deps.store.getPerson(candidate.id);
    }
    if (!person || isDeletedAccount(person)) continue;
    found.push({ person, matchedBy: candidate.matchedBy, x: candidate.x });
  }

  // The X account of anyone found by @username or wallet, for their picture.
  const withoutX = found.filter((f) => f.x === null).map((f) => f.person.id);
  if (withoutX.length > 0) {
    const xs = new Map((await deps.identities.xIdentitiesOf(withoutX)).map((x) => [x.userId, x]));
    for (const f of found) f.x ??= xs.get(f.person.id) ?? null;
  }

  const matches: PersonMatch[] = found.map((f) => ({
    person: deps.people.card(f.person, viewerUserId),
    matchedBy: f.matchedBy,
    xHandle: f.x?.xHandle ?? null,
    xAvatarUrl: f.x?.xAvatarUrl ?? null,
    isViewer: f.person.id === viewerUserId,
  }));

  return {
    kind: query.kind,
    handle: query.xHandle ?? query.username,
    matches,
    notOnChumbucket:
      matches.length === 0 && query.xHandle !== null
        ? { xHandle: query.xHandle, xAvatarUrl: await deps.xAvatars.avatarFor(query.xHandle) }
        : null,
    servedAt: deps.clock.now(),
  };
}
