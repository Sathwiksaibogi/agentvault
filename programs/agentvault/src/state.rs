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

#[account]
#[derive(InitSpace)]
pub struct Task {
    // Parent Vault and authorized Agent PDA.
    pub vault: Pubkey,
    pub agent: Pubkey,

    // Unique task ID within this Agent.
    pub task_id: u64,

    // Approved recipient wallet.
    pub recipient: Pubkey,

    // Maximum token amount authorized for this task.
    pub budget: u64,

    // Cumulative amount already spent.
    pub spent: u64,

    // Task expiration (Unix timestamp).
    pub expires_at: i64,

    // Expected nonce for the next payment.
    pub next_nonce: u64,

    // Task can be disabled or revoked later.
    pub active: bool,

    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ApprovedTask {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub task_id: u64,

    pub recipient: Pubkey,
    pub budget: u64,
    pub spent: u64,
    pub expires_at: i64,
    pub next_nonce: u64,

    // Owner-configured chain scope for v2 signatures.
    pub genesis_hash: Pubkey,

    pub active: bool,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;

    #[test]
    fn model_a_and_model_b_have_distinct_discriminators() {
        assert_ne!(Task::DISCRIMINATOR, ApprovedTask::DISCRIMINATOR);
    }

    #[test]
    fn model_a_and_model_b_have_distinct_pdas() {
        let agent = Pubkey::new_unique();
        let task_id = 42_u64.to_le_bytes();
        let program_id = crate::id();

        let (model_a, _) = Pubkey::find_program_address(
            &[crate::constants::TASK_SEED, agent.as_ref(), &task_id],
            &program_id,
        );

        let (model_b, _) = Pubkey::find_program_address(
            &[
                crate::constants::APPROVED_TASK_SEED,
                agent.as_ref(),
                &task_id,
            ],
            &program_id,
        );

        assert_ne!(model_a, model_b);
    }
}
