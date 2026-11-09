use anchor_lang::prelude::Pubkey;

pub const DOMAIN: &[u8] = b"agentvault:payment-approval:v2\0";

pub const MESSAGE_LEN: usize = 31 + (9 * 32) + 24 + 32;

/// Exact binary layout signed by the owner's v2 Ed25519 key.
/// Keep field order consistent with demo/payment-approval-v2.ts.
pub struct PaymentApprovalV2 {
    pub genesis_hash: Pubkey,
    pub program_id: Pubkey,
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub agent: Pubkey,
    pub agent_authority: Pubkey,
    pub task: Pubkey,
    pub recipient: Pubkey,
    pub amount_base_units: u64,
    pub nonce: u64,
    pub expires_at_unix: i64,
    pub request_id_hash: [u8; 32],
}

impl PaymentApprovalV2 {
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(MESSAGE_LEN);

        bytes.extend_from_slice(DOMAIN);

        for key in [
            self.genesis_hash,
            self.program_id,
            self.vault,
            self.owner,
            self.mint,
            self.agent,
            self.agent_authority,
            self.task,
            self.recipient,
        ] {
            bytes.extend_from_slice(key.as_ref());
        }

        bytes.extend_from_slice(&self.amount_base_units.to_le_bytes());
        bytes.extend_from_slice(&self.nonce.to_le_bytes());
        bytes.extend_from_slice(&self.expires_at_unix.to_le_bytes());
        bytes.extend_from_slice(&self.request_id_hash);

        debug_assert_eq!(bytes.len(), MESSAGE_LEN);

        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn matches_the_v2_binary_layout() {
        // SHA-256("procurement-001")
        let request_hash = [
            0xd5, 0xab, 0x15, 0xe7, 0xa8, 0xe3, 0x65, 0x7d, 0xf4, 0x05, 0xbf, 0x3c, 0xf9, 0xc1,
            0x0b, 0xa5, 0x55, 0xcb, 0x96, 0xc5, 0xbc, 0x63, 0xbd, 0x8c, 0x0b, 0x91, 0xa1, 0x5b,
            0x2f, 0x10, 0x0c, 0xb1,
        ];

        let approval = PaymentApprovalV2 {
            genesis_hash: key(1),
            program_id: key(2),
            vault: key(3),
            owner: key(4),
            mint: key(5),
            agent: key(6),
            agent_authority: key(7),
            task: key(8),
            recipient: key(9),
            amount_base_units: 10_000,
            nonce: 7,
            expires_at_unix: 2_000_000_000,
            request_id_hash: request_hash,
        };

        let bytes = approval.encode();

        assert_eq!(bytes.len(), MESSAGE_LEN);
        assert_eq!(&bytes[..DOMAIN.len()], DOMAIN);

        let mut cursor = DOMAIN.len();

        for value in 1..=9_u8 {
            assert_eq!(&bytes[cursor..cursor + 32], &[value; 32]);
            cursor += 32;
        }

        assert_eq!(&bytes[cursor..cursor + 8], &10_000_u64.to_le_bytes());
        cursor += 8;

        assert_eq!(&bytes[cursor..cursor + 8], &7_u64.to_le_bytes());
        cursor += 8;

        assert_eq!(&bytes[cursor..cursor + 8], &2_000_000_000_i64.to_le_bytes());
        cursor += 8;

        assert_eq!(&bytes[cursor..], &request_hash);
    }
}
