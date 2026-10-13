use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::VAULT_SEED, state::Vault};

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(mut)]
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

    #[account(
        init,
        payer = owner,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<InitializeTreasury>) -> Result<()> {
    Ok(())
}
