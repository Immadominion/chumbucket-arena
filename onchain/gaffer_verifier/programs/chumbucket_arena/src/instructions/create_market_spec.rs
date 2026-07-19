use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::*;

/// Attach a line-market settlement spec to an already-created Pot. ADMIN-ONLY and
/// callable only BEFORE any calls are placed — the line and the stats it settles
/// against are trust-critical (they decide the winner), so they are fixed on-chain
/// before anyone can stake, and a *permissionless* settle_market can never change
/// them. The Pot itself is a normal Pot; this just declares "settle it as a line
/// market" instead of the built-in HOME/DRAW/AWAY result.
///
/// `line_floor` is the integer floor of a half-line (O/U 2.5 -> 2, handicap -1.5 ->
/// 1); see MarketSpec for why half-lines make settlement exhaustive with no push.
pub fn handler(
    ctx: Context<CreateMarketSpec>,
    kind: u8,
    op: u8,
    line_floor: i32,
    stat_key_a: u32,
    period_a: i32,
    stat_key_b: u32,
    period_b: i32,
) -> Result<()> {
    require!(
        kind == MARKET_OVER_UNDER || kind == MARKET_HANDICAP,
        ErrorCode::InvalidMarketKind
    );
    require!(op == OP_ADD || op == OP_SUB, ErrorCode::InvalidMarketKind);

    // The pot must be open and untouched: fixing the line only matters if it is
    // set before anyone bets against it.
    require!(ctx.accounts.pot.status == STATUS_OPEN, ErrorCode::PotNotOpen);
    require!(ctx.accounts.pot.participants == 0, ErrorCode::SpecAfterCalls);

    let spec = &mut ctx.accounts.market_spec;
    spec.pot = ctx.accounts.pot.key();
    spec.kind = kind;
    spec.op = op;
    spec.line_floor = line_floor;
    spec.stat_key_a = stat_key_a;
    spec.period_a = period_a;
    spec.stat_key_b = stat_key_b;
    spec.period_b = period_b;
    spec.bump = ctx.bumps.market_spec;
    Ok(())
}

#[derive(Accounts)]
pub struct CreateMarketSpec<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [POT_SEED, pot.match_id.as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,
    #[account(
        init,
        payer = keeper,
        space = 8 + MarketSpec::INIT_SPACE,
        seeds = [MARKET_SPEC_SEED, pot.key().as_ref()],
        bump,
    )]
    pub market_spec: Account<'info, MarketSpec>,
    pub system_program: Program<'info, System>,
}
