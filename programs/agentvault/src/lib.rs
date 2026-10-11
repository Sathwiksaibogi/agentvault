pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");

#[program]
pub mod agentvault {
    use super::*;
}
