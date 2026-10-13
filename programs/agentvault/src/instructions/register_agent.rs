use anchor_lang::prelude::*;

use crate::{
    constants::{AGENT_SEED, VAULT_SEED},
    error::ErrorCode,
    state::{Agent, Vault},
};

#[derive(Accounts)]
#[instruction(agent_authority: Pubkey)]
pub struct RegisterAgent<'info> {
    // Only the Vault owner can register agents.
    #[account(mut)]
    pub owner: Signer<'info>,

    // Verify the Vault belongs to this owner.
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

    // Create one deterministic account per Vault-agent pair.
    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [
            AGENT_SEED,
            vault.key().as_ref(),
            agent_authority.as_ref(),
        ],
        bump,
    )]
    pub agent: Account<'info, Agent>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterAgent>, agent_authority: Pubkey) -> Result<()> {
    // Prevent registration of an invalid default authority.
    require!(
        agent_authority != Pubkey::default(),
        ErrorCode::InvalidAgentAuthority
    );

    // Do not permit new registrations while the Vault is paused.
    require!(!ctx.accounts.vault.paused, ErrorCode::VaultPaused);

    let agent = &mut ctx.accounts.agent;

    agent.vault = ctx.accounts.vault.key();
    agent.authority = agent_authority;
    agent.active = true;
    agent.bump = ctx.bumps.agent;

    Ok(())
}
