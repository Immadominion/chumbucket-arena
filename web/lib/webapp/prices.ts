/**
 * When a lock meets a lapsed Panta price.
 *
 * The BFF refuses a call whose market has no fresh price ("Panta prices are
 * missing or stale. Refresh before locking your call."). That sentence is an
 * internal state and never reaches a person. Instead the web app does what
 * the Android app does: re-read the market (the BFF's worker keeps pricing it)
 * and try the lock once more. Only if the price is still not there does the
 * person see one quiet line, and nothing on screen calls the price stale.
 *
 * Pure (no DOM), so the BFF repo's bun tests pin it.
 */

/** The BFF's refusal for a lapsed price (CallsService.lockCall). */
export const PRICE_REFUSAL = /prices are missing or stale/i;

/** What a person sees if the price is still updating after one re-read. */
export const PRICE_UPDATING = "Prices are updating. Try again in a moment.";

export function isPriceRefusal(error: unknown): boolean {
  return error instanceof Error && PRICE_REFUSAL.test(error.message);
}

/**
 * Run `attempt`; if the BFF refuses it for a lapsed price, run `refresh` (re-read
 * the market) and attempt exactly once more. Any other failure, and a second
 * refusal, are thrown to the caller as they came.
 */
export async function retryAfterPriceRefresh<T>(attempt: () => Promise<T>, refresh: () => Promise<unknown>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isPriceRefusal(error)) throw error;
    try {
      await refresh();
    } catch {
      // A failed re-read still deserves the second attempt: the BFF decides.
    }
    return attempt();
  }
}
