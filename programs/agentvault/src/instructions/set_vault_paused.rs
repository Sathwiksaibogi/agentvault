use anchor_lang::prelude::*;

use crate::{constants::VAULT_SEED, state::Vault};

#[derive(Accounts)]
pub struct SetVaultPaused<'info> {
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
}

pub fn handler(ctx: Context<SetVaultPaused>, paused: bool) -> Result<()> {
    ctx.accounts.vault.paused = paused;

    Ok(())
}
