# AgentVault Model B — Devnet End-to-End Verification

Date: 2026-11-10
Network: Solana Devnet
Authorization: Model B / Per-payment owner approval
Test mode: Explicit Devnet sandbox procurement simulation

## Transaction

Request ID: modelb-devnet-008
Task ID: 1003
Amount: 1000 token base units
Transaction signature:
2nYT57bXfuPPjv5mphd8jsygiGS2SjXdkKiQ4Zkz3kQForVdtA3b1U2Htc9LkcMCR7G6yov1YE25vPDFJihY9iV2

## Verified post-payment state

Treasury balance: 309000
Vault reserved: 189000
ApprovedTask spent: 1000
ApprovedTask nextNonce: 1
Mock vendor token balance: 1000
ApprovedTask active: true

## Authorization and execution

- Owner-signed workflow v2 verified.
- Owner-signed PaymentApprovalV2 verified.
- Gemini returned PAY under the explicit Devnet sandbox policy.
- Cached decision verified during execution.
- Exact payment transaction executed on Devnet.
- Original signed transaction durably journaled.
- Read-only recovery returned CONFIRMED.
- Independent on-chain state verification passed.

## Limitations

This demonstrates Devnet sandbox integration, not production
readiness. The system has not undergone an independent security
audit. No genuine procurement transaction occurred.
