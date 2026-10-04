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
 * Add a guard by importing your module's check and appending it below. A
 * guard is registered as a builder of the app's config (its readers come
 * from that config); src/trust/runtime.ts builds the list once per app.
 */

import type { AppConfig } from "../config.ts";
import { cashOutFirst } from "../wallet/deletionGuard.ts";

export interface DeletionSubject {
  /** The canonical account about to be deleted. */
  userId: string;
  /** The verified sign-in asking. */
  authUserId: string;
}

export type AccountDeletionGuard = (subject: DeletionSubject) => Promise<void>;

/** A registered guard: built for one app's config. */
export type RegisteredDeletionGuard = (config: AppConfig) => AccountDeletionGuard;

export const accountDeletionGuards: RegisteredDeletionGuard[] = [
  // The wallet workstream: never strand money in the Chumbucket wallet
  // ("Cash out first"); anything unreadable refuses.
  cashOutFirst,
];

/** The registry, in order, built for this app. */
export function deletionGuardsFor(config: AppConfig): AccountDeletionGuard[] {
  return accountDeletionGuards.map((register) => register(config));
}
