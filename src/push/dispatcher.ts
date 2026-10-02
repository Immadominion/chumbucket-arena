/**
 * PushDispatcher — turns notifications the deriver JUST wrote into pushes.
 *
 * Only the deriver's fresh rows reach this, so a push can never be sent for a
 * fact that is not also in the person's inbox, and the copy is the same
 * checked template the inbox renders (`renderCopy`). Recipients are canonical
 * people; tokens are looked up by person, never by wallet.
 *
 * Best effort by design: the inbox is the record, a push is a nudge. A token
 * FCM calls dead is forgotten; anything else is dropped without retry storms.
 * With no Firebase credentials configured nothing is sent, and the server
 * says so once at boot (see `describe`).
 */

import type { AccountStore } from "../account/store.ts";
import { renderCopy } from "../notifications/copy.ts";
import type { SocialGraphReader } from "../notifications/sources.ts";
import type { SocialNotification } from "../notifications/types.ts";
import type { PushSender } from "./fcm.ts";

export interface PushDispatcherDeps {
  accounts: AccountStore;
  graph: SocialGraphReader;
  /** null when Firebase is not configured: dispatch is then a counted no-op. */
  sender: PushSender | null;
  maxAgeMs: number;
  now?: () => number;
  /**
   * Who the recipient blocked or muted, or who blocked them (src/trust). The
   * inbox never shows those people's notifications, so they are never pushed
   * either. Absent = nobody is hidden.
   */
  hiddenFor?: (recipientUserId: string) => Promise<ReadonlySet<string>>;
}

export interface DispatchReport {
  /** Fresh notifications handed in. */
  considered: number;
  /** Skipped because the event is older than maxAgeMs (a backlog, not news). */
  stale: number;
  /** Skipped because the recipient blocked or muted the actor (or was blocked by them). */
  suppressed: number;
  /** Sent to at least one device. */
  pushed: number;
  devices: number;
  forgotten: number;
  failed: number;
  /** True when no sender is configured. */
  disabled: boolean;
}

/**
 * When the thing a notification is about actually became news. For a result
 * that is when it was derived (a venue resolution synced late is still news),
 * otherwise the notification's own instant.
 */
export function triggeredAt(n: SocialNotification, graph: SocialGraphReader): number {
  if (n.kind === "RESOLVED") return graph.getResult(n.subjectCallId)?.derivedAt ?? n.createdAt;
  return n.createdAt;
}

export class PushDispatcher {
  private readonly now: () => number;

  constructor(private readonly deps: PushDispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.deps.sender !== null;
  }

  async dispatch(fresh: readonly SocialNotification[]): Promise<DispatchReport> {
    const report: DispatchReport = {
      considered: fresh.length,
      stale: 0,
      suppressed: 0,
      pushed: 0,
      devices: 0,
      forgotten: 0,
      failed: 0,
      disabled: this.deps.sender === null,
    };
    const sender = this.deps.sender;
    if (!sender) return report;
    const cutoff = this.now() - this.deps.maxAgeMs;

    for (const n of fresh) {
      if (triggeredAt(n, this.deps.graph) < cutoff) {
        report.stale++;
        continue;
      }
      if (n.actorUserId && this.deps.hiddenFor) {
        let hidden: ReadonlySet<string>;
        try {
          hidden = await this.deps.hiddenFor(n.recipientUserId);
        } catch {
          hidden = new Set();
        }
        if (hidden.has(n.actorUserId)) {
          report.suppressed++;
          continue;
        }
      }
      let tokens;
      try {
        tokens = await this.deps.accounts.pushTokensFor(n.recipientUserId);
      } catch {
        report.failed++;
        continue;
      }
      if (tokens.length === 0) continue;

      const actor = n.actorUserId ? this.deps.graph.getPerson(n.actorUserId) : undefined;
      const copy = renderCopy(n, actor?.displayName ?? null);
      const data: Record<string, string> = {
        type: "call_notification",
        notification_id: n.id,
        kind: n.kind,
        call_id: n.subjectCallId,
        ...(n.rivalCallId ? { rival_call_id: n.rivalCallId } : {}),
      };

      let delivered = false;
      for (const t of tokens) {
        const outcome = await sender.send(t.token, { title: copy.title, body: copy.body, data });
        if (outcome === "ok") {
          delivered = true;
          report.devices++;
        } else if (outcome === "unregistered") {
          report.forgotten++;
          await this.deps.accounts.forgetPushToken(t.token).catch(() => undefined);
        } else {
          report.failed++;
        }
      }
      if (delivered) report.pushed++;
    }
    return report;
  }
}
