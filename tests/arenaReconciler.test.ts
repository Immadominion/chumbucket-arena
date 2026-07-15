import { describe, expect, test } from "bun:test";
import {
  ArenaReconciler,
  decodeMatchId,
  type ArenaChainSource,
  type ArenaTx,
  type PotState,
  type SignatureRef,
} from "../src/indexer/ArenaReconciler.ts";
import type {
  ApplyClaimInput,
  ApplySettlementInput,
  ConfirmPredictionSignatureInput,
  IndexerCursorRow,
  RecordPredictionCallInput,
  SocialStore,
} from "../src/social/SocialStore.ts";
import type { ParsedArenaInstruction } from "../src/indexer/ArenaInstructionParser.ts";

// ─── fakes ──────────────────────────────────────────────────────────────────

class FakeSocial implements SocialStore {
  readonly enabled = true;
  records: RecordPredictionCallInput[] = [];
  confirms: ConfirmPredictionSignatureInput[] = [];
  settlements: ApplySettlementInput[] = [];
  claims: ApplyClaimInput[] = [];
  advances: Array<{ source: string; key: string; signature: string; slot?: number }> = [];
  /** open_tx_signature -> positionsUpdated returned by confirm (default 0 = chain-only). */
  confirmHits: Record<string, number> = {};
  cursor: IndexerCursorRow | null = null;

  async recordPredictionCall(input: RecordPredictionCallInput) {
    this.records.push(input);
    return { ok: true, positionId: `pos-${this.records.length}` };
  }
  async confirmPredictionSignature(input: ConfirmPredictionSignatureInput) {
    this.confirms.push(input);
    return { ok: true, result: { positionsUpdated: this.confirmHits[input.txSignature] ?? 0, activityUpdated: 0 } };
  }
  async applySettlement(input: ApplySettlementInput) {
    this.settlements.push(input);
    return { ok: true };
  }
  async applyClaim(input: ApplyClaimInput) {
    this.claims.push(input);
    return { ok: true };
  }
  async advanceCursor(source: string, key: string, signature: string, slot?: number) {
    this.advances.push({ source, key, signature, slot });
    this.cursor = { last_signature: signature, last_slot: slot ?? null };
  }
  async readCursor() {
    return this.cursor;
  }
  async myPositions() {
    return [];
  }
  async claimable() {
    return [];
  }
  async activity() {
    return [];
  }
  async follow() {
    return { ok: true };
  }
  async unfollow() {
    return { ok: true };
  }
  async followingFeed() {
    return [];
  }
  async followCounts() {
    return { followers: 0, following: 0 };
  }
  async isFollowing() {
    return false;
  }
  async matchCallers() {
    return [];
  }
  async socialLeaderboard() {
    return [];
  }
  async userStats() {
    return null;
  }
}

class FakeChain implements ArenaChainSource {
  untilSeen: Array<string | undefined> = [];
  constructor(
    private readonly sigs: SignatureRef[],
    private readonly txs: Record<string, ArenaTx | null>,
    private readonly pots: Record<string, PotState>,
  ) {}
  async signaturesSince(until: string | undefined): Promise<SignatureRef[]> {
    this.untilSeen.push(until);
    // Emulate the real source: the full delta of signatures strictly newer than `until`.
    if (!until) return this.sigs;
    const idx = this.sigs.findIndex((s) => s.signature === until);
    return idx >= 0 ? this.sigs.slice(0, idx) : this.sigs;
  }
  async loadTx(signature: string): Promise<ArenaTx | null> {
    if (!(signature in this.txs)) throw new Error(`unexpected loadTx ${signature}`);
    return this.txs[signature]!;
  }
  async loadPot(potAddress: string): Promise<PotState | undefined> {
    return this.pots[potAddress];
  }
}

// ─── instruction builders ─────────────────────────────────────────────────────

function placeCall(over: Partial<ParsedArenaInstruction> = {}): ParsedArenaInstruction {
  return {
    name: "place_call",
    programId: "PROG",
    accounts: ["WALLET1", "POT1", "VAULT1", "USDC1", "POS1", "TOK", "SYS"],
    namedAccounts: { player: "WALLET1", pot: "POT1", vault: "VAULT1", player_usdc: "USDC1", position: "POS1" },
    args: { bucket: 0, amount: "20000000" },
    ...over,
  };
}
function settlePot(over: Partial<ParsedArenaInstruction> = {}): ParsedArenaInstruction {
  return {
    name: "settle_pot",
    programId: "PROG",
    accounts: ["CONFIG", "POT1", "TXO", "ROOTS"],
    namedAccounts: { config: "CONFIG", pot: "POT1", txoracle_program: "TXO", daily_scores_merkle_roots: "ROOTS" },
    args: { winningBucket: 0 },
    ...over,
  };
}
function claimIx(over: Partial<ParsedArenaInstruction> = {}): ParsedArenaInstruction {
  return {
    name: "claim",
    programId: "PROG",
    accounts: ["WALLET1", "POT1", "VAULT1", "USDC1", "POS1", "TOK"],
    namedAccounts: { player: "WALLET1", pot: "POT1", position: "POS1" },
    args: {},
    ...over,
  };
}
function voidPotIx(over: Partial<ParsedArenaInstruction> = {}): ParsedArenaInstruction {
  return {
    name: "void_pot",
    programId: "PROG",
    accounts: ["CALLER", "CONFIG", "POT1"],
    namedAccounts: { caller: "CALLER", config: "CONFIG", pot: "POT1" },
    args: {},
    ...over,
  };
}

