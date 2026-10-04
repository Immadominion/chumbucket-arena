/**
 * Packet A error vocabulary.
 *
 * Every rejection in the identity/wallet-proof path has its OWN code. That is
 * not cosmetic: "the nonce was replayed", "the nonce expired" and "the nonce
 * belongs to someone else" are three different security events, and collapsing
 * them into one opaque 400 makes them indistinguishable in tests, in logs, and
 * in an incident.
 *
 * These codes are deliberately NOT DomainErrorCodes. src/domain/** is
 * integration-owned (contract §6) and its codes are about game rules, not about
 * identity infrastructure. Mapping to the transport happens once, in
 * src/api/authRoutes.ts.
 *
 * A code never carries a secret. No nonce plaintext, signature, JWT, key or
 * email ever reaches a message field — see `safeDetail`.
 */

export type AuthIdentityErrorCode =
  // ── session ──────────────────────────────────────────────────────────────
  | "AUTH_TOKEN_MISSING"
  | "AUTH_TOKEN_INVALID"
  /** Valid Supabase session, but no public.users row carries that auth_user_id. */
  | "AUTH_USER_UNLINKED"
  /** More than one canonical row claims the same auth.uid() — must be impossible
   *  (users_auth_user_id_key is UNIQUE). Refuse rather than pick one. */
  | "AUTH_USER_AMBIGUOUS"
  /** No Supabase project configured on this server. */
  | "IDENTITY_NOT_CONFIGURED"
  | "ACCOUNT_CLAIMS_DISABLED"
  | "ACCOUNT_CLAIM_UNAVAILABLE"
  | "ACCOUNT_CLAIM_CONFLICT"
  | "ACCOUNT_CLAIM_RATE_LIMITED"

  // ── SIWS message shape and bindings ──────────────────────────────────────
  | "SIWS_MALFORMED_MESSAGE"
  | "SIWS_UNSUPPORTED_VERSION"
  | "SIWS_DOMAIN_NOT_ALLOWED"
  | "SIWS_URI_NOT_ALLOWED"
  | "SIWS_DOMAIN_MISMATCH"
  | "SIWS_URI_MISMATCH"
  | "SIWS_NETWORK_MISMATCH"
  | "SIWS_ADDRESS_MISMATCH"
  | "SIWS_STATEMENT_MISMATCH"
  | "SIWS_PURPOSE_MISMATCH"
  | "SIWS_BAD_SIGNATURE"

  // ── nonce lifecycle ──────────────────────────────────────────────────────
  | "NONCE_UNKNOWN"
  | "NONCE_REUSED"
  | "NONCE_EXPIRED"
  /** Issued to a different canonical user (wallet link) or auth subject (claim). */
  | "NONCE_USER_MISMATCH"
  | "NONCE_ISSUE_FAILED"

  // ── wallet ownership ─────────────────────────────────────────────────────
  | "WALLET_OWNED_BY_ANOTHER_USER"
  | "WALLET_REQUIRES_TRANSFER"
  | "WALLET_LINK_FAILED"

  // ── legacy identity claims ───────────────────────────────────────────────
  | "LEGACY_EVIDENCE_UNVERIFIED"
  | "LEGACY_CLAIMED_BY_ANOTHER_USER"
  | "LEGACY_CLAIM_FAILED"

  // ── infrastructure ───────────────────────────────────────────────────────
  | "IDENTITY_STORE_ERROR"
  // ── usernames / new accounts ──
  | "USERNAME_INVALID"
  | "USERNAME_RESERVED"
  | "USERNAME_TAKEN"
  | "PROFILE_NAME_INVALID"
  /** The signed-in wallet already has an account; it is carried, never duplicated. */
  | "WALLET_HAS_PROFILE"
  /** The account already has a @username; claiming one never renames it. */
  | "HANDLE_ALREADY_SET"

  // ── one account, many sign-ins ──
  /** Linking sign-ins is switched off on this server (ACCOUNT_LINKING_ENABLED). */
  | "ACCOUNT_LINKING_DISABLED"
  /** Folding another account in is switched off (ACCOUNT_FOLD_ENABLED). */
  | "ACCOUNT_FOLD_DISABLED"
  /** The link ticket is unknown, used, superseded or expired. */
  | "LINK_TICKET_INVALID"
  /** The other side signed in with a different method than the link asked for. */
  | "LINK_METHOD_MISMATCH"
  | "LINK_RATE_LIMITED"
  /** The other account has funded activity or money; it is never folded. */
  | "ACCOUNT_HAS_MONEY"
  /** The other account was already folded, or was deleted. */
  | "ACCOUNT_NOT_FOLDABLE"
  /** The sign-in you are using, or the account's own first one, can't be unlinked. */
  | "SIGN_IN_IN_USE"
  | "SIGN_IN_NOT_FOUND"
  /** Only the other account's own first sign-in can fold it. */
  | "FOLD_NEEDS_PRIMARY_SIGN_IN"
  /** Both accounts have a legacy wallet; neither is orphaned to fold. */
  | "FOLD_WALLET_CONFLICT"
  /** What the person was shown changed before they confirmed. */
  | "LINK_PREVIEW_CHANGED";

