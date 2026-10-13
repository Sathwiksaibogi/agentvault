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
}
