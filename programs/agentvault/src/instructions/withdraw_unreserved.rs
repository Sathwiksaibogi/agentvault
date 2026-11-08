use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::VAULT_SEED, error::ErrorCode, state::Vault};

#[derive(Accounts)]
pub struct WithdrawUnreserved<'info> {
    // Only the vault owner may withdraw.
    pub owner: Signer<'info>,

    #[account(
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

    pub token_mint: Account<'info, Mint>,

    // The canonical treasury controlled by the vault PDA.
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    // Withdrawals may only go to an account owned
    // by the vault owner and holding the configured mint.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawUnreserved>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidWithdrawalAmount);

    let vault = &ctx.accounts.vault;

    // Keep every active task's reservation collateralized.
    let available = ctx
        .accounts
        .treasury
        .amount
        .checked_sub(vault.total_reserved)
        .ok_or(error!(ErrorCode::TreasuryBelowReserved))?;

    require!(amount <= available, ErrorCode::InsufficientUnreservedFunds);

    // Sign the SPL Token transfer with the canonical vault PDA.
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump_bytes = [vault.bump];

    let signer_seeds: &[&[u8]] = &[
        VAULT_SEED,
        vault.owner.as_ref(),
        &vault_id_bytes,
        &bump_bytes,
    ];

    let signer = &[signer_seeds];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.treasury.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.owner_token_account.to_account_info(),
        authority: vault.to_account_info(),
    };

    transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // No reservation field changes.
    // The withdrawal consumes only unreserved treasury tokens.
    Ok(())
}
