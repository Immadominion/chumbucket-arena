import { expect, test } from "bun:test";
import { SupabaseAccountWallets } from "../src/wallet/accountWallets.ts";

// Synthetic ids and addresses only; the fetch double stands in for PostgREST.
const user = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
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
const row = (over: Record<string, unknown> = {}) => ({ user_id: user, wallet_address: wallet, revoked_at: null, verified_at: "2026-10-04T10:00:00Z", ...over });

test("reads the one row for this address and judges it for this person", async () => {
  const { urls, fetchImpl } = rest([row()]);
  expect(await new SupabaseAccountWallets(cfg, fetchImpl).status(user, wallet)).toBe("active");
  const url = urls[0]!;
  expect(url.origin + url.pathname).toBe("https://synthetic.invalid/rest/v1/linked_wallets");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    wallet_address: `eq.${wallet}`, select: "user_id,wallet_address,revoked_at,verified_at", limit: "1",
  });
});

test("revoked or unproven is this account's 'revoked', another account's is 'other', no row is 'none'", async () => {
  const status = async (rows: unknown) => new SupabaseAccountWallets(cfg, rest(rows).fetchImpl).status(user, wallet);
  expect(await status([row({ revoked_at: "2026-10-04T11:00:00Z" })])).toBe("revoked");
  expect(await status([row({ verified_at: null })])).toBe("revoked");
  expect(await status([row({ user_id: other })])).toBe("other");
  expect(await status([])).toBe("none");
  expect(await status([row({ wallet_address: "someone-else" })])).toBe("none");
});

test("malformed input reads nothing; a failed read throws", async () => {
  const untouched = rest([row()]);
  expect(await new SupabaseAccountWallets(cfg, untouched.fetchImpl).status("not-a-uuid", wallet)).toBe("none");
  expect(await new SupabaseAccountWallets(cfg, untouched.fetchImpl).status(user, "eq.x,or(1=1)")).toBe("none");
  expect(untouched.urls).toHaveLength(0);
  await expect(new SupabaseAccountWallets(cfg, rest({ message: "refused" }, 500).fetchImpl).status(user, wallet)).rejects.toThrow("linked_wallets read failed");
  await expect(new SupabaseAccountWallets(cfg, rest({ not: "rows" }).fetchImpl).status(user, wallet)).rejects.toThrow("linked_wallets read failed");
});

test("with linking, a linked wallet that signs in to another account is not this account's", async () => {
  const asked: Array<[string, string]> = [];
  const links = (conflict: boolean | Error) => ({
    async walletSignInConflict(userId: string, address: string) {
      asked.push([userId, address]);
      if (conflict instanceof Error) throw conflict;
      return conflict;
    },
  });
  const active = () => rest([row()]).fetchImpl;
  expect(await new SupabaseAccountWallets(cfg, active(), links(false)).status(user, wallet)).toBe("active");
  expect(await new SupabaseAccountWallets(cfg, active(), links(true)).status(user, wallet)).toBe("other");
  expect(asked).toEqual([[user, wallet], [user, wallet]]);
  // No row, a revoked row or another account's row: linking is never asked,
  // and its answer could not make an active link.
  expect(await new SupabaseAccountWallets(cfg, rest([]).fetchImpl, links(false)).status(user, wallet)).toBe("none");
  expect(await new SupabaseAccountWallets(cfg, rest([row({ revoked_at: "2026-10-04T11:00:00Z" })]).fetchImpl, links(false)).status(user, wallet)).toBe("revoked");
  expect(await new SupabaseAccountWallets(cfg, rest([row({ user_id: other })]).fetchImpl, links(false)).status(user, wallet)).toBe("other");
  expect(asked).toHaveLength(2);
  // An unreadable answer is never "no conflict".
  await expect(new SupabaseAccountWallets(cfg, active(), links(new Error("down"))).status(user, wallet)).rejects.toThrow("down");
});
