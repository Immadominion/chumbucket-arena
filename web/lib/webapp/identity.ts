/**
 * The account rules the web app shares with the Android app: what a
 * @username may be, how one is suggested from a Google or X profile, and
 * what each identity refusal says. Pure, tested in the BFF repo.
 */

/** The BFF's `handle_status_v1` format: 3–20 of a–z, 0–9 and underscore. */
export const USERNAME_FORMAT = /^[a-z0-9_]{3,20}$/;

export function normaliseUsername(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * A starting @username from what the sign-in provider said (an X username, a
 * Google name). A hint only: the person can change it, and the BFF decides
 * whether it is free.
 */
export function suggestUsername(hints: { xUsername?: string | null; name?: string | null; email?: string | null }): string {
  const candidates = [
    hints.xUsername,
    hints.name?.replace(/\s+/g, "_"),
    hints.email?.split("@")[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    const cleaned = c
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 20);
    if (USERNAME_FORMAT.test(cleaned)) return cleaned;
  }
  return "";
}

/** The provider's display-name hint (Google `full_name`/`name`, X `name`). */
export function nameHint(meta: Record<string, unknown> | null | undefined): string {
  for (const key of ["full_name", "name", "user_name", "preferred_username"]) {
    const v = meta?.[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
  }
  return "";
}

/** The provider's X username hint (Supabase puts it in `user_name` / `preferred_username`). */
export function xUsernameHint(meta: Record<string, unknown> | null | undefined, provider: string | null | undefined): string | null {
  if (provider !== "x" && provider !== "twitter") return null;
  for (const key of ["user_name", "preferred_username"]) {
    const v = meta?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Identity refusals (the BFF's auth codes) as one short line each. */
export function identityCopy(code: string): string {
  switch (code) {
    case "USERNAME_TAKEN":
      return "That username is taken.";
    case "USERNAME_INVALID":
      return "3–20 letters, numbers or _.";
    case "USERNAME_RESERVED":
      return "That username isn’t available.";
    case "PROFILE_NAME_INVALID":
      return "Use a name we can show.";
    case "HANDLE_ALREADY_SET":
      return "Your account already has a username.";
    case "AUTH_TOKEN_INVALID":
    case "AUTH_TOKEN_MISSING":
      return "Your sign-in ended. Sign in again.";
    case "IDENTITY_NOT_CONFIGURED":
      return "Accounts are paused right now. Try again soon.";
    default:
      return "Couldn’t reach Chumbucket. Try again.";
  }
}

/** Wallet sign-in failures, in the app's words (onboarding_copy.dart). */
export const WALLET_COPY = {
  none: "No Solana wallet in this browser. Use Google or X, or add a wallet.",
  declined: "Nothing was signed. Try again, or use Google or X.",
  refused: "That signature wasn’t accepted. Try again.",
  disabled: "Wallet sign-in is paused. Use Google or X.",
  network: "Couldn’t reach Chumbucket. Check your connection and try again.",
} as const;
