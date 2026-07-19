// Anchor's #[program] macro needs each instruction module's generated
// __client_accounts_* / __cpi_client_accounts_* companions in scope, so we
// glob-export. Each module also names its entrypoint `handler`; those names
// collide harmlessly under the glob (we only ever call them by full path from
// lib.rs), so silence that specific lint rather than rename seven handlers.
#![allow(ambiguous_glob_reexports)]

pub mod claim;
pub mod create_market_spec;
pub mod create_pot;
pub mod init_config;
pub mod lock_pot;
pub mod place_call;
pub mod settle_market;
pub mod settle_pot;
pub mod sweep_rake;
pub mod verify_match_stat;
pub mod void_pot;

pub use claim::*;
pub use create_market_spec::*;
pub use create_pot::*;
pub use init_config::*;
pub use lock_pot::*;
pub use place_call::*;
pub use settle_market::*;
pub use settle_pot::*;
pub use sweep_rake::*;
pub use verify_match_stat::*;
pub use void_pot::*;
