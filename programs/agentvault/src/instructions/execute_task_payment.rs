use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::{AGENT_SEED, TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, Task, Vault},
};

#[derive(Accounts)]
pub struct ExecuteTaskPayment<'info> {
    // The AI agent must sign this instruction.
    pub agent_authority: Signer<'info>,

    // Verify the Vault's canonical PDA.
    #[account(
        mut,
        has_one = token_mint,
        seeds = [
            VAULT_SEED,
            vault.owner.as_ref(),
            &vault.vault_id.to_le_bytes(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // Verify that this Agent belongs to the Vault
    // and is controlled by the transaction signer.
    #[account(
        has_one = vault,
        constraint = agent.authority == agent_authority.key()
            @ ErrorCode::Unauthorized,
        seeds = [
            AGENT_SEED,
            vault.key().as_ref(),
            agent.authority.as_ref(),
        ],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,

    // The Task must belong to this exact Agent and Vault.
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

    pub token_mint: Account<'info, Mint>,

    // The canonical treasury ATA controlled by the Vault PDA.
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    /// CHECK:
    /// Its address must equal the recipient wallet
    /// recorded in the Task's on-chain spending policy.
    #[account(address = task.recipient)]
    pub recipient: UncheckedAccount<'info>,

    // Tokens must go to the approved recipient's
    // canonical associated token account.
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteTaskPayment>, amount: u64, nonce: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let agent = &ctx.accounts.agent;
    let task = &mut ctx.accounts.task;

    // 1. Check global and local status.
    require!(!vault.paused, ErrorCode::VaultPaused);
    require!(agent.active, ErrorCode::AgentInactive);
    require!(task.active, ErrorCode::TaskInactive);

    // 2. Reject invalid payment amounts.
    require!(amount > 0, ErrorCode::InvalidPaymentAmount);

    // 3. Check expiration using Solana's clock.
    let now = Clock::get()?.unix_timestamp;

    require!(now < task.expires_at, ErrorCode::TaskExpired);

    // 4. Enforce the expected payment nonce.
    require!(nonce == task.next_nonce, ErrorCode::InvalidPaymentNonce);

    // 5. Compute cumulative spending safely.
    let new_spent = task
        .spent
        .checked_add(amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    require!(new_spent <= task.budget, ErrorCode::TaskBudgetExceeded);

    // 6. Spending consumes an existing reservation.
    let new_total_reserved = vault
        .total_reserved
        .checked_sub(amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // 7. Compute the next expected nonce.
    let new_nonce = task
        .next_nonce
        .checked_add(1)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // 8. Prepare Vault PDA signer seeds.
    let vault_owner = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump_bytes = [vault.bump];

    let signer_seeds: &[&[u8]] = &[
        VAULT_SEED,
        vault_owner.as_ref(),
        &vault_id_bytes,
        &bump_bytes,
    ];

    let signer = &[signer_seeds];

    // 9. Transfer tokens from the shared treasury.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.treasury.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.recipient_token.to_account_info(),
        authority: vault.to_account_info(),
    };

    transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // 10. Update accounting after a successful CPI.
    task.spent = new_spent;
    task.next_nonce = new_nonce;
    vault.total_reserved = new_total_reserved;

    Ok(())
}
