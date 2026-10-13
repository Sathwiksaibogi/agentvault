pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");

#[program]
pub mod agentvault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, vault_id: u64) -> Result<()> {
        instructions::initialize_vault::handler(ctx, vault_id)
    }

    pub fn initialize_treasury(ctx: Context<InitializeTreasury>) -> Result<()> {
        instructions::initialize_treasury::handler(ctx)
    }
}
