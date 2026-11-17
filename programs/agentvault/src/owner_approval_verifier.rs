use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;

use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use solana_sdk_ids::ed25519_program;

use crate::{error::ErrorCode, payment_approval_v2::MESSAGE_LEN};

const PUBLIC_KEY_OFFSET: usize = 16;
const SIGNATURE_OFFSET: usize = 48;
const MESSAGE_OFFSET: usize = 112;

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

/// Validates the exact single-signature instruction layout.
///
/// This function DOES NOT perform cryptographic verification.
/// The native Ed25519 program performs that verification when
/// the preceding instruction executes successfully.
pub fn is_canonical_owner_approval(
    instruction: &Instruction,
    expected_owner: &Pubkey,
    expected_message: &[u8],
) -> bool {
    if instruction.program_id.to_bytes() != ed25519_program::id().to_bytes()
        || !instruction.accounts.is_empty()
        || expected_message.len() != MESSAGE_LEN
    {
        return false;
    }

    let data = &instruction.data;

    if data.len() != MESSAGE_OFFSET + MESSAGE_LEN {
        return false;
    }

    // One signature, standard zero padding.
    if data[0] != 1 || data[1] != 0 {
        return false;
    }

    // Require signature, public key and message bytes
    // to be embedded in this exact Ed25519 instruction.
    if read_u16(data, 2) != SIGNATURE_OFFSET as u16
        || read_u16(data, 4) != u16::MAX
        || read_u16(data, 6) != PUBLIC_KEY_OFFSET as u16
        || read_u16(data, 8) != u16::MAX
        || read_u16(data, 10) != MESSAGE_OFFSET as u16
        || read_u16(data, 12) != MESSAGE_LEN as u16
        || read_u16(data, 14) != u16::MAX
    {
        return false;
    }

    if &data[PUBLIC_KEY_OFFSET..SIGNATURE_OFFSET] != expected_owner.as_ref() {
        return false;
    }

    &data[MESSAGE_OFFSET..] == expected_message
}

/// Requires a successfully executed native Ed25519
/// instruction immediately before the current instruction.
///
/// The caller MUST construct expected_message from actual
/// validated on-chain accounts and payment arguments.
pub fn require_owner_approval(
    instructions_sysvar: &AccountInfo<'_>,
    expected_owner: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;

    require!(current_index > 0, ErrorCode::MissingOwnerApproval);

    let previous =
        load_instruction_at_checked(usize::from(current_index - 1), instructions_sysvar)?;

    require!(
        is_canonical_owner_approval(&previous, expected_owner, expected_message,),
        ErrorCode::InvalidOwnerApproval
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_instruction(owner: Pubkey, message: &[u8]) -> Instruction {
        let mut data = vec![0u8; MESSAGE_OFFSET + message.len()];

        data[0] = 1;

        for (offset, value) in [
            (2, SIGNATURE_OFFSET as u16),
            (4, u16::MAX),
            (6, PUBLIC_KEY_OFFSET as u16),
            (8, u16::MAX),
            (10, MESSAGE_OFFSET as u16),
            (12, message.len() as u16),
            (14, u16::MAX),
        ] {
            data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }

        data[PUBLIC_KEY_OFFSET..SIGNATURE_OFFSET].copy_from_slice(owner.as_ref());

        // Placeholder bytes for structural tests only.
        // A real transaction must pass native signature
        // verification before the guarded payment runs.
        data[SIGNATURE_OFFSET..MESSAGE_OFFSET].fill(42);

        data[MESSAGE_OFFSET..].copy_from_slice(message);

        Instruction {
            program_id: Pubkey::new_from_array(ed25519_program::id().to_bytes()),
            accounts: vec![],
            data,
        }
    }

    #[test]
    fn accepts_the_canonical_instruction_layout() {
        let owner = Pubkey::new_unique();
        let message = vec![7u8; MESSAGE_LEN];
        let ix = make_instruction(owner, &message);

        assert!(is_canonical_owner_approval(&ix, &owner, &message));
    }

    #[test]
    fn rejects_incorrect_owner_and_message() {
        let owner = Pubkey::new_unique();
        let message = vec![7u8; MESSAGE_LEN];
        let ix = make_instruction(owner, &message);

        assert!(!is_canonical_owner_approval(
            &ix,
            &Pubkey::new_unique(),
            &message
        ));

        assert!(!is_canonical_owner_approval(
            &ix,
            &owner,
            &vec![8u8; MESSAGE_LEN]
        ));
    }

    #[test]
    fn rejects_cross_instruction_data_references() {
        let owner = Pubkey::new_unique();
        let message = vec![7u8; MESSAGE_LEN];

        for offset in [4, 8, 14] {
            let mut ix = make_instruction(owner, &message);

            ix.data[offset..offset + 2].copy_from_slice(&0u16.to_le_bytes());

            assert!(!is_canonical_owner_approval(&ix, &owner, &message));
        }
    }

    #[test]
    fn rejects_wrong_program_and_multiple_signatures() {
        let owner = Pubkey::new_unique();
        let message = vec![7u8; MESSAGE_LEN];

        let mut ix = make_instruction(owner, &message);
        ix.program_id = Pubkey::new_unique();

        assert!(!is_canonical_owner_approval(&ix, &owner, &message));

        let mut ix = make_instruction(owner, &message);
        ix.data[0] = 2;

        assert!(!is_canonical_owner_approval(&ix, &owner, &message));
    }

    #[test]
    fn rejects_modified_offsets_and_trailing_data() {
        let owner = Pubkey::new_unique();
        let message = vec![7u8; MESSAGE_LEN];

        let mut ix = make_instruction(owner, &message);
        ix.data[2] = 0;

        assert!(!is_canonical_owner_approval(&ix, &owner, &message));

        let mut ix = make_instruction(owner, &message);
        ix.data.push(0);

        assert!(!is_canonical_owner_approval(&ix, &owner, &message));

        let mut ix = make_instruction(owner, &message);
        ix.data.truncate(100);

        assert!(!is_canonical_owner_approval(&ix, &owner, &message));
    }
}
