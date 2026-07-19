use anchor_lang::prelude::*;

/// RESULT-market outcome buckets. Index maps 1:1 to `bucket_totals`.
pub const BUCKET_HOME: u8 = 0;
pub const BUCKET_DRAW: u8 = 1;
pub const BUCKET_AWAY: u8 = 2;
pub const N_BUCKETS: usize = 3;

/// Two-outcome line/threshold markets (over/under, handicap) reuse a normal Pot
/// but stake into buckets 0 and 1 only. Bucket 0 = the "over" side (the stat
/// expression is GREATER than the line); bucket 1 = the "under" side (LESS).
pub const BUCKET_OVER: u8 = 0;
pub const BUCKET_UNDER: u8 = 1;

/// MarketSpec kinds — how settle_market builds its validate_stat predicate.
pub const MARKET_OVER_UNDER: u8 = 1; // op = Add:  (stat_a + stat_b)  vs line
pub const MARKET_HANDICAP: u8 = 2; // op = Subtract: (stat_a - stat_b) vs line

/// Binary op the settlement predicate applies to the two stat terms.
pub const OP_ADD: u8 = 0;
pub const OP_SUB: u8 = 1;

/// Pot lifecycle.
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_LOCKED: u8 = 1;
pub const STATUS_SETTLED: u8 = 2;
pub const STATUS_VOID: u8 = 3;

pub const BPS_DENOM: u64 = 10_000;

/// Time units. Solana's Clock is unix SECONDS; TxLINE score timestamps are
/// unix MILLISECONDS. Pot.kickoff is stored in SECONDS to match Clock.
pub const MS_PER_SEC: i64 = 1_000;
pub const MS_PER_DAY: i64 = 86_400_000;
/// How long after kickoff a settlement proof's timestamp may fall (covers full
/// time + stoppage + ET + a margin) — bounds which day's roots can settle a pot.
pub const MATCH_WINDOW_SEC: i64 = 6 * 60 * 60; // 6h
/// After this long with no settlement, a locked pot can be force-voided so
/// stakes are never trapped by a postponed match or a missing root.
pub const VOID_TIMEOUT_SEC: i64 = 7 * 24 * 60 * 60; // 7 days
/// Longest a pot may be created ahead of its kickoff (anti-squat / anti-stale).
pub const MAX_KICKOFF_LEAD_SEC: i64 = 90 * 24 * 60 * 60; // 90 days (~3 months)

/// PDA seeds (ours).
pub const CONFIG_SEED: &[u8] = b"config";
pub const POT_SEED: &[u8] = b"pot";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
/// One MarketSpec per line-market Pot (seed = [MARKET_SPEC_SEED, pot.key()]).
pub const MARKET_SPEC_SEED: &[u8] = b"market_spec";
/// txoracle's daily scores-roots PDA seed prefix (external program).
pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";

/// Global program config — one per deployment. Pins the USDC mint every Pot
/// escrows in and the txoracle program every settlement CPIs into, so a Pot
/// can never be steered at an attacker-controlled mint or a fake oracle.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub txoracle_program: Pubkey,
    /// House cut of the losers' pool, in basis points, routed to the Manager's Pot.
    pub rake_bps: u16,
    /// Below this many distinct positions a Pot voids and refunds (thin-pool guard).
    pub min_participants: u8,
    pub bump: u8,
}

/// One parimutuel Pot per (fixture, RESULT market). Holds real USDC in its
/// vault PDA — funds only leave via `claim`, and only after `settle_pot` has
/// proven the outcome on-chain by CPI into txoracle's `validate_stat`.
#[account]
#[derive(InitSpace)]
pub struct Pot {
    /// Stable id for this market (the backend's MatchId, ascii, left-padded).
    pub match_id: [u8; 32],
    /// TxLINE's numeric fixture id — what settlement proves against.
    pub txline_fixture_id: i64,
    pub kickoff: i64,
    pub status: u8,
    /// Valid once SETTLED: which bucket the on-chain proof confirmed won.
    pub winning_bucket: u8,
    pub participants: u32,
    /// USDC staked per bucket, index = bucket.
    pub bucket_totals: [u64; N_BUCKETS],
    pub total_stake: u64,
    /// Set at settle: house rake taken from the losers' pool.
    pub rake: u64,
    /// Set at settle: losers' pool minus rake, split pro-rata among winners.
    pub distributable: u64,
    /// Set at settle: total stake in the winning bucket (the pro-rata denominator).
    pub winners_stake: u64,
    /// USDC that has left the vault — winner claims plus swept rake. Together
    /// with the live balance this reconciles exactly: vault.amount + paid_out
    /// == total_stake, for the pot's whole life.
    pub paid_out: u64,
    pub vault_bump: u8,
    pub bump: u8,
}

impl Pot {
    /// Losers' pool AFTER settlement (valid only once `winners_stake` is stored).
    /// NOTE: do NOT call this inside settle_pot before `winners_stake` is written —
    /// it would read the still-zero field. settle_pot computes losers from its
    /// local winners_stake for exactly that reason. Kept for read-only/off-chain
    /// use where the pot is already settled.
    pub fn losers_stake(&self) -> u64 {
        self.total_stake.saturating_sub(self.winners_stake)
    }
}

/// A single player's stake in one Pot's bucket. Pull-based: the player calls
/// `claim` themselves after settlement, so a Pot with thousands of players
/// never blows the compute budget on a settle-time payout loop.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pot: Pubkey,
    pub player: Pubkey,
    pub bucket: u8,
    pub stake: u64,
    pub claimed: bool,
    pub bump: u8,
}

/// The settlement predicate for a two-outcome line/threshold market (over/under,
/// handicap), bound to its Pot at creation so a *permissionless* settler can
/// never change the line or the stats it settles against. The Pot stays a normal
/// Pot (buckets 0 = over, 1 = under); only settle_market differs from settle_pot.
///
/// The line is stored as an integer FLOOR and always read as `line_floor + 0.5`,
/// so every market is a HALF-line: OVER wins iff `(a [op] b) > line_floor`, UNDER
/// wins iff `(a [op] b) < line_floor + 1`. On integer stats these two are mutually
/// exclusive and exhaustive — no push is representable — so proving the *claimed*
/// side is sufficient (the losing side's proof returns false), exactly like the
/// HOME/DRAW/AWAY invariant in settle_pot.
#[account]
#[derive(InitSpace)]
pub struct MarketSpec {
    /// The Pot this spec settles (must match SettleMarket.pot).
    pub pot: Pubkey,
    /// MARKET_OVER_UNDER | MARKET_HANDICAP (display + backend routing).
    pub kind: u8,
    /// OP_ADD (over/under) | OP_SUB (handicap) — applied as stat_a [op] stat_b.
    pub op: u8,
    /// Half-line floor: O/U 2.5 -> 2, handicap -1.5 -> 1.
    pub line_floor: i32,
    /// The exact stat leaf each term must prove (binds the proof to the right
    /// stat, e.g. goals vs corners). key/period match txoracle's ScoreStat.
    pub stat_key_a: u32,
    pub period_a: i32,
    pub stat_key_b: u32,
    pub period_b: i32,
    pub bump: u8,
}
