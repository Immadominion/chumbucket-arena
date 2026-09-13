/**
 * The narrow view of Packet D that Packet F is allowed to hold.
 *
 * Packet F never writes a call, a response or a result, and it never derives an
 * outcome. `SocialGraphReader` has no method capable of doing any of those: it
 * reads the rows Packet D owns and nothing else, which is what keeps §0.2 true
 * — the venue is the only source of a result, Packet D's `ResolutionSync` is the
 * only thing that turns venue evidence into a `CallResult`, and this packet only
 * ever reports what that produced.
 *
 * It is a port rather than a direct dependency for the same reason Packet D
 * made `VenueMarketReader` one: `src/calls/**` is read, never edited (§6), and a
 * port composed from its public interface needs no change there — today or when
 * the SQL-backed store replaces the in-memory one.
 */

import type { CallsStore } from "../calls/store.ts";
import type { CallRecord, CallResponseRecord, CallResult, Person } from "../calls/types.ts";

export type { CallRecord, CallResponseRecord, CallResult, Person };

export interface SocialGraphReader {
  listCalls(): CallRecord[];
  getCall(callId: string): CallRecord | undefined;
  callsByAuthor(userId: string): CallRecord[];
  listResponses(): CallResponseRecord[];
  /** The venue-derived outcome, or undefined when Packet D has not materialised
   *  one yet. Never computed here. */
  getResult(callId: string): CallResult | undefined;
  getPerson(userId: string): Person | undefined;
  getPersonByHandle(handle: string): Person | undefined;
  listPeople(): Person[];
  isFollowing(followerUserId: string, followeeUserId: string): boolean;
}

/** Read Packet D's store as a `SocialGraphReader`. Public interface only. */
export function callsStoreReader(store: CallsStore): SocialGraphReader {
  return {
    listCalls: () => store.listCalls(),
    getCall: (callId) => store.getCall(callId),
    callsByAuthor: (userId) => store.callsByAuthor(userId),
    listResponses: () => store.listResponses(),
    getResult: (callId) => store.getResult(callId),
    getPerson: (userId) => store.getPerson(userId),
    getPersonByHandle: (handle) => store.getPersonByHandle(handle),
    listPeople: () => store.listPeople(),
    isFollowing: (a, b) => store.isFollowing(a, b),
  };
}

/** An empty reader — a server with no social data yet. Never invents. */
export const emptySocialGraphReader: SocialGraphReader = {
  listCalls: () => [],
  getCall: () => undefined,
  callsByAuthor: () => [],
  listResponses: () => [],
  getResult: () => undefined,
  getPerson: () => undefined,
  getPersonByHandle: () => undefined,
  listPeople: () => [],
  isFollowing: () => false,
};

/**
 * Can `viewerUserId` see this call? The same three rules `public.calls` has
 * policies for, and the same three `CallsService.canSee` applies:
 * public -> anyone; followers -> the author or a follower; hidden -> the author.
 *
 * It matters here because a REMATCH points at somebody else's NEW call, and a
 * notification about a `followers`-only call the recipient may not read would
 * leak exactly what `calls_followers_select` withholds.
 */
export function canSee(
  graph: SocialGraphReader,
  call: CallRecord,
  viewerUserId: string | null,
): boolean {
  if (call.userId === viewerUserId) return true;
  if (call.hiddenAt !== null) return false;
  if (call.visibility === "public") return true;
  if (!viewerUserId) return false;
  return graph.isFollowing(viewerUserId, call.userId);
}
