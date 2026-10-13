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

#[account]
#[derive(InitSpace)]
pub struct Agent {
    // The Vault this agent belongs to.
    pub vault: Pubkey,

    // The public key authorized to act as this agent.
    pub authority: Pubkey,

    // Whether this agent is currently enabled.
    pub active: bool,

    // PDA bump used for validation.
    pub bump: u8,
}
