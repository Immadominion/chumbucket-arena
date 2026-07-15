use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::*;
use crate::txoracle_cpi::{
    self, BinaryExpression, Comparison, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate,
};

/// Settle a Pot by PROVING its outcome on-chain. The caller names the winning
/// bucket and supplies TxLINE's Merkle proof bundle; this CPIs into txoracle
/// `validate_stat` ONCE with the predicate that bucket implies:
///   HOME: (home - away) >  0    DRAW: == 0    AWAY: < 0
///
/// SECURITY — the proof is bound to THIS pot three ways, or it means nothing:
///   1. `fixture_summary.fixture_id` must equal `pot.txline_fixture_id` (else a
///      genuine proof from a *different* match could settle this pot — theft).
///   2. `ts` must fall inside this pot's match window (kickoff .. +window), so a
///      caller can't pick a historical day's snapshot.
///   3. `daily_scores_merkle_roots` must be the txoracle PDA for `ts`'s epoch
///      day (else a caller supplies a roots account for the wrong day).
/// Only then does a `true` return authorise settlement. No human verdict ever
/// touches the money path. One CPI keeps us inside the compute budget.
///
/// A thin pool (too few participants) voids WITHOUT a proof — pure on-chain
/// state — so a match that never gets a root can still refund. A proven bucket
/// with no stakers also voids.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<SettlePot>,
    winning_bucket: u8,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_home: StatTerm,
    stat_away: StatTerm,
) -> Result<()> {
    require!((winning_bucket as usize) < N_BUCKETS, ErrorCode::InvalidBucket);
    require!(ctx.accounts.pot.status == STATUS_LOCKED, ErrorCode::PotNotLocked);

    // (1) The proof must be for THIS pot's fixture.
    require!(
        fixture_summary.fixture_id == ctx.accounts.pot.txline_fixture_id,
        ErrorCode::WrongFixture
    );
    // (2) ts (unix MILLISECONDS, per TxLINE) must fall in this match's window.
    // kickoff is stored in unix SECONDS.
    let ts_sec = ts.checked_div(MS_PER_SEC).ok_or(ErrorCode::MathOverflow)?;
    require!(
        ts_sec >= ctx.accounts.pot.kickoff
            && ts_sec <= ctx.accounts.pot.kickoff + MATCH_WINDOW_SEC,
        ErrorCode::TimestampOutOfWindow
    );
    // (3) The roots account must be txoracle's daily_scores_roots PDA for ts's day.
    let epoch_day = (ts / MS_PER_DAY) as u16;
    let (expected_roots, _bump) = Pubkey::find_program_address(
        &[DAILY_SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()],
        &ctx.accounts.config.txoracle_program,
    );
    require_keys_eq!(
        ctx.accounts.daily_scores_merkle_roots.key(),
        expected_roots,
        ErrorCode::WrongRootsAccount
    );

    // Thin pool: void with NO proof (pure state) so funds are never trapped.
    let min_participants = ctx.accounts.config.min_participants as u32;
    if ctx.accounts.pot.participants < min_participants {
        ctx.accounts.pot.status = STATUS_VOID;
        return Ok(());
    }

    // Prove the claimed outcome on-chain — the one trust-critical call.
    let comparison = match winning_bucket {
        BUCKET_HOME => Comparison::GreaterThan,
        BUCKET_DRAW => Comparison::EqualTo,
        BUCKET_AWAY => Comparison::LessThan,
        _ => return err!(ErrorCode::InvalidBucket),
    };
    let predicate = TraderPredicate { threshold: 0, comparison };
    let proven = txoracle_cpi::validate_stat(
        &ctx.accounts.txoracle_program.to_account_info(),
        &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_home,
        Some(stat_away),
        Some(BinaryExpression::Subtract),
    )?;
    require!(proven, ErrorCode::ProofRejected);

    let config = &ctx.accounts.config;
    let pot = &mut ctx.accounts.pot;
    let winners_stake = pot.bucket_totals[winning_bucket as usize];

    // Proven winner, but nobody staked it -> void (everyone refunds).
    if winners_stake == 0 {
        pot.status = STATUS_VOID;
        return Ok(());
    }

    // Losers' pool = everything NOT on the winning bucket. Compute from the
    // LOCAL winners_stake (line above), NOT pot.winners_stake — the stored field
    // isn't written until below, so reading it here would see 0 and treat the
    // ENTIRE pot as losers (over-inflating rake+distributable so the winner's
    // computed payout exceeds the vault → claim fails). Found live on devnet.
    let losers = pot
        .total_stake
        .checked_sub(winners_stake)
        .ok_or(ErrorCode::MathOverflow)?;
    let rake = (losers as u128)
        .checked_mul(config.rake_bps as u128)
        .and_then(|v| v.checked_div(BPS_DENOM as u128))
        .ok_or(ErrorCode::MathOverflow)? as u64;
    let distributable = losers.checked_sub(rake).ok_or(ErrorCode::MathOverflow)?;

    pot.winning_bucket = winning_bucket;
    pot.winners_stake = winners_stake;
    pot.rake = rake;
    pot.distributable = distributable;
    pot.status = STATUS_SETTLED;
    // Rake stays in the vault until admin `sweep_rake` (not payable to players).
    Ok(())
}

#[derive(Accounts)]
pub struct SettlePot<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
    /// CHECK: the CPI target, pinned to the config's trusted txoracle program id.
    #[account(address = config.txoracle_program @ ErrorCode::WrongTxoracleProgram)]
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: validated in the handler to be txoracle's `daily_scores_roots` PDA
    /// for `ts`'s epoch day (require_keys_eq against the derived address).
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}
