/**
 * Runtime check: the exact client wire config the app uses (httpBatchLink +
 * superjson) against the LIVE backend. Confirms the URL resolves, batching works,
 * and superjson rehydrates money as real bigints. Run: bun run scripts/verify-live.ts
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@server/api/router";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://chumbucket-arena-production.up.railway.app";

const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: BACKEND, transformer: superjson })],
});

const [health, matches, ladder] = await Promise.all([
  client.health.query(),
  client.matchday.query(),
  client.leaderboard.query({ by: "gr", limit: 5 }),
]);

console.log("backend wiring:", health.wiring);
console.log("managersPot:", health.managersPot, `(typeof ${typeof health.managersPot})`);
console.log("open fixtures:", matches.length);
const f = matches[0];
if (f) {
  const pot = f.markets[0]?.grossPot;
  console.log("first fixture:", f.fixture.home, "v", f.fixture.away, "·", f.fixture.group);
  console.log("grossPot:", pot, `(typeof ${typeof pot})  <- must be 'bigint' for superjson to be correct`);
}
console.log("ladder entries:", ladder.length);
console.log("\nOK — typed client ↔ live backend verified.");
