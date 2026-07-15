use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::ErrorCode;
use crate::state::*;

/// Sweep a SETTLED pot's accrued house rake out of its vault to the manager's
/// treasury token account. ADMIN-ONLY.
///
/// The rake was set aside at settle time (losers' pool * rake_bps) and has sat
/// in the vault ever since — reserved for the house, never payable to players.
/// `settle_pot` deliberately leaves it in place; this is the only path that
/// moves it out.
///
/// FUND SAFETY — the sweep can NEVER dip into a winner's money:
///   outstanding = (winners_stake + distributable) − paid_out
///     = every USDC still owed to winners who haven't claimed yet.
///   We require the vault to STILL fully cover `outstanding` after the rake is
///   removed (free = vault.amount − outstanding, then free >= rake). At settle
///   this holds with exact equality — vault.amount == total_stake and
///   free == losers − distributable == rake — and every claim lowers vault.amount
///   and outstanding in lockstep, so it keeps holding for the pot's whole life.
///   The guard reads the REAL token balance (`vault.amount`), not a derived
///   figure, so any accounting drift fails the sweep CLOSED rather than
///   overdrawing a winner.
///
/// Idempotent: the sweep zeroes `pot.rake`, so a second call finds nothing to
/// sweep and reverts. A voided pot has rake == 0 by construction (the house
/// takes nothing on a refund), so there is never anything to sweep there.
pub fn handler(ctx: Context<SweepRake>) -> Result<()> {
    let pot = &ctx.accounts.pot;
    require!(pot.status == STATUS_SETTLED, ErrorCode::PotNotSettled);

    let rake = pot.rake;
    require!(rake > 0, ErrorCode::NothingToSweep);

    // USDC still owed to winners who have not yet claimed.
    let outstanding = pot
        .winners_stake
        .checked_add(pot.distributable)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_sub(pot.paid_out)
        .ok_or(ErrorCode::MathOverflow)?;

    // The vault must still fully cover every unclaimed winner once the rake is
    // gone. Guard on the ACTUAL on-chain balance so drift fails closed. Both
    // conditions are unreachable given the accounting (free == rake exactly),
    // but a fund-moving path defends the invariant rather than assuming it.
    let free = ctx
        .accounts
        .vault
        .amount
        .checked_sub(outstanding)
        .ok_or(ErrorCode::VaultUnderwater)?;
    require!(free >= rake, ErrorCode::RakeExceedsFree);

    // Move the rake out, signed by the Pot PDA (the vault's authority).
    let match_id = pot.match_id;
    let bump = pot.bump;
    let seeds: &[&[u8]] = &[POT_SEED, match_id.as_ref(), std::slice::from_ref(&bump)];
    let signer: &[&[&[u8]]] = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.manager_usdc.to_account_info(),
                authority: ctx.accounts.pot.to_account_info(),
            },
            signer,
        ),
        rake,
    )?;

    // Record the outflow (so vault.amount + paid_out == total_stake stays true)
    // and zero the rake — the idempotency guard for any repeat call.
    let pot = &mut ctx.accounts.pot;
    pot.paid_out = pot.paid_out.checked_add(rake).ok_or(ErrorCode::MathOverflow)?;
    pot.rake = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct SweepRake<'info> {
    /// The config admin (the keeper the backend runs) — the only signer allowed
    /// to move house revenue.
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
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
    /// The house treasury USDC account the rake is swept to. Must hold the
    /// config's USDC mint, and must not be the vault itself (a self-transfer
    /// would silently break the vault.amount + paid_out == total_stake ledger).
    /// The admin chooses which account — they own the house revenue.
    #[account(
        mut,
        constraint = manager_usdc.mint == config.usdc_mint @ ErrorCode::WrongMint,
        constraint = manager_usdc.key() != vault.key() @ ErrorCode::SweepToVault,
    )]
    pub manager_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
