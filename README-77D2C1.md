# AgentVault 7.7D.2C.1 — Selected-vault developer credential provisioning

Local Devnet milestone only. Do not expose this backend to the public Internet.

## Security boundary

The existing wallet-authenticated selected-vault session remains **read-only**. It cannot create or revoke a developer credential by itself. Creating and revoking credentials requires a fresh Phantom `signMessage` signature over the exact action, signed-in wallet, verified vault, Devnet genesis, local origin, session binding, nonce, and expiry. A key grant is **not** a payment approval.

Routes added under `/owner-vault/api/developer-keys`:

- `POST /challenge` (owner session + Origin `http://127.0.0.1:5173`): `{"action":"issue","principalId":"research-agent","scope":"payments:request","expiresAt":<milliseconds>}` or `{"action":"revoke","keyId":"<24-hex>"}`. Returns `{nonce,message,expiresAt}` for Phantom signing.
- `POST /confirm` (same session and Origin): `{"nonce":"...","signature":"<64-byte detached signature as canonical base64>"}`. Only after successful verification may it issue or revoke. Issuance returns the secret **once** after DB persistence.
- `GET /owner-vault/api/developer-keys?principalId=research-agent`: authenticated owner reads *metadata only* from their verified vault.

Issuance is limited to one of `payments:request` or `activity:read`, one vault per key, an exact application principal ID, and an expiry between >1 minute and <=24 hours. Challenge TTL: 90 seconds. Every confirmed action consumes its nonce even on invalid signature. `revokeForVault` in the PostgreSQL repository enforces vault membership atomically. No request accepts arbitrary client-supplied vault or owner identifiers.

Existing global owner management routes remain unchanged; no new capability is granted to existing read-only developer keys. Request-intent API, Model A transaction executor, Model B finality quarantine, and payment broadcaster are untouched.

## Install and checks

Run installer once, after unpacking the archive in `~/projects/agentvault`:

```bash
python3 install_77d2c1.py
pnpm exec prettier --write \
  demo/owner-vault-developer-keys.ts \
  demo/owner-vault-developer-keys.test.ts \
  demo/selected-vault-dashboard-session.ts \
  demo/api-server.ts
pnpm exec tsx --test \
  demo/owner-vault-developer-keys.test.ts \
  demo/selected-vault-dashboard-session.test.ts \
  demo/api-key-issuance.test.ts \
  demo/api-key-management.test.ts \
  demo/model-a-payment-http.test.ts
pnpm exec tsc --noEmit
pnpm --filter frontend build
git diff --check
```

If any check fails, stop and share the output. No commit until all pass. The installer is intentionally checked against exact entry points; if another change touched those lines, it aborts without writing any tracked files.

## Follow-up

7.7D.2C.2 adds the owner dashboard UI for displaying the action-specific Phantom message, signing it, showing a newly issued token **once**, listing metadata, and revoking keys. Only then run real Devnet acceptance. Do **not** copy API-key secrets into chat, browser localStorage, Git or screenshots.
