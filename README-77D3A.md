# 7.7D.3A: Read-only authenticated Model A agent polling (local Devnet)

This milestone exposes `POST /api/model-a/agent-inbox/challenge` with `{ "vault": "...", "agentAuthority": "..." }` and `POST /api/model-a/agent-inbox/poll` with `{ "nonce": "...", "signature": "<base58 Ed25519 detached signature>" }`.

Each agent request requires a new, one-time, 60-second challenge signed by the registered **agent authority**. The server validates Devnet genesis and live agent/vault membership and scans the bounded local payment-intent inbox. It returns only the signed agent's currently unexpired requests in the signed vault. Expired tasks and revoked tasks may have received records, but **discovery is not an execution check**; execution is still disabled and future execution must revalidate every task and payment guard.

Do not sign inbox challenges with a Phantom owner account unless it is explicitly the registered *agent authority*. Agent workers must safeguard their signing key. Do not expose this endpoint through public internet or browser applications. The scan is bounded to 5,000 local records and 25 unexpired matches; a bigger queue fails closed. This is not production queue infrastructure; PostgreSQL indexing, rate limits, receipt acknowledgements and durable delivery state must precede deployment.

## Install & tests

```bash
cd ~/projects/agentvault
python3 install_77d3a.py
pnpm exec prettier --write demo/model-a-agent-inbox.ts demo/model-a-agent-inbox.test.ts demo/api-server.ts
pnpm exec tsx --test demo/model-a-agent-inbox.test.ts
pnpm exec tsc --noEmit
pnpm --filter frontend build
git diff --check
```

The existing Model B finality quarantine and the Model A transaction-execution infrastructure are not modified.

## One-shot agent worker acceptance (read only)

The existing `research-agent` developer credential **cannot** authenticate an agent. The agent needs access to its own private authority key. From a separate terminal after starting the backend:

```bash
cd ~/projects/agentvault
export AGENTVAULT_POLL_VAULT=C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep
export AGENTVAULT_AGENT_KEYPAIR_PATH="$HOME/.config/agentvault/test-agents/YOUR_ACTIVE_AGENT.json"
pnpm exec tsx demo/agent-inbox-poll-once.ts
unset AGENTVAULT_AGENT_KEYPAIR_PATH AGENTVAULT_POLL_VAULT
```

Replace the example filename with the **real file belonging to your active agent**. Never send that file or its contents over chat, place it in source control, or use the previously deactivated agent's key. Create a fresh, unexpired payment intent before polling; an older two-minute acceptance intent will be filtered out.
