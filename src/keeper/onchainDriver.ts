/**
 * On-chain keeper — drives chumbucket_arena's admin/permissionless instructions
 * (create_pot / lock_pot / settle_pot / sweep_rake) on devnet against the SAME
 * TxLINE fixtures the backend already tracks (via readModel.pots, fed by
 * TxlineMatchData). This is a NET-NEW, separate money path — it never reads
 * from or writes to the custodial Engine's off-chain ledger (deposit/withdraw/
 * makeCall/createChallenge/acceptChallenge stay exactly as they are).
 *
 * Mirrors the proven devnet lifecycle scripts byte-for-byte where it matters:
 *   onchain/gaffer_verifier/scripts/devnet-lifecycle/init-and-create-pot.ts  (connection/provider setup, matchIdBytes, create_pot accounts)
 *   onchain/gaffer_verifier/scripts/devnet-lifecycle/lock-and-settle.ts      (finished-match scan, proof fetch, settle_pot/sweep_rake accounts)
 * The settlement proof fetch + Anchor argument mapping is adapted directly from
 * TxlineSettlementVerifier.buildValidateStatArgs — chumbucket_arena's settle_pot
 * takes the same fixture_summary/fixture_proof/main_tree_proof/stat_home/stat_away
 * shapes as TxLINE's validate_stat (it just bakes the predicate from
 * winning_bucket instead of taking one as an argument), so that mapping is reused
 * as-is rather than re-derived.
 */

import * as fs from "node:fs";
import { AnchorProvider, BN, Program, Wallet as AnchorWallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { App } from "../app.ts";
import type { OnchainKeeperConfig } from "../config.ts";
import { finalScoresEvent, type TxScoresEvent } from "../ports/TxlineMatchData.ts";
import {
  buildValidateStatArgs,
  isCompleteBundle,
  provenScore,
  type StatValidationResponse,
} from "../ports/TxlineSettlementVerifier.ts";
import { resolveLine } from "../game/markets.ts";
import { LINE_BUCKETS, type LineMarketSpec } from "../domain/model.ts";
import type { ChumbucketArena } from "../../vendor/chumbucket_arena/chumbucket_arena.ts";
import idl from "../../vendor/chumbucket_arena/chumbucket_arena.json" with { type: "json" };

const CONFIG_SEED = Buffer.from("config");
const POT_SEED = Buffer.from("pot");
const VAULT_SEED = Buffer.from("vault");
const MARKET_SPEC_SEED = Buffer.from("market_spec");
const DAILY_SCORES_ROOTS_SEED = Buffer.from("daily_scores_roots");

const STATUS_OPEN = 0;
const STATUS_LOCKED = 1;
const STATUS_SETTLED = 2;

const BUCKET_HOME = 0;
const BUCKET_DRAW = 1;
const BUCKET_AWAY = 2;
// Line-market buckets (0/1) + on-chain MarketSpec enum values (mirror state.rs).
const BUCKET_OVER = 0;
const BUCKET_UNDER = 1;
const MARKET_OVER_UNDER = 1;
const MARKET_HANDICAP = 2;
const OP_ADD = 0;
const OP_SUB = 1;
// Full-time goals stat leaves, verified against a real TxLINE proof (ARG 3-2
// EGY): P1 goals = key 1, P2 goals = key 2, both at period 5.
const STAT_KEY_P1_GOALS = 1;
const STAT_KEY_P2_GOALS = 2;
const FULL_TIME_GOALS_PERIOD = 5;

/**
 * ASCII bytes of `label`, LEFT-padded with zeros to exactly 32 bytes — byte-exact
 * with onchain/…/devnet-lifecycle/init-and-create-pot.ts's matchIdBytes(). The
 * backend's MatchId for a TxLINE fixture is the numeric fixture id as a string
 * (see TxlineMatchData.toFixture: `asMatchId(String(f.FixtureId))`).
 */
export function matchIdBytes(label: string): Buffer {
  const ascii = Buffer.from(label, "ascii");
  if (ascii.length > 32) throw new Error(`[keeper] match_id label too long (>32 bytes): ${label}`);
  return Buffer.concat([Buffer.alloc(32 - ascii.length), ascii]);
}

export function derivePdas(programId: PublicKey, matchId: Buffer) {
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  const [potPda] = PublicKey.findProgramAddressSync([POT_SEED, matchId], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED, potPda.toBuffer()], programId);
  return { configPda, potPda, vaultPda };
}

