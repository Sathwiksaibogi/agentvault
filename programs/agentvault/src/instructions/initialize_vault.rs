use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::VAULT_SEED,
    state::Vault,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [
            VAULT_SEED,
            owner.key().as_ref(),
            &vault_id.to_le_bytes()
        ],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub token_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}