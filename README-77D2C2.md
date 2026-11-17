# AgentVault 7.7D.2C.2 — Developer Credentials UI

Local Devnet only. This patch adds a scoped credentials panel to the authenticated selected-vault dashboard. It uses the existing credential APIs added in 7.7D.2C.1; it does **not** enable payment execution.

- Issues `payments:request` or `activity:read` single-vault developer credentials, with a 1–24-hour expiry.
- Uses a **fresh, action-specific Phantom signMessage** challenge for each issue/revoke operation. Checks the returned message against owner, vault, origin, action, application, permission, nonce, and expiry **before** signing.
- Lists **metadata only**, for an explicit application principal ID.
- Shows a new token once, exclusively in React component memory, with a copy/hide button. It is never written to localStorage, sessionStorage or URLs.
- Requires explicit acknowledgment and confirmation for irreversible revocation.

## Install

Unzip at repo root (do not overwrite existing tracked files), then:

```bash
python3 install_77d2c2.py
pnpm exec prettier --write \
  frontend/src/developer-credentials.ts \
  frontend/src/DeveloperCredentialsPanel.tsx \
  frontend/test/developer-credentials.test.mjs \
  frontend/src/SelectedVaultDashboard.tsx
pnpm exec tsx --test frontend/test/developer-credentials.test.mjs
pnpm exec tsc --noEmit
pnpm --filter frontend build
pnpm exec tsx --test demo/owner-vault-developer-keys.test.ts
pnpm exec eslint frontend/src/developer-credentials.ts frontend/src/DeveloperCredentialsPanel.tsx frontend/src/SelectedVaultDashboard.tsx
git diff --check
```

Run each gate and **do not commit** if any fails. Existing older untracked archives/installers must not be staged.

## Focused commit

```bash
git add \
  frontend/src/developer-credentials.ts \
  frontend/src/DeveloperCredentialsPanel.tsx \
  frontend/test/developer-credentials.test.mjs \
  frontend/src/SelectedVaultDashboard.tsx \
  README-77D2C2.md
git diff --cached --check
GIT_PAGER=cat git diff --cached --stat
git commit -m "feat(dashboard): add Phantom-authorized developer credentials panel"
```

## Live acceptance

Before running backend and frontend, ensure local Devnet PostgreSQL API credential repository is configured and selected-vault sessions work. Open Vault #8001 dashboard, list `research-agent` credentials, issue a 1-hour `payments:request` key with a fresh wallet message, **save it only to a secure backend secret manager**, verify it appears as active metadata, then revoke it using a second fresh Phantom signature, and verify it appears as revoked. No agent payment or broadcast is part of this milestone. **Never put secret tokens in a screenshot or chat.**

IMPORTANT: Existing backend uses an in-memory nonce map. Restarting the API between challenge and confirmation invalidates that challenge; request a fresh one instead of attempting to reuse it. A successful key persists via the configured PostgreSQL repository.
