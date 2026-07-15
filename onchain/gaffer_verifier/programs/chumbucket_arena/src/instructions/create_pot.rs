use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::ErrorCode;
use crate::state::*;

/// Open a parimutuel Pot for one fixture's RESULT market and create its USDC
/// vault (a token account owned by the Pot PDA). ADMIN-ONLY: the (match_id ->
/// txline_fixture_id) binding is trust-critical — settlement proves against
/// txline_fixture_id, so a wrong binding would settle the wrong game. Only the
/// config admin (the keeper the backend runs) may open pots.
///
/// `kickoff` is unix SECONDS (matches Solana Clock and place_call/lock_pot).
pub fn handler(ctx: Context<CreatePot>, match_id: [u8; 32], txline_fixture_id: i64, kickoff: i64) -> Result<()> {
    // Kickoff must be in the future but not absurdly far (anti-squat / anti-stale
    // so lock_pot actually fires and calls can't be placed during a live match).
    let now = Clock::get()?.unix_timestamp;
    require!(kickoff > now, ErrorCode::KickoffInvalid);
    require!(kickoff <= now + MAX_KICKOFF_LEAD_SEC, ErrorCode::KickoffInvalid);

    let pot = &mut ctx.accounts.pot;
    pot.match_id = match_id;
    pot.txline_fixture_id = txline_fixture_id;
    pot.kickoff = kickoff;
    pot.status = STATUS_OPEN;
    pot.winning_bucket = 0;
    pot.participants = 0;
    pot.bucket_totals = [0; N_BUCKETS];
    pot.total_stake = 0;
    pot.rake = 0;
    pot.distributable = 0;
    pot.winners_stake = 0;
    pot.paid_out = 0;
    pot.vault_bump = ctx.bumps.vault;
    pot.bump = ctx.bumps.pot;
    Ok(())
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct CreatePot<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Pot::INIT_SPACE,
        seeds = [POT_SEED, match_id.as_ref()],
        bump,
    )]
    pub pot: Account<'info, Pot>,
    /// The USDC vault — a token account owned by the Pot PDA. Funds only leave
    /// via `claim`, signed by the Pot's own seeds after settlement.
    #[account(
        init,
        payer = keeper,
        seeds = [VAULT_SEED, pot.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pot,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
