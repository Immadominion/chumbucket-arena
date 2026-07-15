//! Hand-mirrored CPI surface for TxLINE's `txoracle` program — there is no
//! published Rust CPI crate for it (checked; only a TS IDL/types package
//! exists), so the argument/account shapes here are copied byte-for-byte from
//! the vendored IDL (`vendor/txline/idl/txoracle.json` in the parent repo,
//! metadata.version 1.5.5) rather than generated. Only `validate_stat` is
//! mirrored — this program does not need any other txoracle instruction.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

/// Mainnet txoracle program id (devnet: 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J).
///
/// Deliberately a `pubkey!` const, not `declare_id!` — the latter is reserved
/// for a crate's *own* program id, and a second `declare_id!` in this crate
/// (for an external program reference) corrupted the generated IDL's
/// top-level address with TxLINE's id instead of this program's own.
pub mod txoracle_program_id {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");
}

/// Anchor global-instruction discriminator for `validate_stat`, copied from
/// the IDL (`sha256("global:validate_stat")[..8]`, precomputed by TxODDS).
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

/// Anchor-instruction arguments for `validate_stat`, in wire order.
#[derive(AnchorSerialize)]
struct ValidateStatArgs {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
}

/// CPI into txoracle's `validate_stat` (read-only view: no signer, no
/// writable accounts, no state change on either side) and return the bool
/// result. `daily_scores_merkle_roots` is the PDA
/// `["daily_scores_roots", epoch_day as u16 LE]` under the txoracle program
/// for the epoch day the stat's timestamp falls in.
#[allow(clippy::too_many_arguments)]
pub fn validate_stat<'info>(
    txoracle_program: &AccountInfo<'info>,
    daily_scores_merkle_roots: &AccountInfo<'info>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<bool> {
    let args = ValidateStatArgs {
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_a,
        stat_b,
        op,
    };
    let mut data = VALIDATE_STAT_DISCRIMINATOR.to_vec();
    args.serialize(&mut data)?;

    let ix = Instruction {
        program_id: *txoracle_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_merkle_roots.key, false)],
        data,
    };
    invoke(&ix, &[daily_scores_merkle_roots.clone(), txoracle_program.clone()])?;

    let (returned_program_id, return_data) =
        get_return_data().ok_or(error!(crate::error::ErrorCode::MissingTxlineReturnData))?;
    require_keys_eq!(
        returned_program_id,
        *txoracle_program.key,
        crate::error::ErrorCode::MissingTxlineReturnData
    );
    Ok(bool::try_from_slice(&return_data)?)
}
