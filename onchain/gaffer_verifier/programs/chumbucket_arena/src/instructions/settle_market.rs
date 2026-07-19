use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::*;
use crate::txoracle_cpi::{
    self, BinaryExpression, Comparison, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate,
};

/// Settle a two-outcome line/threshold market (over/under, handicap) by PROVING
/// its outcome on-chain, exactly like settle_pot but with the predicate coming
/// from the pot's MarketSpec instead of the hardcoded HOME/DRAW/AWAY map.
///
/// The predicate is `(stat_a [op] stat_b) <cmp> threshold`:
///   OVER  (bucket 0): (a [op] b) >  line_floor
///   UNDER (bucket 1): (a [op] b) <  line_floor + 1
/// On integer stats these are mutually exclusive and exhaustive (half-line, no
/// push), so a *permissionless* settler can only ever settle the side that truly
/// won — the losing side's proof returns false. Same money-safety guarantee as
/// settle_pot.
///
/// The SAME three proof bindings as settle_pot apply (fixture id, ts window, roots
/// PDA), PLUS the two stat leaves are bound to the spec's stat key/period so a
/// settler cannot substitute a different stat (e.g. corners for goals). The pot is
/// a normal Pot; place_call / lock_pot / claim / void_pot / sweep_rake are reused
/// unchanged, and this never touches the RESULT settle_pot path.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<SettleMarket>,
    winning_bucket: u8,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_a: StatTerm,
    stat_b: StatTerm,
) -> Result<()> {
    require!(
        winning_bucket == BUCKET_OVER || winning_bucket == BUCKET_UNDER,
        ErrorCode::InvalidBucket
    );
    require!(ctx.accounts.pot.status == STATUS_LOCKED, ErrorCode::PotNotLocked);

    let spec = &ctx.accounts.market_spec;
    // The spec must be the one bound to THIS pot (belt-and-suspenders on top of
    // the PDA seed constraint).
    require_keys_eq!(spec.pot, ctx.accounts.pot.key(), ErrorCode::WrongMarketSpec);

    // Bind each proof leaf to the spec's exact stat (key + period), so a settler
    // cannot settle an over/under-GOALS market with, say, a corners leaf.
    require!(
        stat_a.stat_to_prove.key == spec.stat_key_a && stat_a.stat_to_prove.period == spec.period_a,
        ErrorCode::WrongStat
    );
    require!(
        stat_b.stat_to_prove.key == spec.stat_key_b && stat_b.stat_to_prove.period == spec.period_b,
        ErrorCode::WrongStat
    );

    // (1) The proof must be for THIS pot's fixture.
    require!(
        fixture_summary.fixture_id == ctx.accounts.pot.txline_fixture_id,
        ErrorCode::WrongFixture
    );
    // (2) ts (unix MILLISECONDS) must fall in this match's window (kickoff SECONDS).
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

    // Thin pool: void with NO proof so funds are never trapped (same as settle_pot).
    let min_participants = ctx.accounts.config.min_participants as u32;
    if ctx.accounts.pot.participants < min_participants {
        ctx.accounts.pot.status = STATUS_VOID;
        return Ok(());
    }

    // Build the predicate this claimed side implies, from the spec.
    let (threshold, comparison, op) = line_predicate(spec.op, spec.line_floor, winning_bucket)?;
    let predicate = TraderPredicate { threshold, comparison };

    let proven = txoracle_cpi::validate_stat(
        &ctx.accounts.txoracle_program.to_account_info(),
        &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_a,
        Some(stat_b),
        Some(op),
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

    // Losers' pool = everything NOT on the winning bucket. Compute from the LOCAL
    // winners_stake, NOT pot.winners_stake (still 0 until written below) — the same
    // live-devnet correctness rule as settle_pot.
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
    Ok(())
}

/// Derive the `validate_stat` predicate a claimed line-market outcome implies.
///
/// Pure (no accounts, no clock) so it is unit-testable — it is the one novel bit
/// of money logic in this instruction. The line is a half-line (`line_floor + 0.5`):
///   OVER  (bucket 0): (a [op] b) >  line_floor
///   UNDER (bucket 1): (a [op] b) <  line_floor + 1
/// On integer stats these partition every value with no overlap and no gap, so
/// exactly one side is provable — that is the money-safety property that lets a
/// permissionless caller settle only the side that truly won.
pub fn line_predicate(
    op_code: u8,
    line_floor: i32,
    winning_bucket: u8,
) -> Result<(i32, Comparison, BinaryExpression)> {
    let (threshold, comparison) = match winning_bucket {
        BUCKET_OVER => (line_floor, Comparison::GreaterThan),
        BUCKET_UNDER => (
            line_floor.checked_add(1).ok_or(ErrorCode::MathOverflow)?,
            Comparison::LessThan,
        ),
        _ => return err!(ErrorCode::InvalidBucket),
    };
    let op = match op_code {
        OP_ADD => BinaryExpression::Add,
        OP_SUB => BinaryExpression::Subtract,
        _ => return err!(ErrorCode::InvalidMarketKind),
    };
    Ok((threshold, comparison, op))
}

#[cfg(test)]
mod tests {
    use super::*;

    // O/U 2.5 goals: floor = 2. A game with 5 goals is OVER.
    #[test]
    fn over_under_half_line_partitions_with_no_push() {
        let (t_over, c_over, op_over) = line_predicate(OP_ADD, 2, BUCKET_OVER).unwrap();
        assert_eq!((t_over, c_over, op_over), (2, Comparison::GreaterThan, BinaryExpression::Add));
        let (t_under, c_under, op_under) = line_predicate(OP_ADD, 2, BUCKET_UNDER).unwrap();
        assert_eq!((t_under, c_under, op_under), (3, Comparison::LessThan, BinaryExpression::Add));

        // Exhaustive + exclusive over every integer total: exactly one side true.
        for total in -1..=12i32 {
            let over = total > t_over; // sum > 2
            let under = total < t_under; // sum < 3
            assert!(over ^ under, "total {total}: over={over} under={under} must be exactly one");
        }
    }

    // Handicap -1.5 for the home side: floor = 1, op = Subtract.
    #[test]
    fn handicap_half_line_partitions_with_no_push() {
        let (t_h, c_h, op_h) = line_predicate(OP_SUB, 1, BUCKET_OVER).unwrap();
        assert_eq!((t_h, c_h, op_h), (1, Comparison::GreaterThan, BinaryExpression::Subtract));
        let (t_a, c_a, op_a) = line_predicate(OP_SUB, 1, BUCKET_UNDER).unwrap();
        assert_eq!((t_a, c_a, op_a), (2, Comparison::LessThan, BinaryExpression::Subtract));

        // margin = home - away; -1.5 handicap: home covers iff margin >= 2.
        for margin in -6..=6i32 {
            let home_covers = margin > t_h; // margin > 1  => margin >= 2
            let away_covers = margin < t_a; // margin < 2  => margin <= 1
            assert!(home_covers ^ away_covers, "margin {margin}");
        }
    }

    #[test]
    fn rejects_bad_bucket_and_op() {
        assert!(line_predicate(OP_ADD, 2, 2).is_err()); // bucket 2 invalid for a 2-way market
        assert!(line_predicate(9, 2, BUCKET_OVER).is_err()); // unknown op
    }
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
    #[account(
        seeds = [MARKET_SPEC_SEED, pot.key().as_ref()],
        bump = market_spec.bump,
    )]
    pub market_spec: Account<'info, MarketSpec>,
    /// CHECK: the CPI target, pinned to the config's trusted txoracle program id.
    #[account(address = config.txoracle_program @ ErrorCode::WrongTxoracleProgram)]
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: validated in the handler to be txoracle's `daily_scores_roots` PDA.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}
