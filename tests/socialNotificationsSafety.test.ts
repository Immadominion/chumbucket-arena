/**
 * The notification safety guard.
 *
 * `safety.ts` is the module that decides what may reach a person's device, and
 * it shipped without a test. That is exactly backwards: a rule you can only
 * read in a comment is not a control, and this module exists precisely because
 * the schema cannot hold these rules — the wire shape is assembled in
 * TypeScript, and a view model is easy to widen by accident.
 *
 * So this file asserts the guard REFUSES things, which is the only direction
 * that matters. A guard that accepts everything passes every happy-path test.
 */

import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_COPY,
  assertCopySafe,
  assertNotificationSafe,
  safeDisplayName,
} from "../src/notifications/safety.ts";
import { COPY_TEMPLATES } from "../src/notifications/copy.ts";
import {
  isNotificationsError,
  type NotificationsErrorCode,
} from "../src/notifications/errors.ts";

const refuses = (fn: () => void, code: NotificationsErrorCode) => {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(isNotificationsError(thrown)).toBe(true);
  if (isNotificationsError(thrown)) expect(thrown.code).toBe(code);
  return thrown;
};

const unsafePayload = (fn: () => void) => refuses(fn, "NOTIFICATION_UNSAFE_PAYLOAD");

describe("assertNotificationSafe — money", () => {
  test("a money-shaped field is refused, sharing one definition with receipts", () => {
    for (const key of ["amount", "stakeBaseUnits", "payout", "balance", "escrow"]) {
      unsafePayload(() => assertNotificationSafe({ [key]: 1 }, "payload"));
    }
  });
});

describe("assertNotificationSafe — keys that must never appear", () => {
  const cases: Array<[string, unknown]> = [
    ["secret", "x"],
    ["apiKey", "x"],
    ["api_key", "x"],
    ["jwt", "x"],
    ["bearer", "x"],
    ["credential", "x"],
    ["privateKey", "x"],
    ["seed", "x"],
    ["mnemonic", "x"],
    ["nonce", "x"],
    ["thesis", "any words at all"],
    ["note", "any words at all"],
    ["pnl", 1],
  ];

  for (const [key, value] of cases) {
    test(`"${key}" is refused`, () => {
      unsafePayload(() => assertNotificationSafe({ [key]: value }, "payload"));
    });
  }

  test("a thesis is refused even when it is empty — the field is the violation", () => {
    unsafePayload(() => assertNotificationSafe({ thesis: "" }, "payload"));
  });

  test("it is refused however deeply it is nested", () => {
    unsafePayload(() =>
      assertNotificationSafe({ data: { meta: { inner: { thesis: "hi" } } } }, "payload"),
    );
  });

  test("it is refused inside an array — the way a list of rows smuggles one in", () => {
    unsafePayload(() =>
      assertNotificationSafe({ rows: [{ ok: 1 }, { secret: "x" }] }, "payload"),
    );
  });

  test("the error names the offending path, so it can be found", () => {
    const e = unsafePayload(() =>
      assertNotificationSafe({ data: { rows: [{ thesis: "x" }] } }, "payload"),
    );
    if (isNotificationsError(e)) {
      expect(String(e.details?.field)).toContain("thesis");
    }
  });
});

describe("assertNotificationSafe — values that are credential-shaped whatever they are called", () => {
  test("a JWT under an innocent key", () => {
    const jwt = `ey${"A".repeat(20)}.${"B".repeat(20)}.${"C".repeat(20)}`;
    unsafePayload(() => assertNotificationSafe({ title: jwt }, "payload"));
  });

  test("a base58 blob long enough to be a signature or a secret key", () => {
    const base58 = "5".repeat(90);
    unsafePayload(() => assertNotificationSafe({ title: base58 }, "payload"));
  });

  test("a hex blob long enough to be a key or a raw signature", () => {
    unsafePayload(() => assertNotificationSafe({ title: "a1b2c3d4".repeat(9) }, "payload"));
  });

  test("but an ordinary sentence with an id in it is allowed", () => {
    expect(() =>
      assertNotificationSafe(
        { title: "Ada faded your call", callId: "call_ada_btc_120k" },
        "payload",
      ),
    ).not.toThrow();
  });
});

describe("assertNotificationSafe — text the recipient must not be pushed", () => {
  test("their own thesis, reproduced under any key, is refused", () => {
    const thesis = "Funding has been negative for three days running.";
    unsafePayload(() =>
      assertNotificationSafe({ body: `They said: ${thesis}` }, "payload", {
        forbiddenText: [thesis],
      }),
    );
  });

  test("a short forbidden string is ignored, so a common word cannot break every inbox", () => {
    expect(() =>
      assertNotificationSafe({ body: "Ada called YES" }, "payload", {
        forbiddenText: ["YES"],
      }),
    ).not.toThrow();
  });
});

