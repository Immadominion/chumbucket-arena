import { expect, test } from "bun:test";
import { SupabaseAccountWallets } from "../src/wallet/accountWallets.ts";

// Synthetic ids and addresses only; the fetch double stands in for PostgREST.
const user = "10000000-0000-4000-8000-000000000001";
const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const cfg = { supabaseUrl: "https://synthetic.invalid/", serviceRoleKey: "synthetic-only" };

function rest(rows: unknown, status = 200) {
  const urls: URL[] = [];
  const fetchImpl = Object.assign(async (url: Parameters<typeof fetch>[0]) => {
    urls.push(new URL(String(url)));
    return new Response(JSON.stringify(rows), { status });
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  return { urls, fetchImpl };
}

test("asks for exactly this person's active, proven link for exactly this address", async () => {
  const { urls, fetchImpl } = rest([{ wallet_address: wallet }]);
  expect(await new SupabaseAccountWallets(cfg, fetchImpl).owns(user, wallet)).toBe(true);
  const url = urls[0]!;
  expect(url.origin + url.pathname).toBe("https://synthetic.invalid/rest/v1/linked_wallets");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    user_id: `eq.${user}`, wallet_address: `eq.${wallet}`, revoked_at: "is.null", verified_at: "not.is.null",
    select: "wallet_address", limit: "1",
  });
});

test("no row, another address, or malformed input is not ownership; a failed read throws", async () => {
  expect(await new SupabaseAccountWallets(cfg, rest([]).fetchImpl).owns(user, wallet)).toBe(false);
  expect(await new SupabaseAccountWallets(cfg, rest([{ wallet_address: "other" }]).fetchImpl).owns(user, wallet)).toBe(false);
  const untouched = rest([{ wallet_address: wallet }]);
  expect(await new SupabaseAccountWallets(cfg, untouched.fetchImpl).owns("not-a-uuid", wallet)).toBe(false);
  expect(await new SupabaseAccountWallets(cfg, untouched.fetchImpl).owns(user, "eq.x,or(1=1)")).toBe(false);
  expect(untouched.urls).toHaveLength(0);
  await expect(new SupabaseAccountWallets(cfg, rest({ message: "refused" }, 500).fetchImpl).owns(user, wallet)).rejects.toThrow("linked_wallets read failed");
  await expect(new SupabaseAccountWallets(cfg, rest({ not: "rows" }).fetchImpl).owns(user, wallet)).rejects.toThrow("linked_wallets read failed");
});
