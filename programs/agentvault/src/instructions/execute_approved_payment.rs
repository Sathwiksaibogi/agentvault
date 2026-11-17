use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::{AGENT_SEED, APPROVED_TASK_SEED, VAULT_SEED},
    error::ErrorCode,
    owner_approval_verifier::require_owner_approval,
    payment_approval_v2::PaymentApprovalV2,
    state::{Agent, ApprovedTask, Vault},
};

#[derive(Accounts)]
pub struct ExecuteApprovedPayment<'info> {
    // The registered agent executes the payment.
    pub agent_authority: Signer<'info>,

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
    pub vault: Box<Account<'info, Vault>>,

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
    pub agent: Box<Account<'info, Agent>>,

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
    pub approved_task: Box<Account<'info, ApprovedTask>>,

    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// CHECK: Must match the recipient stored in ApprovedTask.
    #[account(address = approved_task.recipient)]
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: Address is checked here and content is
    /// checked by load_current_index_checked.
    #[account(
        address = Pubkey::new_from_array(
            solana_instructions_sysvar::ID.to_bytes()
        )
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<ExecuteApprovedPayment>,
    amount: u64,
    nonce: u64,
    approval_expires_at: i64,
    request_id_hash: [u8; 32],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let agent = &ctx.accounts.agent;
    let task = &mut ctx.accounts.approved_task;

    // 1. Enforce all existing security controls.
    require!(!vault.paused, ErrorCode::VaultPaused);
    require!(agent.active, ErrorCode::AgentInactive);
    require!(task.active, ErrorCode::TaskInactive);
    require!(amount > 0, ErrorCode::InvalidPaymentAmount);

    let now = Clock::get()?.unix_timestamp;

    require!(now < task.expires_at, ErrorCode::TaskExpired);

    // Owner approval cannot outlive the task.
    require!(
        approval_expires_at > now && approval_expires_at <= task.expires_at,
        ErrorCode::InvalidOwnerApproval
    );

    // 2. Prevent replay and skipped nonces.
    require!(nonce == task.next_nonce, ErrorCode::InvalidPaymentNonce);

    // 3. Validate spending and reservation accounting.
    let new_spent = task
        .spent
        .checked_add(amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    require!(new_spent <= task.budget, ErrorCode::TaskBudgetExceeded);

    let new_reserved = vault
        .total_reserved
        .checked_sub(amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    let next_nonce = task
        .next_nonce
        .checked_add(1)
        .ok_or(error!(ErrorCode::MathOverflow))?;

    // 4. Reconstruct the exact owner-approved message
    // from authenticated on-chain state and payment args.
    let approval = PaymentApprovalV2 {
        genesis_hash: task.genesis_hash,
        program_id: crate::id(),
        vault: vault.key(),
        owner: vault.owner,
        mint: vault.token_mint,
        agent: agent.key(),
        agent_authority: ctx.accounts.agent_authority.key(),
        task: task.key(),
        recipient: task.recipient,
        amount_base_units: amount,
        nonce,
        expires_at_unix: approval_expires_at,
        request_id_hash,
    };

    let message = approval.encode();

    // 5. Require a preceding native Ed25519 instruction
    // verifying this exact message and the Vault owner.
    require_owner_approval(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &vault.owner,
        &message,
    )?;

    // 6. Prepare the canonical Vault PDA signer.
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

    // 7. Execute the SPL token transfer.
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

    // 8. Commit accounting only after successful CPI.
    task.spent = new_spent;
    task.next_nonce = next_nonce;
    vault.total_reserved = new_reserved;

    Ok(())
}
