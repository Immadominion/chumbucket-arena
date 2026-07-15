/**
 * Seed a demo account's Walrus memory with ~a week of betting history, so the
 * LIVE Gaffer recalls it and references learned patterns — the "day-4" memory
 * depth the hackathon judges look for, vs a blank day-one account.
 *
 * It writes real memories to the SAME Walrus namespace the live backend recalls
 * from — `gaffer:<wallet>` — using the production MemWal creds from .env. No
 * on-chain money, no fake matches, no event-log edits: pure memory on Walrus.
 *
 * The memories tell a coherent story with a *learnable pattern* (this player
 * chases losses by hammering favourites; their rare green comes from a brave
 * underdog call). After seeding, ask the Gaffer about backing a favourite and he
 * throws the week back at you — impossible on day one.
 *
 *   1. Log into the demo account, copy its Sui wallet address (the deposit address).
 *   2. bun run scripts/seed-memory.ts 0xYOUR_DEMO_WALLET
 *   3. Give the relayer a minute to index, then chat with the Gaffer.
 */

import { SdkMemWalClient } from "../src/core/memory/SdkMemWalClient.ts";
import { asWallet, playerStream } from "../src/domain/ids.ts";

const raw = process.argv[2];
if (!raw || !raw.startsWith("0x")) {
  console.error("usage: bun run scripts/seed-memory.ts <demo-wallet-address>");
  process.exit(1);
}
const accountId = process.env.MEMWAL_ACCOUNT_ID;
const privateKey = process.env.MEMWAL_PRIVATE_KEY;
if (!accountId || !privateKey) {
  console.error("Need MEMWAL_ACCOUNT_ID + MEMWAL_PRIVATE_KEY in the env (same as the backend).");
  process.exit(1);
}

const client = new SdkMemWalClient({
  privateKey,
  accountId,
  ...(process.env.MEMWAL_SERVER_URL ? { serverUrl: process.env.MEMWAL_SERVER_URL } : {}),
});
const ns = playerStream(asWallet(raw)); // gaffer:<wallet> — exactly what the Gaffer recalls

// A week of receipts with a pattern the Gaffer can distil and throw back.
const MEMORIES: string[] = [
  "Six days ago: backed Brazil to beat Cape Verde — the heavy favourite, 3 WAL on at 72% implied. Came in, but the crowd already had it. Safe money, barely moved the rating.",
  "Five days ago: backed France over Iraq, favourite again — 2 WAL at 68%. Held to a draw. First red of the week, P&L -2 WAL.",
  "Five days ago, on the record: 'Favourites always deliver in the group stage. Fade the romance.'",
  "Four days ago: doubled down on Germany over Ecuador, 4 WAL at 64% — another favourite. Lost. Two chalk losses in a row, GR sliding.",
  "Four days ago: chased it the same night — 5 WAL on Spain to win it all back, favourite at 66%. Spain drew. Chasing a loss with more chalk; it bit. P&L -5 WAL.",
  "Three days ago: finally went against the crowd — 1 WAL on Morocco to beat Croatia at just 22% implied. It LANDED. Best call of the week: backed yourself when nobody else would. P&L +3.6 WAL, biggest GR jump yet.",
  "Three days ago, on the record after Morocco: 'Maybe the money's in the brave calls, not the obvious ones.'",
  "Two days ago: reverted to type — 3 WAL on England over Ghana, favourite at 70%. Lost. Straight back to chasing chalk.",
  "Yesterday: chased the England loss with 4 WAL on Portugal, favourite again. Scraped a win, but thin — the crowd was already all over it.",
  "The Gaffer's standing read: you chase losses by hammering favourites, and that's where almost all your red ink comes from. Your green came from one brave underdog call — Morocco. Brave pays; chasing chalk bleeds.",
  "You keep saying you 'feel safer on the favourite' — but that's the exact call that's cost you four times this week.",
  "This week's record: 3 wins, 4 losses, net negative. Every loss was a favourite you backed or chased; the one standout win was the underdog nobody else wanted.",
];

console.log(`Seeding ${MEMORIES.length} memories → ${ns}`);
let ok = 0;
for (let i = 0; i < MEMORIES.length; i++) {
  try {
    await client.remember(ns, MEMORIES[i]!);
    ok += 1;
    console.log(`  ${i + 1}/${MEMORIES.length} ✓`);
  } catch (e) {
    console.error(`  ${i + 1}/${MEMORIES.length} ✗ ${(e as Error).message}`);
  }
}
console.log(`\nDone — ${ok}/${MEMORIES.length} memories written to Walrus.`);
console.log("Give the relayer ~1 minute to index, then ask the Gaffer: \"should I back Argentina, the favourite?\"");
console.log("He should reference the favourites you chased this week. That's the day-4 memory.");
