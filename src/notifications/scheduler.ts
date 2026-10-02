/**
 * The notification deriver on a timer, off the request path (M3, M4), and
 * server-side push for what each pass newly derives.
 *
 * Before this, notifications were derived only when somebody opened their own
 * inbox, so a call being backed, faded, resolved or rematched reached nobody
 * until they happened to look — and nothing was ever pushed. Now:
 *
 *   every tick  -> one incremental `deriver.runOnce()` (cheap: only recent rows)
 *               -> the rows it WROTE go to the push dispatcher
 *   inbox reads -> pure reads (`rt.scheduled` turns derive-on-read off)
 *
 * Ticks never overlap; a failed tick is logged by code and the next one tries
 * again. With no Firebase credentials the deriver still runs and pushes are a
 * counted no-op, announced once at start.
 */

import type { AppConfig } from "../config.ts";
import { accountRuntimeFor } from "../account/runtime.ts";
import { PushDispatcher, type DispatchReport } from "../push/dispatcher.ts";
import { notificationsRuntimeFor, type NotificationsRuntime } from "./runtime.ts";
import type { DeriveReport } from "./NotificationDeriver.ts";

export interface SchedulerTick {
  derive: DeriveReport;
  push: DispatchReport;
}

export interface NotificationScheduler {
  /** Run one pass now (also what the timer calls). Never overlaps itself. */
  tick(): Promise<SchedulerTick | null>;
  stop(): void;
  readonly dispatcher: PushDispatcher;
}

export interface SchedulerOptions {
  tickMs?: number;
  /** Injected by tests; built from the account runtime otherwise. */
  dispatcher?: PushDispatcher;
  runtime?: NotificationsRuntime;
  /** false = no timer (tests drive `tick()` themselves). */
  timer?: boolean;
  log?: (line: string) => void;
}

export function startNotificationScheduler(appConfig: AppConfig, opts: SchedulerOptions = {}): NotificationScheduler {
  const rt = opts.runtime ?? notificationsRuntimeFor(appConfig);
  const log = opts.log ?? ((line: string) => console.log(line));
  const account = accountRuntimeFor(appConfig);
  const dispatcher =
    opts.dispatcher ??
    new PushDispatcher({
      accounts: account.store,
      graph: rt.graph,
      sender: account.sender,
      maxAgeMs: account.push.maxAgeMs,
    });
  rt.scheduled = true;
  if (!dispatcher.enabled) {
    log(`[push] disabled: ${account.push.enabled ? "no sender" : account.push.reason}. Notifications still reach the inbox.`);
  } else {
    log("[push] FCM HTTP v1 sender configured");
  }

  let running = false;
  const tick = async (): Promise<SchedulerTick | null> => {
    if (running) return null;
    running = true;
    try {
      await rt.ready();
      const derive = rt.deriver.runOnce();
      const push = await dispatcher.dispatch(derive.fresh);
      if (derive.created > 0 || push.devices > 0 || push.failed > 0) {
        log(
          `[notifications] ${JSON.stringify({
            created: derive.created,
            byKind: derive.createdByKind,
            truncated: derive.truncated,
            fullScan: derive.fullScan,
            pushed: push.pushed,
            devices: push.devices,
            stale: push.stale,
            forgotten: push.forgotten,
            failed: push.failed,
          })}`,
        );
      }
      return { derive, push };
    } catch (err) {
      // Never a body, a token or a row: a code is enough to find it.
      log(`[notifications] tick failed: ${err instanceof Error ? err.name : "unknown"}`);
      return null;
    } finally {
      running = false;
    }
  };

  const tickMs = Math.max(1_000, opts.tickMs ?? 20_000);
  const handle = opts.timer === false ? null : setInterval(() => void tick(), tickMs);
  if (handle && typeof handle === "object" && "unref" in handle) (handle as { unref(): void }).unref();
  if (opts.timer !== false) void tick();

  return {
    tick,
    dispatcher,
    stop() {
      if (handle) clearInterval(handle);
      rt.scheduled = false;
    },
  };
}
