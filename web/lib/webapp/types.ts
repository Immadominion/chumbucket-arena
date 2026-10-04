/**
 * The calls BFF's wire shapes the web app reads, mirrored from the BFF's own
 * `src/calls/types.ts`, `src/notifications/types.ts`,
 * `src/prediction/catalog.ts` and `src/account/store.ts`.
 *
 * Read-only copies: nothing here is a source of truth. Every timestamp is
 * unix milliseconds (UTC), and no shape carries a wallet: the BFF redacts
 * them from every social payload (a person reads their own wallet from
 * `account.me` only).
 */

export type Side = "YES" | "NO";
export type CallOutcome = "PENDING" | "CORRECT" | "INCORRECT" | "VOID";
export type MarketStatus = "OPEN" | "CLOSED_PENDING_RESOLUTION" | "RESOLVED" | "CANCELLED" | "PAUSED";
export type CallVisibility = "public" | "followers";
export type ResponseKind = "back" | "fade" | "challenge";
export type FundingState =
  | "NONE"
  | "QUOTED"
  | "SUBMITTED"
  | "FILLED"
  | "PARTIAL"
  | "FAILED"
  | "CLOSED"
  | "CLAIMABLE"
  | "CLAIMED";

/** Panta's observed unit prices: decimal strings, independent per side, never a quote. */
export interface SharePrice {
  marketId: string;
  venue: "panta";
  /** The market's own quote asset: USDC, or SOL for a SOL-quoted Panta market. Never converted. */
  currency: "USDC" | "SOL";
  unit: "per_share";
  yesPrice: string | null;
  noPrice: string | null;
  observedAt: number;
}

export interface Market {
  id: string;
  venue: string;
  venueMarketId: string;
  question: string;
  rulesText: string;
  category: string;
  outcomes: Array<{ side: Side; label: string }>;
  status: MarketStatus;
  opensAt: number | null;
  closesAt: number | null;
  resolvesAt: number | null;
  resolutionSource: string | null;
  /** The market's quote asset. Null/absent from an older BFF, which only served USDC markets. */
  quoteCurrency?: "USDC" | "SOL" | null;
  /** Whether Chumbucket can trade it. A SOL-quoted market takes free calls only. Absent: tradable. */
  tradable?: boolean;
}

/** predictions.catalog rows: a market plus Panta's own reported volume. */
export interface CatalogMarket extends Market {
  volumeUsdc: string | null;
}

export interface CatalogPage {
  markets: CatalogMarket[];
  nextCursor: string | null;
  categories: Array<{ category: string; count: number }>;
  total: number;
}

export interface Call {
  id: string;
  userId: string;
  marketId: string;
  side: Side;
  confidence: number | null;
  thesis: string | null;
  entryProbability: number | null;
  entryPrice?: SharePrice | null;
  visibility: CallVisibility;
  createdAt: number;
  lockedAt: number;
  parentCallId: string | null;
  fundingState: FundingState;
}

export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  resolution: Side | "VOID" | null;
  resolvedAt: number | null;
}

export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarId?: number | null;
  settledCalls: number;
  correctCalls: number;
  bio?: string | null;
  joinedAt?: number | null;
}

export interface CallFeedEntry {
  call: Call;
  author: Person;
  market: Market;
  result: CallResult | null;
  backCount: number;
  fadeCount: number;
  viewerHasCalled: boolean;
  funding?: { venue: string } | null;
}

export interface FeedPage {
  entries: CallFeedEntry[];
  nextCursor: string | null;
}

export interface ThesisUpdate {
  id: string;
  callId: string;
  body: string;
  createdAt: number;
}

export interface CallResponse {
  id: string;
  kind: ResponseKind;
  resultingCallId: string | null;
  createdAt: number;
}

export interface CallDetail {
  entry: CallFeedEntry;
  parent: CallFeedEntry | null;
  responses: CallResponse[];
  updates?: ThesisUpdate[];
  updatesAvailable?: boolean;
}

export interface MarketDetail {
  market: Market;
  sharePrice?: SharePrice | null;
  viewerCall: CallFeedEntry | null;
  crowdSplit: { marketId: string; yesCalls: number; noCalls: number } | null;
  callsCloseAt?: number | null;
}

export interface RecordCounts {
  correct: number;
  incorrect: number;
  voided: number;
  resolved: number;
  decided: number;
  pending: number;
}

export type RecordDisplay =
  | { mode: "counts"; correct: number; incorrect: number; decided: number; minimumDecided: number }
  | { mode: "accuracy"; accuracy: number; correct: number; incorrect: number; decided: number };

export interface PublicRecord {
  counts: RecordCounts;
  display: RecordDisplay;
}

export interface PersonDetail {
  person: Person;
  calls: CallFeedEntry[];
  viewerIsFollowing: boolean;
  followerCount: number;
  followingCount: number;
  record: PublicRecord;
}

export interface PersonCard {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarId?: number | null;
  record: PublicRecord;
  viewerIsFollowing: boolean;
}

export interface SuggestedPerson extends PersonCard {
  latestLiveCall: { callId: string; side: Side; marketId: string; question: string; closesAt: number | null } | null;
}

export interface SuggestedPeople {
  friends: SuggestedPerson[];
  people: SuggestedPerson[];
}

export interface LeaderboardRow {
  rank: number | null;
  person: Omit<PersonCard, "record" | "viewerIsFollowing">;
  record: PublicRecord;
}

export interface Leaderboard {
  window: "7d" | "30d" | "all";
  ranked: LeaderboardRow[];
  building: LeaderboardRow[];
  viewer: (LeaderboardRow & { decidedToRank: number }) | null;
  minimumDecided: number;
}

export interface PersonMatch {
  person: PersonCard;
  matchedBy: "x" | "username" | "wallet";
  xHandle: string | null;
  xAvatarUrl: string | null;
  isViewer: boolean;
}

export interface PersonLookup {
  kind: "x" | "handle" | "wallet";
  handle: string | null;
  matches: PersonMatch[];
  notOnChumbucket: { xHandle: string; xAvatarUrl: string | null } | null;
}

export type NotificationKind = "BACKED" | "FADED" | "RESOLVED" | "REMATCH";

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  rematchReason: "challenge" | "rival_called_again" | null;
  actor: { userId: string; handle: string; displayName: string; avatarUrl: string | null; avatarId: number | null } | null;
  subjectCallId: string;
  rivalCallId: string | null;
  marketId: string;
  marketQuestion: string | null;
  side: Side;
  outcome: Exclude<CallOutcome, "PENDING"> | null;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unread: number;
}

export interface OwnProfile {
  userId: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  avatarId: number | null;
  walletAddress: string | null;
}

export interface CallResponseResult {
  response: CallResponse;
  resultingCall: CallFeedEntry | null;
  invitation: { id: string } | null;
}
