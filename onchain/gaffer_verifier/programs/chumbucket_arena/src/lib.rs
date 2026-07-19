//! gaffer_pool — the on-chain parimutuel settlement engine behind The Gaffer.
//!
//! Real USDC for each World Cup match is escrowed in a per-Pot vault PDA. A Pot
//! settles only when `settle_pot` PROVES the outcome on-chain by CPI into
//! TxLINE's `validate_stat` — no server verdict ever touches the money path.
//! Winners then pull their own pro-rata payout via `claim`. If the backend
//! vanished, every winner could still claim straight from the program.
//!
//! `verify_match_stat` remains as a standalone read-only proof helper (handy for
//! the client-side "verify this payout yourself" receipt), but it is no longer
//! the whole story — the settlement lives on-chain now.

pub mod error;
pub mod instructions;
pub mod state;
pub mod txoracle_cpi;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use state::*;
pub use txoracle_cpi::{
    BinaryExpression, Comparison, ProofNode, ScoreStat, ScoresBatchSummary, ScoresUpdateStats,
    StatTerm, TraderPredicate,
};

declare_id!("AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG");

#[program]
pub mod chumbucket_arena {
    use super::*;

    /// One-time: pin the USDC mint + txoracle program, set rake + thin-pool floor.
    pub fn init_config(ctx: Context<InitConfig>, rake_bps: u16, min_participants: u8) -> Result<()> {
        instructions::init_config::handler(ctx, rake_bps, min_participants)
    }

    /// Open a match's parimutuel Pot and its USDC vault.
    pub fn create_pot(ctx: Context<CreatePot>, match_id: [u8; 32], txline_fixture_id: i64, kickoff: i64) -> Result<()> {
        instructions::create_pot::handler(ctx, match_id, txline_fixture_id, kickoff)
    }

    /// Attach a line-market (over/under, handicap) settlement spec to a Pot.
    /// Admin-only, before any calls — fixes the line/stats on-chain up front.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market_spec(
        ctx: Context<CreateMarketSpec>,
        kind: u8,
        op: u8,
        line_floor: i32,
        stat_key_a: u32,
        period_a: i32,
        stat_key_b: u32,
        period_b: i32,
    ) -> Result<()> {
        instructions::create_market_spec::handler(ctx, kind, op, line_floor, stat_key_a, period_a, stat_key_b, period_b)
    }

    /// Stake USDC on an outcome — funds move into the vault now.
    pub fn place_call(ctx: Context<PlaceCall>, bucket: u8, amount: u64) -> Result<()> {
        instructions::place_call::handler(ctx, bucket, amount)
    }

    /// Freeze calls at kickoff (permissionless).
    pub fn lock_pot(ctx: Context<LockPot>) -> Result<()> {
        instructions::lock_pot::handler(ctx)
    }

    /// Settle by proving the outcome on-chain via a `validate_stat` CPI.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_pot(
        ctx: Context<SettlePot>,
        winning_bucket: u8,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_home: StatTerm,
        stat_away: StatTerm,
    ) -> Result<()> {
        instructions::settle_pot::handler(ctx, winning_bucket, ts, fixture_summary, fixture_proof, main_tree_proof, stat_home, stat_away)
    }

    /// Settle a line-market Pot (over/under, handicap) by proving its outcome via
    /// validate_stat, using the predicate stored in the pot's MarketSpec. Does not
    /// touch the RESULT settle_pot path.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        winning_bucket: u8,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: StatTerm,
    ) -> Result<()> {
        instructions::settle_market::handler(ctx, winning_bucket, ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b)
    }

    /// Rescue: void a stuck locked pot (admin any time; anyone after timeout).
    pub fn void_pot(ctx: Context<VoidPot>) -> Result<()> {
        instructions::void_pot::handler(ctx)
    }

    /// Sweep a settled pot's accrued house rake out to the manager treasury
    /// (admin-only; can never touch a winner's unclaimed payout).
    pub fn sweep_rake(ctx: Context<SweepRake>) -> Result<()> {
        instructions::sweep_rake::handler(ctx)
    }

    /// Pull your own payout (or refund on a void). Closes the position.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    /// Standalone read-only proof check (client-side "verify it yourself" helper).
    #[allow(clippy::too_many_arguments)]
    pub fn verify_match_stat(
        ctx: Context<VerifyMatchStat>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        predicate: TraderPredicate,
        stat_home: StatTerm,
        stat_away: StatTerm,
        op: BinaryExpression,
    ) -> Result<bool> {
        instructions::verify_match_stat::handler(ctx, ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_home, stat_away, op)
    }
}
