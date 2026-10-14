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

    pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
        instructions::deposit_tokens::handler(ctx, amount)
    }

    pub fn register_agent(ctx: Context<RegisterAgent>, agent_authority: Pubkey) -> Result<()> {
        instructions::register_agent::handler(ctx, agent_authority)
    }

    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: u64,
        budget: u64,
        recipient: Pubkey,
        expires_at: i64,
    ) -> Result<()> {
        instructions::create_task::handler(ctx, task_id, budget, recipient, expires_at)
    }

    pub fn execute_task_payment(
        ctx: Context<ExecuteTaskPayment>,
        amount: u64,
        nonce: u64,
    ) -> Result<()> {
        instructions::execute_task_payment::handler(ctx, amount, nonce)
    }
}
