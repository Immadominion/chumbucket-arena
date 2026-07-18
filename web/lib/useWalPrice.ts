"use client";

/**
 * USDC→USD "price" for display estimates (deposit/withdraw modals). USDC is a
 * USD stablecoin, so this is a fixed 1:1 — no live price feed needed (unlike
 * the old WAL-denominated ledger, which had a real, volatile token price).
 * Kept as a hook so callers don't need to change shape.
 */

export function useWalPrice(): number | null {
  return 1;
}