interface OnchainConfigInfo {
  configPda: PublicKey;
  admin: PublicKey;
  usdcMint: PublicKey;
  txoracleProgram: PublicKey;
  rakeBps: number;
  minParticipants: number;
}

export class OnchainKeeper {
  private readonly connection: Connection;
  private readonly provider: AnchorProvider;
  private readonly program: Program<ChumbucketArena>;
  private readonly keeper: Keypair;
  private readonly programId: PublicKey;

  constructor(
    private readonly app: App,
    private readonly cfg: OnchainKeeperConfig,
  ) {
    // Prefer an inline secret (KEEPER_KEYPAIR_JSON) over a file path — a
    // gitignored keypair file never reaches a deploy upload that itself
    // respects .gitignore (Railway's `railway up` does), so platforms without
    // a way to ship a git-ignored file need the secret to travel as an env var.
    const raw = cfg.keypairJson ?? fs.readFileSync(cfg.keypairPath, "utf8");
    const secret = Uint8Array.from(JSON.parse(raw));
    this.keeper = Keypair.fromSecretKey(secret);
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    this.provider = new AnchorProvider(this.connection, new AnchorWallet(this.keeper), AnchorProvider.defaultOptions());
    this.programId = new PublicKey(cfg.programId);
    // Anchor 0.32 derives Program.programId strictly from idl.address; override it
    // to cfg.programId so this always targets the configured deployment (same
    // reasoning as TxlineSettlementVerifier's override of the vendored TxLINE IDL).
    this.program = new Program(
      { ...(idl as unknown as Record<string, unknown>), address: this.programId.toBase58() } as unknown as ChumbucketArena,
      this.provider,
    );
    console.log(
      `[keeper] armed — keeper=${this.keeper.publicKey.toBase58()} program=${this.programId.toBase58()} rpc=${cfg.rpcUrl}`,
    );
  }

  private headers(): Record<string, string> {
    // Accept-Encoding: identity — Bun's fetch can't decompress TxLINE's zstd; force plain.
    return { Authorization: `Bearer ${this.cfg.txlineJwt}`, "X-Api-Token": this.cfg.txlineApiToken, "Accept-Encoding": "identity" };
  }

