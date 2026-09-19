/**
 * A credential must never travel in a URL.
 *
 * tRPC derives the HTTP method from the procedure type: a `.query` is a GET,
 * and a GET carries its `input` in the QUERY STRING. So any procedure that
 * takes a token as input and is declared a query puts that token in the
 * request URL — and from there into the server's access log, the proxy's log,
 * the browser history, and any Referer header the page later sends.
 *
 * `auth.whoami` shipped that way and was caught only when a client refused to
 * call it. This asserts the rule for EVERY procedure rather than for that one,
 * so the next token-taking route cannot reintroduce it by being written the
 * obvious way.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";

/** Input fields that mean "this is a credential". */
const CREDENTIAL_FIELDS = [
  "supabaseaccesstoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "jwt",
  "apikey",
  "api_key",
  "secret",
  "password",
  "signature",
  "bearer",
  "sessiontoken",
];

type Proc = {
  _def?: {
    type?: string;
    inputs?: unknown[];
  };
};

/** Field names a procedure's zod input accepts, lower-cased. */
function inputFieldsOf(proc: Proc): string[] {
  const inputs = proc._def?.inputs ?? [];
  const names: string[] = [];
  for (const input of inputs) {
    const shape = (input as { _def?: { shape?: unknown } })?._def?.shape;
    const resolved = typeof shape === "function" ? shape() : shape;
    if (resolved && typeof resolved === "object") {
      names.push(...Object.keys(resolved as Record<string, unknown>).map((k) => k.toLowerCase()));
    }
  }
  return names;
}

const procedures = Object.entries(appRouter._def.procedures as Record<string, Proc>);

describe("no procedure takes a credential over GET", () => {
  test("the introspection this test depends on still works", () => {
    // If tRPC's internals change shape, every assertion below would pass
    // vacuously. Prove we can still see types and input fields at all.
    expect(procedures.length).toBeGreaterThan(20);
    const types = new Set(procedures.map(([, p]) => p._def?.type));
    expect(types.has("query")).toBe(true);
    expect(types.has("mutation")).toBe(true);

    const withInputs = procedures.filter(([, p]) => inputFieldsOf(p).length > 0);
    expect(withInputs.length).toBeGreaterThan(5);
  });

  test("every credential-taking procedure is a mutation, so the value goes in the body", () => {
    const offenders: string[] = [];
    for (const [path, proc] of procedures) {
      if (proc._def?.type !== "query") continue;
      const credentials = inputFieldsOf(proc).filter((f) =>
        CREDENTIAL_FIELDS.some((c) => f.includes(c)),
      );
      if (credentials.length) offenders.push(`${path} (${credentials.join(", ")})`);
    }

    expect(offenders).toEqual([]);
  });

  test("auth.whoami specifically — it regressed once", () => {
    const whoami = (appRouter._def.procedures as Record<string, Proc>)["auth.whoami"];
    expect(whoami).toBeDefined();
    expect(whoami?._def?.type).toBe("mutation");
    expect(inputFieldsOf(whoami!)).toContain("supabaseaccesstoken");
  });

  test("the other token-taking auth routes are mutations too", () => {
    for (const path of ["auth.requestWalletNonce", "auth.linkWallet", "auth.claimLegacyIdentity"]) {
      const proc = (appRouter._def.procedures as Record<string, Proc>)[path];
      expect(proc, `${path} should exist`).toBeDefined();
      expect(proc?._def?.type, `${path} must not be a query`).toBe("mutation");
    }
  });
});
