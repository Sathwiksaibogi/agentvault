# AgentVault 7.7D.2A — Devnet Model A payment-intent policy preflight

This is a read-only, **non-executing** prerequisite to the Developer Payment Request API. It consumes a trusted API-key-derived vault and principal, validates the structured request from 7.7D.1, pins Devnet genesis, verifies the canonical vault and SPL treasury, and verifies the selected active agent and active task against decoded Anchor accounts. It rejects wrong recipient, inactive policy, pause, expired task, insufficient task budget, or forged PDA/bump relationships. Numeric values stay exact.

**Do not expose the intake function to HTTP yet.** Existing developer keys grant `activity:read`, not payment-request permission. A future explicit `payments:request` capability and vault-specific issuance/authorization must be added before any endpoint accepts untrusted requests.

This module does not schedule, notify, sign, or execute payments. Policy preflight is a snapshot, not an authorization artifact: the actual executor must reverify policy, signature authority, replay nonce, finality restrictions, and durable journal before broadcasting. Model B restrictions are unchanged.

## Apply and verify

```bash
cd ~/projects/agentvault
unzip -n /mnt/c/Users/sathw/Downloads/agentvault-77d2a-policy-preflight.zip
pnpm exec tsx --test demo/model-a-payment-policy.test.ts
pnpm exec tsc --noEmit
pnpm exec prettier --check demo/model-a-payment-policy.ts demo/model-a-payment-policy.test.ts
git diff --check
```

Commit only the new files after passing checks. Do not add ZIPs or unrelated untracked files.
