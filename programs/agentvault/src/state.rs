use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]

pub struct Vault {
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub vault_id: u64,
    pub total_reserved: u64,
    pub paused: bool,
    pub bump: u8,
}