describe("assertNotificationSafe — what a real notification looks like", () => {
  test("a complete, legitimate payload passes", () => {
    expect(() =>
      assertNotificationSafe(
        {
          id: "ntf_01",
          kind: "FADED",
          title: "Ada faded your call",
          body: "They took the other side. See how it settles.",
          callId: "call_01",
          marketId: "mkt_01",
          actorUserId: "0f2a6f1e-1c3a-4a1e-9a2b-7c6d5e4f3a2b",
          createdAt: 1_789_000_000_000,
          readAt: null,
        },
        "payload",
      ),
    ).not.toThrow();
  });
});

describe("assertCopySafe — every rule refuses, and each for its own reason", () => {
  const violations: Array<[string, string]> = [
    ["urgency", "Hurry — this closes soon"],
    ["crowd pressure", "Everyone is calling YES on this"],
    ["a percentage", "Your accuracy is 62% this month"],
    ["N people", "14 people faded you"],
    ["betting language", "Your bet settled"],
    ["a money figure", "You are up 12.5 SOL"],
    ["a credential word", "Check your wallet balance"],
  ];

  for (const [why, text] of violations) {
    test(`refuses ${why}`, () => {
      refuses(() => assertCopySafe(text, "copy"), "NOTIFICATION_UNSAFE_COPY");
    });
  }

  test("the error quotes what matched, so the fix is obvious", () => {
    let thrown: unknown;
    try {
      assertCopySafe("Everyone is fading you", "copy");
    } catch (e) {
      thrown = e;
    }
    if (isNotificationsError(thrown)) {
      expect(String(thrown.details?.matched).toLowerCase()).toBe("everyone");
    }
  });

  test("a percentage is caught in the % form, not just the word form", () => {
    // Regression: the rule was /\b\d+\s*(%|percent)\b/i. `%` is a non-word
    // character, so the trailing \b could never match after it — every "62%"
    // slipped through while "62 percent" was caught.
    for (const text of ["100%", "up 12%!", "a 7% move", "Your accuracy is 62% this month"]) {
      refuses(() => assertCopySafe(text, "copy"), "NOTIFICATION_UNSAFE_COPY");
    }
  });

  test("but a number that is not a percentage is left alone", () => {
    for (const text of ["Your call resolved", "resolution published", "Ada called YES"]) {
      expect(() => assertCopySafe(text, "copy")).not.toThrow();
    }
  });

  test("ordinary relational copy passes", () => {
    for (const text of [
      "Ada backed your call",
      "Your call resolved",
      "Zed wants a rematch",
      "They took the other side. See how it settles.",
    ]) {
      expect(() => assertCopySafe(text, "copy")).not.toThrow();
    }
  });

  test("every rule is documented with a reason — a bare regex is unreviewable", () => {
    expect(FORBIDDEN_COPY.length).toBeGreaterThan(0);
    for (const { rule, why } of FORBIDDEN_COPY) {
      expect(rule).toBeInstanceOf(RegExp);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe("the copy that actually ships obeys its own rules", () => {
  test("every template in COPY_TEMPLATES passes assertCopySafe", () => {
    const templates = Object.entries(COPY_TEMPLATES);
    expect(templates.length).toBeGreaterThan(0);
    for (const [key, template] of templates) {
      for (const [field, value] of Object.entries(template)) {
        if (typeof value !== "string") continue;
        expect(() => assertCopySafe(value, `${key}.${field}`)).not.toThrow();
      }
    }
  });
});

describe("safeDisplayName — a name is made safe, never rejected", () => {
  test("a bidi override cannot reflow the sentence it is spliced into", () => {
    const evil = "Ada‮gnihtemos‬";
    const safe = safeDisplayName(evil);
    expect(safe).not.toContain("‮");
    expect(safe).not.toContain("‬");
  });

  test("control characters and zero-width joiners are stripped", () => {
    expect(safeDisplayName("A d​a")).toBe("Ada");
  });

  test("a newline cannot forge a second line of notification copy", () => {
    const safe = safeDisplayName("Ada\nYour call resolved");
    expect(safe).not.toContain("\n");
  });

  test("whitespace is collapsed", () => {
    expect(safeDisplayName("  Ada    Lovelace  ")).toBe("Ada Lovelace");
  });

  test("length is bounded, with an ellipsis rather than a hard cut", () => {
    const safe = safeDisplayName("A".repeat(200));
    expect(safe.length).toBeLessThanOrEqual(40);
    expect(safe.endsWith("…")).toBe(true);
  });

  test("an unusable name falls back instead of breaking the inbox", () => {
    expect(safeDisplayName("")).toBe("Someone");
    expect(safeDisplayName("   ")).toBe("Someone");
    expect(safeDisplayName(" ​")).toBe("Someone");
    expect(safeDisplayName("", "A caller")).toBe("A caller");
  });

  test("it never throws, whatever it is handed", () => {
    for (const name of ["", " ", "‮", "x".repeat(5000), "🙂🙂🙂"]) {
      expect(() => safeDisplayName(name)).not.toThrow();
    }
  });

  test("a sanitised name still passes the payload guard", () => {
    expect(() =>
      assertNotificationSafe({ title: `${safeDisplayName("Ada")} backed your call` }, "payload"),
    ).not.toThrow();
  });
});
