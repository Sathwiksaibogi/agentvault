# AgentVault Token Trust Policy

## Supported token programs

The current AgentVault on-chain program supports the original SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).

Token-2022 extensions are not supported by this implementation.

## Mint identification

Each Vault is permanently associated with a specific token mint at initialization. All treasury deposits, task payments, and owner withdrawals must use that configured mint.

## Token issuer trust

- **Mint authority:** An active mint authority may create additional supply, affecting token economics. It does not grant direct control over AgentVault's treasury.
- **Freeze authority:** An active freeze authority may freeze token accounts and prevent transfers. AgentVault cannot override this restriction.
- **Revoked authorities:** A revoked authority cannot be used to perform new actions of that authority type. Existing token-account state must still be checked.

## Local development policy

The local demo uses an initialized classic SPL mint with six decimals, a mint authority controlled by the demo owner, and no freeze authority.

## Production admission policy

Production integrations must use explicitly reviewed mint addresses. An asset review must identify its token program, mint and freeze authorities, supported behavior, and issuer-level risks.

Issuer-controlled assets may be supported where their trust assumptions are acceptable and disclosed.

Token-2022 support requires a separate implementation and accounting review, including any transfer fees, hooks, delegates, or other relevant extensions.

## Security boundary

AgentVault enforces treasury spending policies. It does not guarantee the issuer's solvency, token market value, supply stability, or protection against legitimate issuer administrative actions.