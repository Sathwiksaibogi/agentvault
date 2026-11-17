pub mod constants;
pub mod error;
pub mod instructions;
pub mod owner_approval_verifier;
pub mod payment_approval_v2;
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

    pub fn revoke_task(ctx: Context<RevokeTask>) -> Result<()> {
        instructions::revoke_task::handler(ctx)
    }

    pub fn set_vault_paused(ctx: Context<SetVaultPaused>, paused: bool) -> Result<()> {
        instructions::set_vault_paused::handler(ctx, paused)
    }

    pub fn deactivate_agent(ctx: Context<DeactivateAgent>) -> Result<()> {
        instructions::deactivate_agent::handler(ctx)
    }

    pub fn withdraw_unreserved(ctx: Context<WithdrawUnreserved>, amount: u64) -> Result<()> {
        instructions::withdraw_unreserved::handler(ctx, amount)
    }

    pub fn create_approved_task(
        ctx: Context<CreateApprovedTask>,
        task_id: u64,
        budget: u64,
        recipient: Pubkey,
        expires_at: i64,
        genesis_hash: Pubkey,
    ) -> Result<()> {
        instructions::create_approved_task::handler(
            ctx,
            task_id,
            budget,
            recipient,
            expires_at,
            genesis_hash,
        )
    }

    pub fn revoke_approved_task(ctx: Context<RevokeApprovedTask>) -> Result<()> {
        instructions::revoke_approved_task::handler(ctx)
    }

    pub fn execute_approved_payment(
        ctx: Context<ExecuteApprovedPayment>,
        amount: u64,
        nonce: u64,
        approval_expires_at: i64,
        request_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::execute_approved_payment::handler(
            ctx,
            amount,
            nonce,
            approval_expires_at,
            request_id_hash,
        )
    }
}
