use anchor_lang::prelude::*;

use crate::{
    constants::{AGENT_SEED, VAULT_SEED},
    state::{Agent, Vault},
};

#[derive(Accounts)]
pub struct DeactivateAgent<'info> {
    // Only the vault owner can deactivate agents.
    pub owner: Signer<'info>,

    // Verify ownership and the canonical Vault PDA.
    #[account(
        has_one = owner,
        seeds = [
            VAULT_SEED,
            owner.key().as_ref(),
            &vault.vault_id.to_le_bytes(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // Verify the agent belongs to this exact vault.
    #[account(
        mut,
        has_one = vault,
        seeds = [
            AGENT_SEED,
            vault.key().as_ref(),
            agent.authority.as_ref(),
        ],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handler(ctx: Context<DeactivateAgent>) -> Result<()> {
    // Idempotent deactivation: repeated calls remain safe.
    ctx.accounts.agent.active = false;

    Ok(())
}
