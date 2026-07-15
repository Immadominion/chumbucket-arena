use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::*;

/// Escape hatch so stakes are NEVER trapped. A locked pot that can't settle —
/// postponed/abandoned match, or TxLINE never publishes a usable root — would
/// otherwise freeze every stake forever. This voids it, routing everyone to the
/// existing refund path in `claim`.
///
/// Two ways in, both safe:
///   - the config admin can void a locked pot at any time (operational rescue);
///   - ANYONE can void it once VOID_TIMEOUT_SEC has passed since kickoff
///     (permissionless backstop — the team can't strand funds by going away).
/// A settled pot can never be voided (winners are already owed), and a void is
/// idempotent-safe because it requires LOCKED.
pub fn handler(ctx: Context<VoidPot>) -> Result<()> {
    let pot = &mut ctx.accounts.pot;
    require!(pot.status == STATUS_LOCKED, ErrorCode::PotNotLocked);

    let is_admin = ctx.accounts.caller.key() == ctx.accounts.config.admin;
    if !is_admin {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= pot.kickoff + VOID_TIMEOUT_SEC, ErrorCode::VoidTooEarly);
    }

    pot.status = STATUS_VOID;
    Ok(())
}

#[derive(Accounts)]
pub struct VoidPot<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
}