export class AuthIdentityError extends Error {
  readonly code: AuthIdentityErrorCode;
  readonly detail?: string;

  constructor(code: AuthIdentityErrorCode, detail?: string) {
    // The message IS the code, so a caller that only sees `err.message` still
    // gets the machine-readable reason and never a leaked value.
    super(code);
    this.name = "AuthIdentityError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** Declared as a function (not a const arrow) so TypeScript's control-flow
 *  analysis treats a call as unreachable-after and narrows for the caller. */
export function failAuth(code: AuthIdentityErrorCode, detail?: string): never {
  throw new AuthIdentityError(code, detail);
}

/**
 * Map a reason string returned by one of the SQL functions onto a code.
 * Unknown reasons deliberately fall through to a generic code rather than being
 * echoed: a future SQL reason must not become an unreviewed client-facing
 * string.
 */
export function codeForStoreReason(
  reason: string | undefined,
  fallback: AuthIdentityErrorCode,
): AuthIdentityErrorCode {
  switch (reason) {
    case "nonce_unknown":
      return "NONCE_UNKNOWN";
    case "nonce_reused":
      return "NONCE_REUSED";
    case "nonce_expired":
      return "NONCE_EXPIRED";
    case "nonce_user_mismatch":
      return "NONCE_USER_MISMATCH";
    case "nonce_address_mismatch":
      return "SIWS_ADDRESS_MISMATCH";
    case "nonce_domain_mismatch":
      return "SIWS_DOMAIN_MISMATCH";
    case "nonce_uri_mismatch":
      return "SIWS_URI_MISMATCH";
    case "nonce_network_mismatch":
      return "SIWS_NETWORK_MISMATCH";
    case "nonce_purpose_mismatch":
      return "SIWS_PURPOSE_MISMATCH";
    case "wallet_owned_by_another_user":
      return "WALLET_OWNED_BY_ANOTHER_USER";
    case "wallet_requires_transfer":
      return "WALLET_REQUIRES_TRANSFER";
    case "claimed_by_another_user":
      return "LEGACY_CLAIMED_BY_ANOTHER_USER";
    case "unverified_evidence":
      return "LEGACY_EVIDENCE_UNVERIFIED";
    case "linking_disabled":
      return "ACCOUNT_LINKING_DISABLED";
    case "fold_disabled":
      return "ACCOUNT_FOLD_DISABLED";
    case "ticket_unknown":
    case "ticket_used":
    case "ticket_expired":
      return "LINK_TICKET_INVALID";
    case "method_mismatch":
      return "LINK_METHOD_MISMATCH";
    case "has_money":
      return "ACCOUNT_HAS_MONEY";
    case "already_folded":
    case "same_account":
    case "money_unverifiable":
      return "ACCOUNT_NOT_FOLDABLE";
    case "not_primary_sign_in":
      return "FOLD_NEEDS_PRIMARY_SIGN_IN";
    case "wallet_conflict":
      return "FOLD_WALLET_CONFLICT";
    case "preview_changed":
    case "proof_changed":
      return "LINK_PREVIEW_CHANGED";
    case "current_sign_in":
    case "primary_sign_in":
      return "SIGN_IN_IN_USE";
    case "not_found":
      return "SIGN_IN_NOT_FOUND";
    default:
      return fallback;
  }
}
