"use client";

/**
 * Signed transfers on their way (a cash out, a top-up from your wallet), one
 * per account and kind, held outside React so closing a sheet never forgets
 * one: until the chain decides (or the BFF refuses it), the same signed bytes
 * are pushed through `stepTransfer` every few seconds, and the sheets show it
 * instead of a form. Nothing new is prepared or signed while one is open.
 */

import { useSyncExternalStore } from "react";
import { stepTransfer, transferOpen, type MoneyFlowApi, type TransferRun } from "@/lib/webapp/moneyFlow";

const STEP_MS = 3_000;

const runs = new Map<string, TransferRun>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const stepping = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const transferKey = (userId: string, kind: "cash_out" | "deposit") => `${userId}:${kind}`;

function stop(key: string) {
  const t = timers.get(key);
  if (t) clearInterval(t);
  timers.delete(key);
}

async function step(key: string, api: Pick<MoneyFlowApi, "transferSubmit" | "transferStatus">) {
  const run = runs.get(key);
  if (!run || !transferOpen(run)) return stop(key);
  if (stepping.has(key)) return;
  stepping.add(key);
  try {
    const next = await stepTransfer(api, run);
    // Only the run this step was for (a newer one may have replaced it).
    if (runs.get(key)?.transferId !== run.transferId) return;
    runs.set(key, next);
    emit();
    if (!transferOpen(next)) stop(key);
  } finally {
    stepping.delete(key);
  }
}

/** Start pushing a freshly signed transfer: the first step submits it now. */
export function startTransferRun(key: string, api: Pick<MoneyFlowApi, "transferSubmit" | "transferStatus">, run: TransferRun) {
  if (transferOpen(runs.get(key))) return; // one in flight at a time
  stop(key);
  runs.set(key, run);
  emit();
  void step(key, api);
  timers.set(key, setInterval(() => void step(key, api), STEP_MS));
}

/** Forget a run once its outcome is known (Done). An open run is never dropped. */
export function clearTransferRun(key: string) {
  if (transferOpen(runs.get(key))) return;
  runs.delete(key);
  emit();
}

export function useTransferRun(key: string): TransferRun | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => runs.get(key) ?? null,
    () => null,
  );
}
