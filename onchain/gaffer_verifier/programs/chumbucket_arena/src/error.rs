use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("txoracle CPI did not return the expected bool return-data")]
    MissingTxlineReturnData,
    #[msg("rake basis points exceed the 10% ceiling")]
    RakeTooHigh,
    #[msg("bucket must be 0 (HOME), 1 (DRAW) or 2 (AWAY)")]
    InvalidBucket,
    #[msg("stake must be greater than zero")]
    ZeroStake,
    #[msg("pot is not open for calls")]
    PotNotOpen,
    #[msg("pot has not kicked off yet")]
    NotKickedOff,
    #[msg("pot is not locked")]
    PotNotLocked,
    #[msg("pot is not settled")]
    PotNotSettled,
    #[msg("pot is not voided")]
    PotNotVoid,
    #[msg("the on-chain proof does not confirm the claimed winning bucket")]
    ProofRejected,
    #[msg("this position has already been claimed")]
    AlreadyClaimed,
    #[msg("txoracle program account does not match the pinned config address")]
    WrongTxoracleProgram,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("proof fixture does not match this pot's fixture")]
    WrongFixture,
    #[msg("proof timestamp is outside this pot's match window")]
    TimestampOutOfWindow,
    #[msg("scores-roots account is not the txoracle PDA for this timestamp's day")]
    WrongRootsAccount,
    #[msg("only the config admin may perform this action")]
    Unauthorized,
    #[msg("kickoff must be in the future and within the allowed lead time")]
    KickoffInvalid,
    #[msg("void timeout has not elapsed; only the admin may void earlier")]
    VoidTooEarly,
    #[msg("no rake to sweep (already swept, or a voided pot)")]
    NothingToSweep,
    #[msg("rake exceeds the vault balance free after reserving unclaimed winners")]
    RakeExceedsFree,
    #[msg("vault balance is below the outstanding winner liability")]
    VaultUnderwater,
    #[msg("token account mint does not match the configured USDC mint")]
    WrongMint,
    #[msg("cannot sweep rake into the pot's own vault")]
    SweepToVault,
    #[msg("unknown market kind or op for a line market")]
    InvalidMarketKind,
    #[msg("market spec does not belong to this pot")]
    WrongMarketSpec,
    #[msg("a proof stat leaf does not match the market spec's stat key/period")]
    WrongStat,
    #[msg("a market spec must be set before any calls are placed")]
    SpecAfterCalls,
}
