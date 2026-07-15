use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::ErrorCode;
use crate::state::*;

/// Pull-based settlement: each player claims their own USDC after the Pot is
/// settled (or refunds after a void). Winners get stake back plus a pro-rata
/// slice of the losers' pool; losers get nothing; a void refunds every stake.
/// The USDC leaves the vault signed by the Pot PDA's own seeds, and the
/// Position account is closed to the player (rent back + a hard double-claim
/// guard: a second claim finds no account).
///
///   winner payout = stake + distributable * stake / winners_stake   (u128 math)
///
/// Rounding: each claim FLOORS its share and the sub-frost dust stays in the
/// vault (pull-based claims can't redistribute dust without tracking order at CU
/// cost). The off-chain instant ledger (src/game/parimutuel.ts) redistributes
/// that dust instead; the two agree to the floor and diverge only by < winners
/// frost. Together with `sweep_rake`, whatever the vault retains after all claims
/// is exactly that dust — a few millionths of a USDC, never a winner's money.
pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let pot = &ctx.accounts.pot;
    let position = &ctx.accounts.position;

    let payout: u64 = match pot.status {
        STATUS_VOID => position.stake,
        STATUS_SETTLED => {
            if position.bucket == pot.winning_bucket {
                let extra = (pot.distributable as u128)
                    .checked_mul(position.stake as u128)
                    .and_then(|v| v.checked_div(pot.winners_stake as u128))
                    .ok_or(ErrorCode::MathOverflow)?;
                (position.stake as u128)
                    .checked_add(extra)
                    .ok_or(ErrorCode::MathOverflow)? as u64
            } else {
                0
            }
        }
        _ => return err!(ErrorCode::PotNotSettled),
    };

    if payout > 0 {
        // Vault authority is the Pot PDA — sign the transfer out with its seeds.
        let match_id = pot.match_id;
        let bump = pot.bump;
        let seeds: &[&[u8]] = &[POT_SEED, match_id.as_ref(), std::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_usdc.to_account_info(),
                    authority: ctx.accounts.pot.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
        let pot = &mut ctx.accounts.pot;
        pot.paid_out = pot.paid_out.checked_add(payout).ok_or(ErrorCode::MathOverflow)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Claim<'info> {
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
        mut,
        close = player,
        seeds = [POSITION_SEED, pot.key().as_ref(), player.key().as_ref()],
        bump = position.bump,
        constraint = position.player == player.key(),
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}
