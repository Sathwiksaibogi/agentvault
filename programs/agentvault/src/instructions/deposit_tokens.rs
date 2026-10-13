use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::VAULT_SEED, error::ErrorCode, state::Vault};

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    // The organization owner authorizes the deposit.
    pub owner: Signer<'info>,

    // Verify this Vault belongs to the signer.
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

    // The configured SPL token mint.
    pub token_mint: Account<'info, Mint>,

    // The owner's source token account.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    // The destination must be the Vault's treasury ATA.
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
    // Reject zero-value deposits.
    require!(amount > 0, ErrorCode::InvalidDepositAmount);

    // Prepare the CPI to the SPL Token Program.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.owner_token_account.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.treasury.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);

    // Transfer the tokens.
    transfer_checked(cpi_ctx, amount, ctx.accounts.token_mint.decimals)?;

    Ok(())
}
