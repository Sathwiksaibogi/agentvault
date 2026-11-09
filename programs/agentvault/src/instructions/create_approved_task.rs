use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{AGENT_SEED, APPROVED_TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, ApprovedTask, Vault},
};

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateApprovedTask<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

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

    #[account(
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + ApprovedTask::INIT_SPACE,
        seeds = [
            APPROVED_TASK_SEED,
            agent.key().as_ref(),
            &task_id.to_le_bytes(),
        ],
        bump,
    )]
    pub approved_task: Account<'info, ApprovedTask>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateApprovedTask>,
    task_id: u64,
    budget: u64,
    recipient: Pubkey,
    expires_at: i64,
    genesis_hash: Pubkey,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let agent = &ctx.accounts.agent;

    require!(!vault.paused, ErrorCode::VaultPaused);
    require!(agent.active, ErrorCode::AgentInactive);
    require!(budget > 0, ErrorCode::InvalidTaskBudget);

    require!(recipient != Pubkey::default(), ErrorCode::InvalidRecipient);

    require!(
        genesis_hash != Pubkey::default(),
        ErrorCode::InvalidApprovalScope
    );

    let now = Clock::get()?.unix_timestamp;

    require!(expires_at > now, ErrorCode::InvalidTaskExpiry);

    let new_reserved = vault
        .total_reserved
        .checked_add(budget)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    require!(
        new_reserved <= ctx.accounts.treasury.amount,
        ErrorCode::InsufficientUnreservedFunds
    );

    let task = &mut ctx.accounts.approved_task;

    task.vault = vault.key();
    task.agent = agent.key();
    task.task_id = task_id;
    task.recipient = recipient;
    task.budget = budget;
    task.spent = 0;
    task.expires_at = expires_at;
    task.next_nonce = 0;
    task.genesis_hash = genesis_hash;
    task.active = true;
    task.bump = ctx.bumps.approved_task;

    vault.total_reserved = new_reserved;

    Ok(())
}