const POT1: PotState = {
  matchId: "18202701",
  fixtureId: 18202701,
  winningBucket: 0,
  status: 2,
  distributable: "9750000",
  winnersStake: "20000000",
};

const sig = (signature: string, slot: number, err = false): SignatureRef => ({ signature, slot, err });

// ─── tests ────────────────────────────────────────────────────────────────────

describe("ArenaReconciler", () => {
  test("chain-only place_call creates a position from Pot state", async () => {
    const social = new FakeSocial(); // confirm returns 0 => not mirrored
    const chain = new FakeChain([sig("S1", 100)], { S1: { err: false, instructions: [placeCall()] } }, { POT1 });
    const r = new ArenaReconciler(social, chain);

    const s = await r.reconcile();

    expect(social.records.length).toBe(1);
    expect(social.records[0]).toMatchObject({
      wallet: "WALLET1",
      matchId: "18202701",
      marketId: "18202701",
      bucket: "HOME",
      stakeBaseUnits: "20000000",
      txSignature: "S1",
      positionAddress: "POS1",
      slot: 100,
    });
    expect(s.created).toBe(1);
    expect(s.placeCalls).toBe(1);
    expect(social.advances.at(-1)).toMatchObject({ signature: "S1", slot: 100, key: "signatures" });
  });

  test("place_call always records idempotently, backfilling position_address from chain", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain([sig("S1", 100)], { S1: { err: false, instructions: [placeCall()] } }, { POT1 });

    await new ArenaReconciler(social, chain).reconcile();

    // Runs record_prediction_call (create-or-repair) with the on-chain Position
    // PDA, so a mobile row that never sent positionAddress gets it backfilled and
    // a later claim can link by that PDA.
    expect(social.records.length).toBe(1);
    expect(social.records[0]!.positionAddress).toBe("POS1");
  });

  test("settle_pot settles from on-chain Pot (winning bucket + parimutuel figures)", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain([sig("S2", 200)], { S2: { err: false, instructions: [settlePot()] } }, { POT1 });

    const s = await new ArenaReconciler(social, chain).reconcile();

    expect(social.settlements.length).toBe(1);
    expect(social.settlements[0]).toMatchObject({
      marketId: "18202701",
      matchId: "18202701",
      winningBucket: "HOME",
      settleTxSignature: "S2",
      distributableBaseUnits: "9750000",
      winnersStakeBaseUnits: "20000000",
      fixtureId: 18202701,
    });
    expect(s.settlements).toBe(1);
  });

  test("void settlement is surfaced (winners_stake = 0)", async () => {
    const social = new FakeSocial();
    const voidPot: PotState = { ...POT1, winningBucket: 1, winnersStake: "0", distributable: "0" };
    const chain = new FakeChain([sig("S2", 200)], { S2: { err: false, instructions: [settlePot()] } }, { POT1: voidPot });

    await new ArenaReconciler(social, chain).reconcile();

    expect(social.settlements[0]).toMatchObject({ winnersStakeBaseUnits: "0", winningBucket: "DRAW" });
  });

  test("void_pot (force-void / postponed) routes through settlement as a refund", async () => {
    const social = new FakeSocial();
    const voidPot: PotState = { ...POT1, status: 3, winningBucket: 0, winnersStake: "0", distributable: "0" };
    const chain = new FakeChain([sig("S7", 700)], { S7: { err: false, instructions: [voidPotIx()] } }, { POT1: voidPot });

    const s = await new ArenaReconciler(social, chain).reconcile();

    expect(s.settlements).toBe(1);
    expect(social.settlements[0]).toMatchObject({ winnersStakeBaseUnits: "0", settleTxSignature: "S7", matchId: "18202701" });
  });

  test("claim marks the position CLAIMED", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain([sig("S3", 300)], { S3: { err: false, instructions: [claimIx()] } }, {});

    const s = await new ArenaReconciler(social, chain).reconcile();

    expect(social.claims.length).toBe(1);
    expect(social.claims[0]).toMatchObject({ wallet: "WALLET1", positionAddress: "POS1", claimTxSignature: "S3" });
    expect(s.claims).toBe(1);
  });

  test("failed tx is skipped but the cursor still advances past it", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain([sig("S4", 400, true)], {}, {});

    const s = await new ArenaReconciler(social, chain).reconcile();

    expect(s.failedTxSkipped).toBe(1);
    expect(s.applied).toBe(0);
    expect(social.advances.at(-1)).toMatchObject({ signature: "S4" });
  });

  test("bucket index maps to HOME/DRAW/AWAY", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain(
      [sig("S1", 100)],
      { S1: { err: false, instructions: [placeCall({ args: { bucket: 2, amount: "5000000" } })] } },
      { POT1 },
    );
    await new ArenaReconciler(social, chain).reconcile();
    expect(social.records[0]!.bucket).toBe("AWAY");
  });

  test("a not-yet-available tx stops the pass; cursor holds at the last success", async () => {
    const social = new FakeSocial();
    // newest-first: S6 (newer) then S5 (older). Processed oldest-first: S5, S6.
    const chain = new FakeChain(
      [sig("S6", 600), sig("S5", 500)],
      { S5: { err: false, instructions: [] }, S6: null },
      {},
    );

    const s = await new ArenaReconciler(social, chain).reconcile();

    expect(s.stoppedEarly).toBe(true);
    expect(s.errors).toBe(1);
    // Advanced only through S5 — S6 will be retried next pass, not skipped.
    expect(social.advances.at(-1)).toMatchObject({ signature: "S5" });
  });

  test("cursor drives resume: until is passed, and a caught-up pass is a no-op", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain(
      [sig("S2", 200), sig("S1", 100)],
      {
        S1: { err: false, instructions: [placeCall()] },
        S2: { err: false, instructions: [settlePot()] },
      },
      { POT1 },
    );
    const r = new ArenaReconciler(social, chain);

    const first = await r.reconcile();
    expect(first.scanned).toBe(2);
    expect(chain.untilSeen[0]).toBeUndefined(); // no cursor yet
    expect(social.cursor?.last_signature).toBe("S2"); // advanced to newest

    // Second pass: cursor now points at S2, so nothing new is scanned.
    const second = await r.reconcile();
    expect(chain.untilSeen[1]).toBe("S2");
    expect(second.scanned).toBe(0);
    expect(second.applied).toBe(0);
    // No new work beyond the first pass: one place_call record + one settlement.
    expect(social.settlements.length).toBe(1);
    expect(social.records.length).toBe(1);
  });

  test("mixed batch processes place_call -> settle -> claim in order", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain(
      [sig("S3", 300), sig("S2", 200), sig("S1", 100)],
      {
        S1: { err: false, instructions: [placeCall()] },
        S2: { err: false, instructions: [settlePot()] },
        S3: { err: false, instructions: [claimIx()] },
      },
      { POT1 },
    );
    const s = await new ArenaReconciler(social, chain).reconcile();
    expect(s.placeCalls).toBe(1);
    expect(s.settlements).toBe(1);
    expect(s.claims).toBe(1);
    expect(social.advances.at(-1)).toMatchObject({ signature: "S3" });
  });

  test("backlog larger than maxPerPass drains oldest-first across passes without skipping", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain(
      [sig("S3", 300), sig("S2", 200), sig("S1", 100)],
      {
        S1: { err: false, instructions: [placeCall()] },
        S2: { err: false, instructions: [placeCall()] },
        S3: { err: false, instructions: [placeCall()] },
      },
      { POT1 },
    );
    const r = new ArenaReconciler(social, chain, 2); // maxPerPass = 2

    const first = await r.reconcile();
    // Oldest two (S1, S2) processed; cursor advanced to S2 — NOT the newest S3.
    expect(first.placeCalls).toBe(2);
    expect(social.cursor?.last_signature).toBe("S2");

    const second = await r.reconcile();
    expect(chain.untilSeen.at(-1)).toBe("S2");
    expect(second.placeCalls).toBe(1);
    expect(social.cursor?.last_signature).toBe("S3");
    expect(social.records.length).toBe(3); // all three, none skipped
  });

  test("a permanently-null signature is skipped after retries, unwedging the cursor", async () => {
    const social = new FakeSocial();
    const chain = new FakeChain(
      [sig("S2", 200), sig("S1", 100)],
      { S1: { err: false, instructions: [] }, S2: null },
      {},
    );
    const r = new ArenaReconciler(social, chain);

    for (let i = 0; i < 5; i++) {
      const s = await r.reconcile();
      expect(s.stoppedEarly).toBe(true);
      expect(social.cursor?.last_signature).toBe("S1"); // holds, does not skip S2
    }
    const last = await r.reconcile();
    expect(last.stoppedEarly).toBe(false);
    expect(social.cursor?.last_signature).toBe("S2"); // finally skipped, cursor unwedged
  });
});

describe("decodeMatchId", () => {
  test("strips zero padding and decodes ascii", () => {
    const label = "18202701";
    const ascii = [...Buffer.from(label, "ascii")];
    const padded = [...new Array(32 - ascii.length).fill(0), ...ascii];
    expect(decodeMatchId(padded)).toBe("18202701");
  });
  test("empty on all-zero or empty input", () => {
    expect(decodeMatchId(new Array(32).fill(0))).toBe("");
    expect(decodeMatchId([])).toBe("");
    expect(decodeMatchId(undefined)).toBe("");
  });
});
