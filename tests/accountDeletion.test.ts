/**
 * auth.deleteAccount with many sign-ins: the one deletion entry point.
 *
 * Any sign-in that reaches the account deletes the whole person; the guards
 * other workstreams register run first and can refuse; every sign-in the
 * database names (delete_account_v2) is removed from Supabase Auth, the one
 * asking last, and a retry from any of them finishes the job. The SQL
 * (which accounts and sign-ins go) is proven in accountSignIns.postgres.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { accountDeletionGuards, type AccountDeletionGuard } from "../src/trust/deletionGuards.ts";
import { TrustError } from "../src/trust/errors.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin, type DeleteAccountOutcome } from "../src/trust/store.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { harness, person, testApp } from "./socialCallsFixtures.ts";

/** Answers as delete_account_v2 does: the person's every sign-in, and the
 *  accounts folded into theirs. */
class WholePersonStore extends InMemoryTrustStore {
  calls: { userId: string | null; authUserId: string }[] = [];
  override async deleteAccount(input: { userId: string | null; authUserId: string }, at: number): Promise<DeleteAccountOutcome> {
    this.calls.push(input);
    const done = await super.deleteAccount(input, at);
    return done.ok && input.userId === "u-ann"
      ? { ...done, authUserIds: ["auth-ann", "auth-ann-x"], foldedUserIds: ["u-folded"] }
      : done;
  }
}

async function scene(guards?: readonly AccountDeletionGuard[]) {
  const h = harness({ people: [person("u-ann"), person("u-folded")], markets: [] });
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const store = new WholePersonStore();
  const authAdmin = new RecordingAuthUserAdmin();
  setTrustRuntime(app.config, buildTrustRuntime(app.config, { store, authAdmin, ...(guards ? { deletionGuards: guards } : {}) }));
  // auth-ann-x is an additional sign-in of u-ann (a folded account's X).
  const identity = new FakeIdentityStore().addUser("auth-ann", "u-ann").addUser("auth-ann-x", "u-ann");
  const verifier = new FakeJwtVerifier().issue("tok-ann", "auth-ann").issue("tok-ann-x", "auth-ann-x");
  primeAuthIdentityRuntime(app.config, { store: identity, verifier, policy: resolveAuthIdentityPolicy(app.config) });
  return { h, store, authAdmin, account: (token: string) => authRouter.createCaller({ app, supabaseAccessToken: token }) };
}

describe("deleting an account with many sign-ins", () => {
  test("any sign-in deletes the whole person; every sign-in goes, the asker last", async () => {
    const s = await scene();
    const done = await s.account("tok-ann-x").deleteAccount({ confirm: "DELETE" });
    expect(done).toMatchObject({ status: "deleted", userId: "u-ann" });
    expect(s.store.calls).toEqual([{ userId: "u-ann", authUserId: "auth-ann-x" }]);
    expect(s.authAdmin.deleted).toEqual(["auth-ann", "auth-ann-x"]);
    // The account folded into it is gone from the directory too.
    expect(s.h.rt.store.getPerson("u-folded")?.displayName).toBe("Deleted account");
    expect(s.h.rt.store.getPerson("u-ann")?.displayName).toBe("Deleted account");
  });

  test("a guard runs first and can refuse; nothing is written", async () => {
    const seen: string[] = [];
    const s = await scene([
      async ({ userId, authUserId }) => {
        seen.push(`${userId}/${authUserId}`);
        throw new TrustError("TRUST_DELETION_FAILED", "Cash out first.");
      },
    ]);
    await expect(s.account("tok-ann").deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ message: "Cash out first." });
    expect(seen).toEqual(["u-ann/auth-ann"]);
    expect(s.store.calls).toEqual([]);
    expect(s.authAdmin.deleted).toEqual([]);
  });

  test("the registry other workstreams add to is the default", async () => {
    expect(Array.isArray(accountDeletionGuards)).toBe(true);
    accountDeletionGuards.push(async () => {
      throw new TrustError("TRUST_DELETION_FAILED", "Not yet.");
    });
    try {
      const s = await scene();
      await expect(s.account("tok-ann").deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ message: "Not yet." });
    } finally {
      accountDeletionGuards.pop();
    }
  });
});
