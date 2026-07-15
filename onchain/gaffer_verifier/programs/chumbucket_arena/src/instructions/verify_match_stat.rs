use anchor_lang::prelude::*;

use crate::txoracle_cpi::{
    self, txoracle_program_id, BinaryExpression, ProofNode, ScoresBatchSummary, StatTerm,
    TraderPredicate,
};

/// Read-only proof check: CPIs into TxLINE's `validate_stat` to confirm whether
/// a fixture's (home_goals − away_goals) satisfies `predicate`, against TxLINE's
/// Merkle-committed on-chain scores feed. Mutates no state and moves no funds —
/// it's the standalone verification primitive behind the client-side "verify
/// this payout yourself" receipt. The money path proper lives in `settle_pot`,
/// which runs the same CPI as the gate on real USDC release.
#[allow(clippy::too_many_arguments)]
pub fn handler(
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
    let verified = txoracle_cpi::validate_stat(
        &ctx.accounts.txoracle_program.to_account_info(),
        &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_home,
        Some(stat_away),
        Some(op),
    )?;
    msg!("chumbucket_arena: validate_stat result = {}", verified);
    Ok(verified)
}

#[derive(Accounts)]
pub struct VerifyMatchStat<'info> {
    /// CHECK: the CPI target — address-constrained to the known txoracle
    /// program id below, so no further validation of its contents is needed.
    #[account(address = txoracle_program_id::ID)]
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: the `daily_scores_roots` PDA under txoracle for the epoch day of
    /// this stat. txoracle's own handler validates this account's
    /// owner/PDA derivation internally — we pass it through untouched as the
    /// CPI account, so this program does no independent validation of it.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}
