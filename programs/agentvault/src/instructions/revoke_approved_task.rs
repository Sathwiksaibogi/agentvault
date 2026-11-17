use anchor_lang::prelude::*;

use crate::{
    constants::{AGENT_SEED, APPROVED_TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, ApprovedTask, Vault},
};

#[derive(Accounts)]
pub struct RevokeApprovedTask<'info> {
    pub owner: Signer<'info>,

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

    #[account(
        mut,
        has_one = vault,
        has_one = agent,
        seeds = [
            APPROVED_TASK_SEED,
            agent.key().as_ref(),
            &approved_task.task_id.to_le_bytes(),
        ],
        bump = approved_task.bump,
    )]
    pub approved_task: Account<'info, ApprovedTask>,
}

pub fn handler(ctx: Context<RevokeApprovedTask>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let task = &mut ctx.accounts.approved_task;

    require!(task.active, ErrorCode::TaskInactive);

    let unused_budget = task
        .budget
        .checked_sub(task.spent)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    let new_reserved = vault
        .total_reserved
        .checked_sub(unused_budget)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // Revoke permanently and release only unspent funds.
    task.active = false;
    vault.total_reserved = new_reserved;

    Ok(())
}
