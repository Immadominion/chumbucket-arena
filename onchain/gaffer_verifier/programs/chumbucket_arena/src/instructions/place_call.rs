use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::ErrorCode;
use crate::state::*;

/// Stake `amount` USDC on a bucket. The USDC moves from the player's token
/// account into the Pot's vault PDA here and now — the stake is real and
/// escrowed on-chain before kickoff, not an entry in our database.
///
/// One Position per (pot, player); re-calling adds to the same bucket. Signing
/// can be the player's own wallet or (for the custodial Privy UX) the Sessions
/// wallet acting as the source account's authority — the program only cares
/// that the source token account's owner signed.
pub fn handler(ctx: Context<PlaceCall>, bucket: u8, amount: u64) -> Result<()> {
    require!((bucket as usize) < N_BUCKETS, ErrorCode::InvalidBucket);
    require!(amount > 0, ErrorCode::ZeroStake);

    let pot = &mut ctx.accounts.pot;
    require!(pot.status == STATUS_OPEN, ErrorCode::PotNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < pot.kickoff, ErrorCode::PotNotOpen); // calls lock at kickoff

    // Move real USDC player -> vault. (Anchor 1.x CpiContext::new takes the
    // program id by value; token::transfer targets the SPL token program.)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.player_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ),
        amount,
    )?;

    let position = &mut ctx.accounts.position;
    if position.stake == 0 {
        // fresh position
        position.pot = pot.key();
        position.player = ctx.accounts.player.key();
        position.bucket = bucket;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        pot.participants = pot.participants.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    } else {
        // adding to an existing call must stay on the same bucket
        require!(position.bucket == bucket, ErrorCode::InvalidBucket);
    }
    position.stake = position.stake.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;

    pot.bucket_totals[bucket as usize] = pot.bucket_totals[bucket as usize]
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    pot.total_stake = pot.total_stake.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct PlaceCall<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
    #[account(
        mut,
        seeds = [VAULT_SEED, pot.key().as_ref()],
        bump = pot.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = player_usdc.mint == vault.mint,
        constraint = player_usdc.owner == player.key(),
    )]
    pub player_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, pot.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
