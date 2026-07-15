use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::error::ErrorCode;
use crate::state::*;

/// One-time global setup: pin the USDC mint every Pot escrows in and the
/// txoracle program every settlement must CPI into.
pub fn handler(ctx: Context<InitConfig>, rake_bps: u16, min_participants: u8) -> Result<()> {
    require!(rake_bps <= 1_000, ErrorCode::RakeTooHigh); // hard cap 10%
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.txoracle_program = ctx.accounts.txoracle_program.key();
    c.rake_bps = rake_bps;
    c.min_participants = min_participants;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: recorded as the trusted oracle program id; every settle_pot
    /// verifies the passed txoracle program matches this address.
    pub txoracle_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
