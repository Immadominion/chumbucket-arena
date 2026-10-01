/**
 * Packet F's mount on the root router.
 *
 * The inbox is mounted under `inbox`, not `notifications`, because the root
 * already has a legacy `notifications` procedure (wallet-keyed, called by apps
 * already installed). These tests pin both halves of that decision: the new
 * paths are reachable on the ROOT router, and the legacy procedures are still
 * there, unchanged in name.
 */

import { describe, expect, test } from "bun:test";
import { socialNotificationsRouter, socialRecordRouter } from "../src/api/notifications.ts";
import { appRouter } from "../src/api/router.ts";
import { router } from "../src/api/trpc.ts";

const pathsOf = (r: { _def: { procedures: Record<string, unknown> } }): string[] =>
  Object.keys(r._def.procedures).sort();

const root = (): string[] => Object.keys(appRouter._def.procedures as Record<string, unknown>);

describe("Packet F is mounted as inbox.* and record.*", () => {
  test("the mount yields exactly the five session-scoped paths", () => {
    const patched = router({ inbox: socialNotificationsRouter, record: socialRecordRouter });
    expect(pathsOf(patched)).toEqual([
      "inbox.list",
      "inbox.markRead",
      "inbox.unreadCount",
      "record.get",
      "record.mine",
    ]);
  });

  test("every Packet F path is reachable on the ROOT router", () => {
    const paths = root();
    for (const path of ["inbox.list", "inbox.unreadCount", "inbox.markRead", "record.mine", "record.get"]) {
      expect(paths).toContain(path);
    }
    expect(paths).not.toContain("inbox");
    expect(paths).not.toContain("record");
  });

  test("the legacy wallet inbox keeps its root names, so installed apps keep working", () => {
    const paths = root();
    for (const legacy of ["notifications", "unreadCount", "markNotificationsRead"]) {
      expect(paths).toContain(legacy);
    }
    expect(paths.some((p) => p.startsWith("notifications."))).toBe(false);
  });

  test("nothing else on the root surface moved", () => {
    const paths = root();
    expect(paths).toContain("health");
    for (const ns of ["auth.", "predictions.", "pantaTrading.", "calls.", "markets.", "people."]) {
      expect(paths.some((p) => p.startsWith(ns))).toBe(true);
    }
  });
});
