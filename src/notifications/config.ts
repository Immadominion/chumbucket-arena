/**
 * Packet F configuration.
 *
 * Read through `ctx.app.config` (contracts §6). `AppConfig` is
 * integration-owned, so this packet cannot add a `notifications` block to
 * `src/config.ts`; the exact patch is filed at
 * docs/contracts/integration-requests/packet-f.md. Until it lands, the resolver
 * falls back to the environment and then to defaults, which keeps the packet
 * buildable and testable without editing a file it does not own.
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE
 *
 * The accuracy threshold. `MIN_DECIDED_FOR_ACCURACY` lives in `record.ts` as a
 * constant and is not readable from here, from the environment, or from
 * `AppConfig`. A server that can be configured to report "100% accurate" off a
 * single decided call is a server that eventually will be, and statistical
 * honesty is a product requirement rather than an operational knob.
 *
 * The copy is not configurable either, for the same reason: the set of
 * sentences this product can send is the frozen table in `copy.ts`, checked
 * against the §0 rules at import.
 */

import type { AppConfig } from "../config.ts";

export interface NotificationsConfigInput {
  /** §7 `call_receipt_experience` — the free social loop this inbox belongs to. */
  callReceiptExperience?: boolean;
  /** Bound on one inbox page. */
  maxPageSize?: number;
  /** Bound on one derivation pass. */
  maxPerPass?: number;
  /**
   * Run one derivation pass before serving an inbox read.
   *
   * On by default, so the packet delivers notifications with NO integration
   * patch applied: a pull-to-refresh is a legitimate trigger for an idempotent,
   * bounded pass, exactly as it is for Packet D's resolution sync. When the
   * integration owner schedules `deriver.runOnce()` on a timer (see
   * docs/contracts/integration-requests/packet-f.md) this can be turned off and
   * the reads become pure.
   */
  deriveOnRead?: boolean;
}

/** The structural extension of AppConfig this packet reads. Additive, optional. */
export interface NotificationsAppConfig {
  notifications?: NotificationsConfigInput;
}

export interface NotificationsConfig {
  flags: { callReceiptExperience: boolean; deriveOnRead: boolean };
  maxPageSize: number;
  maxPerPass: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "on";
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(n)));

export function resolveNotificationsConfig(
  appConfig: AppConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): NotificationsConfig {
  const fromApp = (appConfig as (AppConfig & NotificationsAppConfig) | undefined)?.notifications;

  return {
    flags: {
      // §7: `call_receipt_experience` defaults ON — it IS the free social loop.
      callReceiptExperience:
        fromApp?.callReceiptExperience ?? bool(env.CALL_RECEIPT_EXPERIENCE, true),
      deriveOnRead: fromApp?.deriveOnRead ?? bool(env.NOTIFICATIONS_DERIVE_ON_READ, true),
    },
    maxPageSize: clamp(fromApp?.maxPageSize ?? num(env.NOTIFICATIONS_MAX_PAGE_SIZE, 50), 1, 100),
    maxPerPass: clamp(fromApp?.maxPerPass ?? num(env.NOTIFICATIONS_MAX_PER_PASS, 500), 1, 10_000),
  };
}

/** The ONLY shape of this config that may appear in a response body or a log. */
export function describeNotificationsConfig(cfg: NotificationsConfig): {
  callReceiptExperience: boolean;
  deriveOnRead: boolean;
  maxPageSize: number;
} {
  return {
    callReceiptExperience: cfg.flags.callReceiptExperience,
    deriveOnRead: cfg.flags.deriveOnRead,
    maxPageSize: cfg.maxPageSize,
  };
}

/** Attach a notifications block to an AppConfig without editing src/config.ts. */
export function withNotificationsConfig(
  base: AppConfig,
  notifications: NotificationsConfigInput,
): AppConfig {
  return Object.assign({}, base, { notifications }) as AppConfig;
}
