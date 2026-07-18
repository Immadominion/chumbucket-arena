/**
 * Print privacy-safe, exact product counts from Chumbucket's public read model.
 * No profile rows, wallet addresses, names, or credentials are logged.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... bun scripts/analyze-product-traction.ts
 *   railway run bun scripts/analyze-product-traction.ts
 */

const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("Set SUPABASE_URL and a Supabase publishable, anon, or service-role key");
}

async function exactCount(table: string): Promise<number | null> {
  const response = await fetch(`${url}/rest/v1/${table}?select=*`, {
    method: "HEAD",
    headers: {
      apikey: key!,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
      range: "0-0",
      "range-unit": "items",
    },
  });
  if (!response.ok) return null;
  const total = response.headers.get("content-range")?.split("/")[1];
  return total && total !== "*" ? Number(total) : null;
}

const tables = [
  "users",
  "linked_wallets",
  "fcm_tokens",
  "friends",
  "challenges",
  "prediction_markets",
  "prediction_positions",
  "prediction_activity",
  "settlement_receipts",
] as const;

const counts = Object.fromEntries(
  await Promise.all(tables.map(async (table) => [table, await exactCount(table)])),
);

console.log(JSON.stringify({ source: "production Supabase exact counts", asOf: new Date().toISOString(), ...counts }, null, 2));
