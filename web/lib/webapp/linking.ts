/**
 * One account, many sign-ins — the shapes `auth.signInMethods` and the link
 * procedures answer with, and their refusals as one short line each.
 *
 * Linking X or Google to the account you are in is Supabase's own manual
 * identity linking. When Supabase can't (the X/Google is already on another
 * sign-in, or the wallet already signs in somewhere), the account issues a
 * ticket and the other side proves itself with its own sign-in, made only for
 * that, in a separate window: the session here never changes.
 *
 * Pure: the browser plumbing lives in components/webapp/linking.ts.
 */

export type MethodKind = "wallet" | "x" | "google";
export type LinkMethod = MethodKind;

export interface SignInMethodRow {
  id: string;
  kind: MethodKind;
  /** X username (no @), Google email, or wallet address. */
  label: string | null;
  current: boolean;
  unlink: { mode: "native"; identityId: string } | { mode: "server"; ref: string } | null;
  alsoUnlinks: MethodKind[];
}

export interface SignInMethods {
  methods: SignInMethodRow[];
  linking: boolean;
  fold: boolean;
}

export interface LinkTicket {
  ticket: string;
  method: LinkMethod;
  expiresAt: string;
}

export interface AccountSummary {
  userId: string;
  handle: string | null;
  displayName: string | null;
}

export interface LinkPreview {
  outcome: "already" | "link" | "fold";
  into: AccountSummary;
  from: AccountSummary | null;
  refusal: "ACCOUNT_HAS_MONEY" | "ACCOUNT_FOLD_DISABLED" | null;
}

export const KINDS: readonly MethodKind[] = ["wallet", "x", "google"];

export const KIND_NAME: Record<MethodKind, string> = { wallet: "Wallet", x: "X", google: "Google" };

/** Where an OAuth proof window lands: inside /app, so the redirect allow-list already covers it. */
export const LINK_CALLBACK_PATH = "/app/link";
/** The channel the proof window answers on (BroadcastChannel survives a provider's opener policy). */
export const LINK_CHANNEL = "cb-sign-in-link";
/** Remembered across the linkIdentity round trip, to say what came back. */
export const LINKING_KEY = "cb.app.linking";

/** What a row shows: "@name", the email, or a short wallet. */
export function methodLabel(row: Pick<SignInMethodRow, "kind" | "label">): string {
  if (!row.label) return KIND_NAME[row.kind];
  if (row.kind === "x") return `@${row.label}`;
  if (row.kind === "wallet") return row.label.length > 12 ? `${row.label.slice(0, 4)}…${row.label.slice(-4)}` : row.label;
  return row.label;
}

export function accountName(a: AccountSummary | null): string {
  if (!a) return "";
  return a.handle ? `@${a.handle}` : a.displayName ?? "another account";
}

/** Link and unlink refusals (the BFF's codes, and Supabase's), one short line each. */
export function linkCopy(code: string): string {
  switch (code) {
    case "ACCOUNT_LINKING_DISABLED":
    case "manual_linking_disabled":
      return "Linking isn’t on yet.";
    case "ACCOUNT_FOLD_DISABLED":
      return "Moving accounts isn’t on yet.";
    case "ACCOUNT_HAS_MONEY":
      return "It has trades, so it stays separate. Sign in to it and link from there.";
    case "ACCOUNT_NOT_FOLDABLE":
      return "That account can’t be moved.";
    case "LINK_TICKET_INVALID":
      return "That took too long. Try again.";
    case "LINK_METHOD_MISMATCH":
      return "That was a different sign-in. Try again.";
    case "LINK_RATE_LIMITED":
      return "Too many tries. Wait a minute.";
    case "SIGN_IN_IN_USE":
      return "You’re signed in with that one.";
    case "SIGN_IN_NOT_FOUND":
      return "Already unlinked.";
    case "WALLET_OWNED_BY_ANOTHER_USER":
    case "WALLET_REQUIRES_TRANSFER":
      return "That wallet is on another account.";
    case "identity_already_exists":
      return "That one is on another account.";
    case "single_identity_not_deletable":
      return "It’s your only way in.";
    case "cancelled":
      return "Nothing changed.";
    case "popup":
      return "Allow pop-ups to continue.";
    default:
      return "That didn’t work. Try again.";
  }
}
