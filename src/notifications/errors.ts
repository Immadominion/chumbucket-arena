/**
 * Packet F failures.
 *
 * Deliberately separate from `src/domain/errors.ts` (integration-owned) and
 * from `src/calls/errors.ts` (Packet D's rules about calls). These are the
 * rules of the notification and record layer, and the split keeps a packet from
 * having to edit a file it does not own to add a code.
 *
 * The mapping to transport codes lives in `src/api/notifications.ts`; this file
 * owns the codes.
 */

export type NotificationsErrorCode =
  // ── signed out / not this user ──
  /** No credential at all on a surface that needs one. */
  | "NOTIFICATIONS_SIGNED_OUT"
  /** A credential that resolves to no canonical public.users.id (§0.3). */
  | "NOTIFICATIONS_USER_UNLINKED"

  // ── refusals ──
  | "NOTIFICATION_NOT_FOUND"
  /** Marking someone else's notification read. */
  | "NOTIFICATION_NOT_YOURS"
  | "PERSON_NOT_FOUND"

  // ── invariants that must never be reachable from a route ──
  /** A notification about the recipient's own action. */
  | "NOTIFICATION_SELF"
  /** A notification whose subject call the recipient did not write. */
  | "NOTIFICATION_NOT_ABOUT_OWN_CALL"
  /** A shape that no kind allows (e.g. RESOLVED carrying an actor). */
  | "NOTIFICATION_SHAPE_INVALID"
  /** A payload carrying money, a secret, a signature or a thesis. */
  | "NOTIFICATION_UNSAFE_PAYLOAD"
  /** Copy that breaks the product rules in §0 (urgency, crowd pressure, money). */
  | "NOTIFICATION_UNSAFE_COPY"
  /** Counts whose arithmetic does not close — a record missing its misses. */
  | "RECORD_INCOMPLETE"
  /** A client tried to write a notification or a record. Service-derived only. */
  | "SERVICE_WRITE_ONLY";

/** Codes the client must render as "sign in", not as "something went wrong". */
const SIGNED_OUT: ReadonlySet<NotificationsErrorCode> = new Set<NotificationsErrorCode>([
  "NOTIFICATIONS_SIGNED_OUT",
  "NOTIFICATIONS_USER_UNLINKED",
]);

/** Codes that are an understood, legitimate refusal. */
const REJECTED: ReadonlySet<NotificationsErrorCode> = new Set<NotificationsErrorCode>([
  "NOTIFICATION_NOT_FOUND",
  "NOTIFICATION_NOT_YOURS",
  "PERSON_NOT_FOUND",
]);

export interface NotificationsErrorInit {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class NotificationsError extends Error {
  readonly code: NotificationsErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: NotificationsErrorCode, message: string, init: NotificationsErrorInit = {}) {
    super(message);
    this.name = "NotificationsError";
    this.code = code;
    this.details = init.details;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  get signedOut(): boolean {
    return SIGNED_OUT.has(this.code);
  }

  get rejected(): boolean {
    return REJECTED.has(this.code);
  }
}

export const isNotificationsError = (e: unknown): e is NotificationsError =>
  e instanceof NotificationsError;
