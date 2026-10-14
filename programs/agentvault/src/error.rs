use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized AgentVault operation")]
    Unauthorized,

    #[msg("Vault is paused")]
    VaultPaused,

    #[msg("Insufficient unreserved treasury balance")]
    InsufficientUnreservedFunds,

    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,

    #[msg("Invalid agent authority public key")]
    InvalidAgentAuthority,

    #[msg("Task budget must be greater than zero")]
    InvalidTaskBudget,

    #[msg("Task expiration must be in the future")]
    InvalidTaskExpiry,

    #[msg("Invalid task recipient")]
    InvalidRecipient,

    #[msg("Agent is inactive")]
    AgentInactive,

    #[msg("Arithmetic overflow")]
    MathOverflow,
}
