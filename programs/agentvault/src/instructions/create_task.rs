use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{AGENT_SEED, TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, Task, Vault},
};

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateTask<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    // Only the legitimate Vault owner can create tasks.
    #[account(
        mut,
        has_one = owner,
        has_one = token_mint,
        seeds = [
            VAULT_SEED,
            owner.key().as_ref(),
            &vault.vault_id.to_le_bytes(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // Verify that the Agent belongs to this Vault.
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

    pub token_mint: Account<'info, Mint>,

    // Read the real available SPL token balance.
    #[account(
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    // Create a unique task for this Agent.
    #[account(
        init,
        payer = owner,
        space = 8 + Task::INIT_SPACE,
        seeds = [
            TASK_SEED,
            agent.key().as_ref(),
            &task_id.to_le_bytes(),
        ],
        bump,
    )]
    pub task: Account<'info, Task>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateTask>,
    task_id: u64,
    budget: u64,
    recipient: Pubkey,
    expires_at: i64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let agent = &ctx.accounts.agent;

    require!(!vault.paused, ErrorCode::VaultPaused);
    require!(agent.active, ErrorCode::AgentInactive);

    require!(budget > 0, ErrorCode::InvalidTaskBudget);

    require!(recipient != Pubkey::default(), ErrorCode::InvalidRecipient);

    let now = Clock::get()?.unix_timestamp;

    require!(expires_at > now, ErrorCode::InvalidTaskExpiry);

    // Reserve the task budget without transferring tokens.
    let new_reserved = vault
        .total_reserved
        .checked_add(budget)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    require!(
        new_reserved <= ctx.accounts.treasury.amount,
        ErrorCode::InsufficientUnreservedFunds
    );

    // Update the aggregate Vault reservation.
    vault.total_reserved = new_reserved;

    // Initialize task-specific spending policy.
    let task = &mut ctx.accounts.task;

    task.vault = vault.key();
    task.agent = agent.key();
    task.task_id = task_id;
    task.recipient = recipient;
    task.budget = budget;
    task.spent = 0;
    task.expires_at = expires_at;
    task.next_nonce = 0;
    task.active = true;
    task.bump = ctx.bumps.task;

    Ok(())
}
