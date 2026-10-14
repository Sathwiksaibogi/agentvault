use anchor_lang::prelude::*;

use crate::{
    constants::{AGENT_SEED, TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, Task, Vault},
};

#[derive(Accounts)]
pub struct RevokeTask<'info> {
    // Only the owner may revoke a task.
    pub owner: Signer<'info>,

    // Verify the Vault is owned by this signer.
    #[account(
        mut,
        has_one = owner,
        seeds = [
            VAULT_SEED,
            owner.key().as_ref(),
            &vault.vault_id.to_le_bytes(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // Verify the Agent belongs to this Vault.
    #[account(
        has_one = vault,
        seeds = [
            AGENT_SEED,
            vault.key().as_ref(),
            agent.authority.as_ref(),
        ],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,

    // Verify the Task belongs to this Agent and Vault.
    #[account(
        mut,
        has_one = vault,
        has_one = agent,
        seeds = [
            TASK_SEED,
            agent.key().as_ref(),
            &task.task_id.to_le_bytes(),
        ],
        bump = task.bump,
    )]
    pub task: Account<'info, Task>,
}

pub fn handler(ctx: Context<RevokeTask>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let task = &mut ctx.accounts.task;

    // 1. Reject duplicate revocation.
    require!(task.active, ErrorCode::TaskInactive);

    // 2. Calculate the task's unspent reservation.
    let unused_budget = task
        .budget
        .checked_sub(task.spent)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // 3. Safely release the unused reservation.
    let new_total_reserved = vault
        .total_reserved
        .checked_sub(unused_budget)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // 4. Permanently deactivate this task.
    task.active = false;

    // 5. Update the Vault's aggregate reservation.
    vault.total_reserved = new_total_reserved;

    Ok(())
}
