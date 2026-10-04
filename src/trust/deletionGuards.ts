/**
 * The one place to add a check that must pass before an account is deleted.
 *
 * `auth.deleteAccount` is the only deletion entry point (any sign-in that
 * reaches the account may use it; the database then deletes the whole
 * person: the account, every account folded into it, every additional
 * sign-in). Before anything is written, TrustService.deleteAccount runs every
 * guard listed here, in order. A guard refuses by throwing a TrustError whose
 * message is the line the person sees ("Cash out first", …); it must not
 * write anything.
 *
 * Add a guard by importing your module's check and appending it below. The
 * wallet workstream adds "cash out first" for app-held wallet balances.
 */

export interface DeletionSubject {
  /** The canonical account about to be deleted. */
  userId: string;
  /** The verified sign-in asking. */
  authUserId: string;
}

export type AccountDeletionGuard = (subject: DeletionSubject) => Promise<void>;

export const accountDeletionGuards: AccountDeletionGuard[] = [];
