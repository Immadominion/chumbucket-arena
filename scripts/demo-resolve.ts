/**
 * Demo helper — resolve a match on command via the key-gated `resolveMatchNow`
 * endpoint, so you can show a bet settle (real win/loss) live without waiting for
 * the actual final whistle.
 *
 * Find the matchId from the matchday list (GET /matchday or the app), then:
 *
 *   DEMO_ADMIN_KEY=your-secret \
 *   BACKEND_URL=https://chumbucket-arena-production.up.railway.app \
 *     bun run scripts/demo-resolve.ts <matchId> <homeGoals> <awayGoals>
 *
 * The same DEMO_ADMIN_KEY must be set on the backend (Railway) or the endpoint
 * stays disabled and every call is rejected.
 */

const [matchId, home, away] = process.argv.slice(2);
const key = process.env.DEMO_ADMIN_KEY;
const url = (process.env.BACKEND_URL ?? "https://chumbucket-arena-production.up.railway.app").replace(/\/$/, "");

if (!matchId || home === undefined || away === undefined) {
  console.error("usage: bun run scripts/demo-resolve.ts <matchId> <homeGoals> <awayGoals>");
  process.exit(1);
}
if (!key) {
  console.error("set DEMO_ADMIN_KEY (must match the backend's DEMO_ADMIN_KEY)");
  process.exit(1);
}

// tRPC (superjson) single-mutation wire format: body is the serialized input.
const body = JSON.stringify({ json: { matchId, home: Number(home), away: Number(away), key } });
const res = await fetch(`${url}/resolveMatchNow`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${res.status} — ${text}`);
  process.exit(1);
}
console.log(`✓ resolved ${matchId} → ${home}-${away}`);
console.log(text);
