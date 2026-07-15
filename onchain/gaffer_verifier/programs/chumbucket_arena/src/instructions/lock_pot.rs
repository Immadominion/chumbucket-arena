use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::*;

/// Freeze calls at kickoff. Permissionless — anyone (a keeper, or the first
/// player to try a late call) can lock a Pot once its kickoff has passed, so
/// no bet can be placed on in-progress information.
pub fn handler(ctx: Context<LockPot>) -> Result<()> {
    let pot = &mut ctx.accounts.pot;
    require!(pot.status == STATUS_OPEN, ErrorCode::PotNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= pot.kickoff, ErrorCode::NotKickedOff);
    pot.status = STATUS_LOCKED;
    Ok(())
}

#[derive(Accounts)]
pub struct LockPot<'info> {
    #[account(
        mut,
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
}