  private async ensureConfig(): Promise<OnchainConfigInfo> {
    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId);
    const acct = await this.connection.getAccountInfo(configPda);
    if (!acct) {
      if (!this.cfg.usdcMint) {
        throw new Error(
          `[keeper] Config PDA ${configPda.toBase58()} does not exist on-chain and CHUMBUCKET_USDC_MINT is unset — cannot init_config`,
        );
      }
      const usdcMint = new PublicKey(this.cfg.usdcMint);
      const txoracleProgram = new PublicKey(this.cfg.txoracleProgramId);
      const sig = await this.program.methods
        .initConfig(this.cfg.rakeBps, this.cfg.minParticipants)
        .accounts({
          admin: this.keeper.publicKey,
          config: configPda,
          usdcMint,
          txoracleProgram,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      console.log(`[keeper] init_config tx=${sig} config=${configPda.toBase58()} admin=${this.keeper.publicKey.toBase58()}`);
    }
    const raw = await (this.program.account as any).config.fetch(configPda);
    return {
      configPda,
      admin: raw.admin as PublicKey,
      usdcMint: raw.usdcMint as PublicKey,
      txoracleProgram: raw.txoracleProgram as PublicKey,
      rakeBps: raw.rakeBps as number,
      minParticipants: raw.minParticipants as number,
    };
  }

  /**
   * One pass over every TxLINE-backed match the backend knows: open a Pot if
   * one doesn't exist yet, lock it once kickoff has passed, settle it once the
   * match is finished and a proof is available, sweep house rake off settled
   * pots. Safe to call on a timer — every step is idempotent / re-checks
   * on-chain state first.
   */
  async tick(): Promise<void> {
    const config = await this.ensureConfig();
    const isAdmin = config.admin.equals(this.keeper.publicKey);
    if (!isAdmin) {
      console.warn(
        `[keeper] keeper ${this.keeper.publicKey.toBase58()} is NOT config.admin (${config.admin.toBase58()}) — ` +
          `create_pot/sweep_rake (admin-gated) will be skipped; lock_pot/settle_pot (permissionless) still run.`,
      );
    }

    const matches = this.app.readModel.pots.allMatches().filter((m) => m.fixture.txline);
    for (const m of matches) {
      const fixtureId = m.fixture.txline!.fixtureId;
      const participant1IsHome = m.fixture.txline!.participant1IsHome;
      // Each market on a fixture (1X2 + line markets) is its own on-chain pot,
      // keyed by the market's potMatchId. Drive them all.
      for (const market of m.markets) {
        const potMatchId = market.potMatchId ?? String(m.fixture.matchId);
        const matchId = matchIdBytes(potMatchId);
        const { potPda, vaultPda } = derivePdas(this.programId, matchId);
        const potAcct = await this.connection.getAccountInfo(potPda);

        if (!potAcct) {
          if (isAdmin) {
            if (market.line) {
              await this.tryCreateLinePot(config, matchId, potPda, vaultPda, fixtureId, m.fixture.kickoff, market.line, participant1IsHome);
            } else {
              await this.tryCreatePot(config, matchId, potPda, vaultPda, fixtureId, m.fixture.kickoff);
            }
          }
          continue;
        }

        const pot = await (this.program.account as any).pot.fetch(potPda);
        const status: number = pot.status;
        const nowSec = Math.floor(Date.now() / 1000);

        if (status === STATUS_OPEN && nowSec >= pot.kickoff.toNumber()) {
          await this.tryLockPot(potPda, fixtureId);
        } else if (status === STATUS_LOCKED) {
          if (market.line) {
            await this.trySettleMarket(config, potPda, fixtureId, participant1IsHome, market.line);
          } else {
            await this.trySettlePot(config, potPda, fixtureId, participant1IsHome);
          }
        } else if (status === STATUS_SETTLED && isAdmin) {
          await this.trySweepRake(config, potPda, vaultPda, fixtureId);
        }
      }
    }
  }

  private async tryCreatePot(
    config: OnchainConfigInfo,
    matchId: Buffer,
    potPda: PublicKey,
    vaultPda: PublicKey,
    fixtureId: number,
    kickoffMs: number,
  ): Promise<void> {
    const kickoffSec = Math.floor(kickoffMs / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    // create_pot's on-chain guard: kickoff must be strictly in the future (anti-
    // squat/anti-stale — see state.rs MAX_KICKOFF_LEAD_SEC). A fixture that has
    // already kicked off before the keeper first saw it can never get an
    // on-chain Pot; that's a real, permanent limitation, not a bug here.
    if (kickoffSec <= nowSec) {
      console.warn(
        `[keeper] fixture ${fixtureId}: kickoff ${new Date(kickoffMs).toISOString()} already passed — ` +
          `on-chain create_pot requires kickoff > now; skipping (this match can never get a Pot).`,
      );
      return;
    }
    try {
      const sig = await this.program.methods
        .createPot(Array.from(matchId), new BN(fixtureId), new BN(kickoffSec))
        .accounts({
          keeper: this.keeper.publicKey,
          config: config.configPda,
          pot: potPda,
          vault: vaultPda,
          usdcMint: config.usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      console.log(
        `[keeper] create_pot OK fixture=${fixtureId} pot=${potPda.toBase58()} vault=${vaultPda.toBase58()} kickoff=${kickoffSec} tx=${sig}`,
      );
    } catch (e: any) {
      console.error(`[keeper] create_pot FAILED fixture=${fixtureId}:`, e?.message ?? e, e?.logs ?? "");
    }
  }

  private async tryLockPot(potPda: PublicKey, fixtureId: number): Promise<void> {
    try {
      const sig = await this.program.methods.lockPot().accounts({ pot: potPda } as any).rpc();
      console.log(`[keeper] lock_pot OK fixture=${fixtureId} pot=${potPda.toBase58()} tx=${sig}`);
    } catch (e: any) {
      console.error(`[keeper] lock_pot FAILED fixture=${fixtureId} pot=${potPda.toBase58()}:`, e?.message ?? e, e?.logs ?? "");
    }
  }

  private async trySettlePot(
    config: OnchainConfigInfo,
    potPda: PublicKey,
    fixtureId: number,
    participant1IsHome: boolean,
  ): Promise<void> {
    // 1. Independently confirm the match is TERMINAL on TxLINE (same scan as
    //    TxlineMatchData/TxlineSettlementVerifier — the shared finalScoresEvent).
    let rows: TxScoresEvent[];
    try {
      const res = await fetch(`${this.cfg.txlineApiBaseUrl}/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        console.log(`[keeper] fixture ${fixtureId}: scores snapshot HTTP ${res.status} — not settling yet`);
        return;
      }
      const raw = (await res.json()) as TxScoresEvent[] | null;
      rows = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error(`[keeper] fixture ${fixtureId}: scores snapshot fetch failed:`, (e as Error).message);
      return;
    }
    const finalEvent = finalScoresEvent(rows);
    if (!finalEvent || finalEvent.Seq == null) {
      console.log(`[keeper] fixture ${fixtureId}: not terminal on TxLINE yet — waiting to settle`);
      return;
    }

    // 2. Fetch the Merkle proof bundle for exactly that terminal event.
    let bundle: StatValidationResponse;
    try {
      const url =
        `${this.cfg.txlineApiBaseUrl}/api/scores/stat-validation` +
        `?fixtureId=${fixtureId}&seq=${finalEvent.Seq}&statKey=1&statKey2=2`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        console.log(`[keeper] fixture ${fixtureId}: stat-validation HTTP ${res.status} (seq=${finalEvent.Seq}) — proof not posted yet`);
        return;
      }
      bundle = (await res.json()) as StatValidationResponse;
    } catch (e) {
      console.error(`[keeper] fixture ${fixtureId}: stat-validation fetch failed:`, (e as Error).message);
      return;
    }
    if (!isCompleteBundle(bundle)) {
      console.log(`[keeper] fixture ${fixtureId}: proof bundle incomplete (root not posted yet) — waiting`);
      return;
    }

    // 3. Map the bundle onto validate_stat's argument shapes (TxlineSettlementVerifier,
    //    reused as-is) — settle_pot takes the identical fixture_summary/fixture_proof/
    //    main_tree_proof/stat_home/stat_away shapes, it just bakes the predicate from
    //    winning_bucket instead of taking predicate/stat_b/op as arguments, so we
    //    pluck [ts, fixtureSummary, fixtureProof, mainTreeProof, _predicate, statHome, statAway, _op].
    const proven = provenScore(bundle, participant1IsHome);
    const winningBucket = proven.home > proven.away ? BUCKET_HOME : proven.home < proven.away ? BUCKET_AWAY : BUCKET_DRAW;
    const { dailyScoresPda, args } = buildValidateStatArgs(
      bundle,
      participant1IsHome,
      proven.home - proven.away,
      this.cfg.txoracleProgramId,
    );
    const [ts, fixtureSummary, fixtureProof, mainTreeProof, , statHome, statAway] = args as [
      BN,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];

    try {
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
      const sig = await this.program.methods
        .settlePot(winningBucket, ts, fixtureSummary as any, fixtureProof as any, mainTreeProof as any, statHome as any, statAway as any)
        .accounts({
          config: config.configPda,
          pot: potPda,
          txoracleProgram: config.txoracleProgram,
          dailyScoresMerkleRoots: dailyScoresPda,
        } as any)
        .preInstructions([computeBudgetIx])
        .rpc();
      console.log(
        `[keeper] settle_pot OK fixture=${fixtureId} pot=${potPda.toBase58()} winningBucket=${winningBucket} ` +
          `score=${proven.home}-${proven.away} seq=${finalEvent.Seq} tx=${sig}`,
      );
    } catch (e: any) {
      console.error(`[keeper] settle_pot FAILED fixture=${fixtureId}:`, e?.message ?? e, e?.logs ?? "");
    }
  }

  /**
   * Fetch + map the TxLINE proof for a finished fixture into the shapes both
   * settle_pot and settle_market take (identical proof; only the predicate the
   * program bakes differs). Returns null (with a log) if the match isn't terminal
   * or the proof root isn't posted yet — the tick just retries next pass. Mirrors
   * trySettlePot's steps 1-3 exactly.
   */
  private async fetchSettlementArgs(
    fixtureId: number,
    participant1IsHome: boolean,
  ): Promise<{
    ts: BN;
    fixtureSummary: unknown;
    fixtureProof: unknown;
    mainTreeProof: unknown;
    statHome: unknown;
    statAway: unknown;
    dailyScoresPda: PublicKey;
    proven: { home: number; away: number };
    seq: number;
  } | null> {
    let rows: TxScoresEvent[];
    try {
      const res = await fetch(`${this.cfg.txlineApiBaseUrl}/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        console.log(`[keeper] fixture ${fixtureId}: scores snapshot HTTP ${res.status} — not settling yet`);
        return null;
      }
      const raw = (await res.json()) as TxScoresEvent[] | null;
      rows = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error(`[keeper] fixture ${fixtureId}: scores snapshot fetch failed:`, (e as Error).message);
      return null;
    }
    const finalEvent = finalScoresEvent(rows);
    if (!finalEvent || finalEvent.Seq == null) {
      console.log(`[keeper] fixture ${fixtureId}: not terminal on TxLINE yet — waiting to settle`);
      return null;
    }

    let bundle: StatValidationResponse;
    try {
      const url =
        `${this.cfg.txlineApiBaseUrl}/api/scores/stat-validation` +
        `?fixtureId=${fixtureId}&seq=${finalEvent.Seq}&statKey=1&statKey2=2`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        console.log(`[keeper] fixture ${fixtureId}: stat-validation HTTP ${res.status} (seq=${finalEvent.Seq}) — proof not posted yet`);
        return null;
      }
      bundle = (await res.json()) as StatValidationResponse;
    } catch (e) {
      console.error(`[keeper] fixture ${fixtureId}: stat-validation fetch failed:`, (e as Error).message);
      return null;
    }
    if (!isCompleteBundle(bundle)) {
      console.log(`[keeper] fixture ${fixtureId}: proof bundle incomplete (root not posted yet) — waiting`);
      return null;
    }

    const proven = provenScore(bundle, participant1IsHome);
    const { dailyScoresPda, args } = buildValidateStatArgs(
      bundle,
      participant1IsHome,
      proven.home - proven.away,
      this.cfg.txoracleProgramId,
    );
    const [ts, fixtureSummary, fixtureProof, mainTreeProof, , statHome, statAway] = args as [
      BN,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    return { ts, fixtureSummary, fixtureProof, mainTreeProof, statHome, statAway, dailyScoresPda, proven, seq: finalEvent.Seq };
  }

  /**
   * Open a line-market pot AND attach its MarketSpec in ONE atomic transaction,
   * so a line pot never exists without the spec that lets settle_market run. The
   * spec fixes the predicate (op, line, stat leaves) on-chain before any calls, so
   * a permissionless settler can never change the line. Goals/full-time only for
   * now — that's the stat binding we've verified against a real proof.
   */
  private async tryCreateLinePot(
    config: OnchainConfigInfo,
    matchId: Buffer,
    potPda: PublicKey,
    vaultPda: PublicKey,
    fixtureId: number,
    kickoffMs: number,
    line: LineMarketSpec,
    participant1IsHome: boolean,
  ): Promise<void> {
    const kickoffSec = Math.floor(kickoffMs / 1000);
    if (kickoffSec <= Math.floor(Date.now() / 1000)) {
      console.warn(`[keeper] line pot fixture ${fixtureId}: kickoff already passed — skipping (can never get a pot)`);
      return;
    }
    if (line.stat !== "GOALS" || line.period !== "FULL") {
      console.warn(`[keeper] line market ${line.stat}/${line.period} not settleable yet — skipping pot creation`);
      return;
    }
    const kind = line.op === "ADD" ? MARKET_OVER_UNDER : MARKET_HANDICAP;
    const op = line.op === "ADD" ? OP_ADD : OP_SUB;
    const lineFloor = Math.floor(line.line);
    // stat_a = home goals, stat_b = away goals — which participant is home depends
    // on the fixture (must match the statHome/statAway the settle path passes).
    const homeKey = participant1IsHome ? STAT_KEY_P1_GOALS : STAT_KEY_P2_GOALS;
    const awayKey = participant1IsHome ? STAT_KEY_P2_GOALS : STAT_KEY_P1_GOALS;
    const [marketSpecPda] = PublicKey.findProgramAddressSync([MARKET_SPEC_SEED, potPda.toBuffer()], this.programId);
    try {
      const specIx = await this.program.methods
        .createMarketSpec(kind, op, lineFloor, homeKey, FULL_TIME_GOALS_PERIOD, awayKey, FULL_TIME_GOALS_PERIOD)
        .accounts({
          keeper: this.keeper.publicKey,
          config: config.configPda,
          pot: potPda,
          marketSpec: marketSpecPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();
      const sig = await this.program.methods
        .createPot(Array.from(matchId), new BN(fixtureId), new BN(kickoffSec))
        .accounts({
          keeper: this.keeper.publicKey,
          config: config.configPda,
          pot: potPda,
          vault: vaultPda,
          usdcMint: config.usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .postInstructions([specIx])
        .rpc();
      console.log(
        `[keeper] create line pot OK fixture=${fixtureId} pot=${potPda.toBase58()} kind=${kind} op=${op} lineFloor=${lineFloor} tx=${sig}`,
      );
    } catch (e: any) {
      console.error(`[keeper] create line pot FAILED fixture=${fixtureId}:`, e?.message ?? e, e?.logs ?? "");
    }
  }

  /**
   * Settle a locked line-market pot via settle_market: same proof as settle_pot,
   * winning bucket (OVER/UNDER) computed from the proven score by the same
   * resolveLine the read model uses. The on-chain predicate (from the MarketSpec)
   * re-proves it — a mismatch would just be rejected, never mis-settle.
   */
  private async trySettleMarket(
    config: OnchainConfigInfo,
    potPda: PublicKey,
    fixtureId: number,
    participant1IsHome: boolean,
    line: LineMarketSpec,
  ): Promise<void> {
    const s = await this.fetchSettlementArgs(fixtureId, participant1IsHome);
    if (!s) return;
    const outcome = resolveLine(line, s.proven);
    if (outcome !== LINE_BUCKETS.OVER && outcome !== LINE_BUCKETS.UNDER) {
      // Non-goals stat we can't resolve from the score → leave it; the pot voids
      // via timeout and refunds. (Only goals markets are created today.)
      console.log(`[keeper] fixture ${fixtureId}: line market (${line.stat}) not score-resolvable — leaving to void`);
      return;
    }
    const winningBucket = outcome === LINE_BUCKETS.OVER ? BUCKET_OVER : BUCKET_UNDER;
    const [marketSpecPda] = PublicKey.findProgramAddressSync([MARKET_SPEC_SEED, potPda.toBuffer()], this.programId);
    try {
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
      const sig = await this.program.methods
        .settleMarket(winningBucket, s.ts, s.fixtureSummary as any, s.fixtureProof as any, s.mainTreeProof as any, s.statHome as any, s.statAway as any)
        .accounts({
          config: config.configPda,
          pot: potPda,
          marketSpec: marketSpecPda,
          txoracleProgram: config.txoracleProgram,
          dailyScoresMerkleRoots: s.dailyScoresPda,
        } as any)
        .preInstructions([computeBudgetIx])
        .rpc();
      console.log(
        `[keeper] settle_market OK fixture=${fixtureId} pot=${potPda.toBase58()} winningBucket=${winningBucket} ` +
          `score=${s.proven.home}-${s.proven.away} line=${line.op}${line.line} seq=${s.seq} tx=${sig}`,
      );
    } catch (e: any) {
      console.error(`[keeper] settle_market FAILED fixture=${fixtureId}:`, e?.message ?? e, e?.logs ?? "");
    }
  }

  private async trySweepRake(config: OnchainConfigInfo, potPda: PublicKey, vaultPda: PublicKey, fixtureId: number): Promise<void> {
    const pot = await (this.program.account as any).pot.fetch(potPda);
    if (pot.rake.toString() === "0") return; // already swept (or a voided pot) — nothing to do, avoid a doomed tx

    const managerUsdc = getAssociatedTokenAddressSync(config.usdcMint, this.keeper.publicKey, false, TOKEN_PROGRAM_ID);
    const ataInfo = await this.connection.getAccountInfo(managerUsdc);
    if (!ataInfo) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(this.keeper.publicKey, managerUsdc, this.keeper.publicKey, config.usdcMint, TOKEN_PROGRAM_ID),
      );
      await this.provider.sendAndConfirm(tx, [this.keeper]);
    }
    try {
      const sig = await this.program.methods
        .sweepRake()
        .accounts({
          keeper: this.keeper.publicKey,
          config: config.configPda,
          pot: potPda,
          vault: vaultPda,
          managerUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
      console.log(`[keeper] sweep_rake OK fixture=${fixtureId} pot=${potPda.toBase58()} rake=${pot.rake.toString()} tx=${sig}`);
    } catch (e: any) {
      console.error(`[keeper] sweep_rake FAILED fixture=${fixtureId} pot=${potPda.toBase58()}:`, e?.message ?? e, e?.logs ?? "");
    }
  }
}
