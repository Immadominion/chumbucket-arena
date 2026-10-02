/**
 * Shared links are built on the owner's live site (audit B4). chumbucket.app
 * never resolved, so every link built on it was dead for the recipient.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SHARE_BASE_URL,
  describeCallsConfig,
  resolveCallsConfig,
  shareLinkForCall,
  shareLinkForMarket,
  shareLinkForPerson,
} from "../src/calls/config.ts";

describe("share links", () => {
  test("default to https://chumbucket.fun", () => {
    const cfg = resolveCallsConfig(undefined, {});
    expect(DEFAULT_SHARE_BASE_URL).toBe("https://chumbucket.fun");
    expect(cfg.shareBaseUrl).toBe("https://chumbucket.fun");
    expect(shareLinkForCall(cfg, "4c0d0dd2")).toBe("https://chumbucket.fun/c/4c0d0dd2");
    expect(shareLinkForPerson(cfg, "@dominion")).toBe("https://chumbucket.fun/u/dominion");
    expect(shareLinkForMarket(cfg, "5f90380c")).toBe("https://chumbucket.fun/m/5f90380c");
    expect(describeCallsConfig(cfg).shareBaseUrl).toBe("https://chumbucket.fun");
  });

  test("CALLS_SHARE_BASE_URL still overrides, without a trailing slash", () => {
    const cfg = resolveCallsConfig(undefined, { CALLS_SHARE_BASE_URL: "https://staging.chumbucket.fun/" });
    expect(shareLinkForCall(cfg, "x")).toBe("https://staging.chumbucket.fun/c/x");
  });

  test("the dead domain is not the default anywhere in the calls config", async () => {
    const source = await Bun.file(new URL("../src/calls/config.ts", import.meta.url)).text();
    expect(source).not.toContain('"https://chumbucket.app"');
  });
});
