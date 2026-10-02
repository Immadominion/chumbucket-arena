/**
 * The chumbucket.fun share pages (web/): the BFF reader they render from and
 * the Digital Asset Links file Android verifies (audit B4). The pages
 * themselves are proven by `next build` in CI; these pin the logic under them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ANDROID_PACKAGE, RELEASE_CERT_SHA256, assetLinks, normaliseFingerprint } from "../web/lib/assetLinks.ts";
import {
  CALLS_BFF_URL,
  NotFound,
  Unavailable,
  centsLabel,
  getCall,
  getPerson,
  outcomeCopy,
  recordLabel,
  safeAvatar,
  venueUrl,
  type Market,
} from "../web/lib/callsBff.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  return seen;
}

describe("assetlinks.json", () => {
  test("names the app and the dApp Store-pinned certificate", () => {
    const [entry] = assetLinks("");
    expect(entry!.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(entry!.target.package_name).toBe("dev.cleva.chumbucket");
    expect(ANDROID_PACKAGE).toBe("dev.cleva.chumbucket");
    // publishing/config.yaml cert_fingerprint in the mobile repo, colon form.
    expect(entry!.target.sha256_cert_fingerprints).toEqual([
      "31:5B:22:C7:FE:1C:28:5E:AE:7A:99:15:62:90:37:FC:8E:C3:23:9F:ED:34:7A:73:49:57:DC:25:08:50:E1:C7",
    ]);
    expect(normaliseFingerprint("315b22c7fe1c285eae7a9915629037fc8ec3239fed347a734957dc250850e1c7")).toBe(
      RELEASE_CERT_SHA256,
    );
  });

  test("ANDROID_CERT_SHA256 adds certificates; junk is ignored", () => {
    const extra = "aa".repeat(32);
    const fps = assetLinks(`${extra}, not-a-fingerprint, ${RELEASE_CERT_SHA256}`)[0]!.target.sha256_cert_fingerprints;
    expect(fps).toHaveLength(2);
    expect(fps[1]).toBe(Array(32).fill("AA").join(":"));
  });
});

describe("the BFF reader", () => {
  test("queries the public tRPC GET shape and unwraps the result", async () => {
    const seen = stubFetch(() => Response.json({ result: { data: { json: { entry: { call: { id: "c1" } } } } } }));
    const detail = await getCall("c1");
    expect((detail.entry as { call: { id: string } }).call.id).toBe("c1");
    expect(seen[0]).toBe(
      `${CALLS_BFF_URL}/calls.get?input=${encodeURIComponent(JSON.stringify({ json: { callId: "c1" } }))}`,
    );
  });

  test("a person ref loses its @ and is never a wallet field", async () => {
    const seen = stubFetch(() => Response.json({ result: { data: { json: { person: {}, calls: [] } } } }));
    await getPerson("@ada");
    expect(decodeURIComponent(seen[0]!)).toContain('{"json":{"personRef":"ada"}}');
  });

  test("NOT_FOUND and BAD_REQUEST are a missing page; anything else is unavailable", async () => {
    stubFetch(() => Response.json({ error: { json: { data: { code: "NOT_FOUND" } } } }, { status: 404 }));
    await expect(getCall("x")).rejects.toBeInstanceOf(NotFound);
    stubFetch(() => Response.json({ error: { json: { data: { code: "BAD_REQUEST" } } } }, { status: 400 }));
    await expect(getCall("x")).rejects.toBeInstanceOf(NotFound);
    stubFetch(() => Response.json({ error: { json: { data: { code: "INTERNAL_SERVER_ERROR" } } } }, { status: 500 }));
    await expect(getCall("x")).rejects.toBeInstanceOf(Unavailable);
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(getCall("x")).rejects.toBeInstanceOf(Unavailable);
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(getCall("x")).rejects.toBeInstanceOf(Unavailable);
  });
});

describe("presentation", () => {
  test("prices read as cents below a dollar and dollars above; junk is null", () => {
    expect(centsLabel("0.5")).toBe("50¢");
    expect(centsLabel("0.521")).toBe("52.1¢");
    expect(centsLabel("0.05")).toBe("5¢");
    expect(centsLabel("1.2")).toBe("$1.20");
    expect(centsLabel(null)).toBeNull();
    expect(centsLabel("")).toBeNull();
    expect(centsLabel("-1")).toBeNull();
    expect(centsLabel("abc")).toBeNull();
  });

  test("outcomes and records", () => {
    expect(outcomeCopy(null).tone).toBe("pending");
    expect(outcomeCopy({ callId: "c", outcome: "CORRECT", resolution: "YES", resolvedAt: 1 }).label).toBe("Correct");
    expect(outcomeCopy({ callId: "c", outcome: "INCORRECT", resolution: "NO", resolvedAt: 1 }).tone).toBe("lost");
    const base = { id: "u", handle: "a", displayName: "A", avatarUrl: null };
    expect(recordLabel({ ...base, settledCalls: 0, correctCalls: 0 })).toBe("No settled calls yet");
    expect(recordLabel({ ...base, settledCalls: 4, correctCalls: 3 })).toBe("3 of 4 settled calls right");
  });

  test("only https avatars render", () => {
    expect(safeAvatar("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(safeAvatar("http://cdn.example/a.png")).toBeNull();
    expect(safeAvatar("javascript:alert(1)")).toBeNull();
    expect(safeAvatar(null)).toBeNull();
  });

  test("the venue link is Panta's public page, not the authenticated API", () => {
    const m = { venue: "panta", venueMarketId: "pqZAm6T9" } as Market;
    expect(venueUrl(m)).toBe("https://panta.market/market/pqZAm6T9");
    expect(venueUrl({ ...m, venue: "other" })).toBeNull();
  });
});
