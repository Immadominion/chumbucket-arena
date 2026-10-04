/**
 * The chumbucket.fun share pages (web/): the BFF reader they render from and
 * the Digital Asset Links file Android verifies (audit B4). The pages
 * themselves are proven by `next build` in CI; these pin the logic under them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANDROID_PACKAGE, RELEASE_CERT_SHA256, assetLinks, normaliseFingerprint } from "../web/lib/assetLinks.ts";
import {
  CALLS_BFF_URL,
  NotFound,
  Unavailable,
  callMark,
  entryPercent,
  getCall,
  getPerson,
  isFreeCall,
  outcomeCopy,
  pairPercent,
  percentLabel,
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
  test("a price reads as a whole percent, half-up on the decimal string; junk is null", () => {
    expect(percentLabel("0.5")).toBe("50%");
    expect(percentLabel("0.62")).toBe("62%");
    expect(percentLabel("0.625")).toBe("63%");
    expect(percentLabel("0.6249")).toBe("62%");
    expect(percentLabel("0.005")).toBe("1%");
    expect(percentLabel("0.05")).toBe("5%");
    // An open market never reads as certain either way.
    expect(percentLabel("0.0049")).toBe("<1%");
    expect(percentLabel("0.000000001")).toBe("<1%");
    expect(percentLabel("0.9949")).toBe("99%");
    expect(percentLabel("0.995")).toBe(">99%");
    expect(percentLabel("0")).toBe("0%");
    expect(percentLabel("1")).toBe("100%");
    expect(percentLabel("1.000")).toBe("100%");
    for (const bad of [null, undefined, "", "-1", "abc", "1.2", "2", "1e-3", "0.5%"]) expect(percentLabel(bad)).toBeNull();
  });

  test("a market's two sides read as percents that add up: YES = yes / (yes + no)", () => {
    expect(pairPercent("0.62", "0.43")).toEqual({ yes: "59%", no: "41%" });
    expect(pairPercent("1.25", "0.35")).toEqual({ yes: "78%", no: "22%" });
    expect(pairPercent("0.625", "0.375")).toEqual({ yes: "63%", no: "37%" });
    expect(pairPercent("0.671739755", "0.328260245")).toEqual({ yes: "67%", no: "33%" });
    expect(pairPercent("0.004", "0.996")).toEqual({ yes: "<1%", no: ">99%" });
    expect(pairPercent("0.996", "0.004")).toEqual({ yes: ">99%", no: "<1%" });
    expect(pairPercent("1", "0")).toEqual({ yes: "100%", no: "0%" });
    // One side missing reads alone; none, or both zero, reads null.
    expect(pairPercent("0.62", null)).toEqual({ yes: "62%", no: null });
    expect(pairPercent(null, "0.43")).toEqual({ yes: null, no: "43%" });
    expect(pairPercent("1.25", null)).toEqual({ yes: null, no: null });
    expect(pairPercent(null, undefined)).toEqual({ yes: null, no: null });
    expect(pairPercent("0", "0")).toEqual({ yes: null, no: null });
  });

  test("a SOL-quoted call reads as the same percent: the program's price is the 0..1 figure", () => {
    // PantaProgram: last_yes_price / 1e9 for YES, its complement for NO.
    const entryPrice = { venue: "panta", currency: "SOL", unit: "per_share",
      yesPrice: "0.671739755", noPrice: "0.328260245", observedAt: 1, attribution: "Powered by Panta" };
    expect(entryPercent({ side: "NO", entryPrice })).toBe("33%");
    expect(entryPercent({ side: "YES", entryPrice })).toBe("67%");
    expect(entryPercent({ side: "YES", entryPrice: { ...entryPrice, currency: "USDC" } })).toBe("67%");
    expect(entryPercent({ side: "YES", entryPrice: null })).toBeNull();
    expect(entryPercent({ side: "NO", entryPrice })).not.toMatch(/[$¢]|SOL|USDC/);
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

describe("honesty of the receipt", () => {
  test("Free only for an unfunded call, Funded only for a confirmed fill", () => {
    expect(callMark({ call: { fundingState: "NONE" } })).toBe("free");
    expect(callMark({ call: { fundingState: "NONE" }, funding: null })).toBe("free");
    expect(callMark({ call: { fundingState: "NONE" }, funding: { state: "FILLED", venue: "panta" } })).toBe("funded");
    expect(callMark({ call: { fundingState: "FILLED" } })).toBe("funded");
    for (const state of ["QUOTED", "SUBMITTED", "PARTIAL", "FAILED"]) expect(callMark({ call: { fundingState: state } })).toBeNull();
  });

  test("the receipt, its link preview and its title carry the percent and the mark, never cents or a share price", () => {
    const web = join(import.meta.dir, "../web");
    const strip = (p: string) => readFileSync(join(web, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const receipt = strip("components/public/CallReceipt.tsx");
    expect(receipt).toContain("<FreeMark />");
    expect(receipt).toContain("<FundedMark />");
    expect(receipt.match(/<CallMark entry=\{entry\} \/>/g)?.length).toBe(2); // the receipt and the row
    const shell = strip("components/public/PublicShell.tsx");
    expect(shell).toMatch(/export function FreeMark\(\)[\s\S]*?pub-mark-free[\s\S]*?Free call[\s\S]*?>Free</);
    expect(strip("app/c/[challengeId]/opengraph-image.tsx")).toContain("mark: callMark(entry)");
    expect(strip("app/c/[challengeId]/page.tsx")).toContain('${free ? " · Free" : ""}');
    for (const p of ["components/public/CallReceipt.tsx", "app/c/[challengeId]/page.tsx", "app/c/[challengeId]/opengraph-image.tsx",
      "app/m/[marketId]/page.tsx", "app/m/[marketId]/opengraph-image.tsx", "lib/ogCard.tsx"]) {
      const text = strip(p);
      for (const pattern of [/¢/, /per share/i, /\bshare\b(?!-)/i, /Locked/, /no money at stake/i, /priceUnit|priceParts|centsLabel/]) {
        expect({ p, match: text.match(pattern)?.[0] ?? null }).toEqual({ p, match: null });
      }
    }
  });

  test("only an unfunded call may be labelled free", () => {
    expect(isFreeCall({ fundingState: "NONE" })).toBe(true);
    // Older payloads without the field are free calls (funding never shipped).
    expect(isFreeCall({ fundingState: undefined as unknown as string })).toBe(true);
    for (const state of ["QUOTED", "SUBMITTED", "FILLED", "PARTIAL", "FAILED", "CLOSED", "CLAIMABLE", "CLAIMED"]) {
      expect(isFreeCall({ fundingState: state })).toBe(false);
    }
  });
});

describe("link-preview images", () => {
  const web = join(import.meta.dir, "../web");

  test("every file the OG card reads is traced into the OG functions", () => {
    // Serverless functions do not get /public unless the build traces a file.
    // A computed path traced nothing into /c and /m, so the receipt card lost
    // its font and logo; next.config.ts now lists them for every OG route.
    const config = readFileSync(join(web, "next.config.ts"), "utf8");
    const card = readFileSync(join(web, "lib/ogCard.tsx"), "utf8");
    const listed = [...config.matchAll(/"\.\/public\/([^"]+)"/g)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(0);
    expect(config).toContain('"/**/opengraph-image": OG_ASSET_FILES');
    for (const rel of listed) {
      expect(existsSync(join(web, "public", rel))).toBe(true);
      // ogCard reads it with literal path segments, so the tracer sees it too.
      const segments = rel.split("/").map((s) => `"${s}"`).join(", ");
      expect(card).toContain(`join(process.cwd(), "public", ${segments})`);
    }
  });
});
