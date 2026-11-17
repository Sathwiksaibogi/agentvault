# AgentVault

### Secure Spending Infrastructure for Autonomous AI Agents on Solana

**AgentVault** is a multi-agent financial security infrastructure prototype built on Solana. It enables independent software and AI agents to execute bounded payments from a shared, owner-controlled treasury while enforcing task-specific spending limits, approved recipient allowlists, on-chain expiration rules, and replay protection.

Instead of giving an agent direct custody of a private key or unrestricted wallet access, AgentVault separates **AI advisory evaluation, developer intent intake, cryptographic agent authorization, unattended worker execution, and Solana on-chain enforcement**.

Built as part of **Solana Fall School 2026**.

**Project Status:** Verified Devnet Prototype | **Tests:** 887 passing unit/regression tests, 65 integration tests | **Network:** Solana Devnet

---

## The Problem

Autonomous software and AI agents are increasingly tasked with managing operational workflows, purchasing APIs, paying service providers, and settling transactions.

However, granting an autonomous agent direct control over a standard Solana private key introduces catastrophic security risks:

- **Unbounded Spending:** A bug or prompt injection can drain an entire wallet.
- **Recipient Redirection:** A compromised agent can divert funds to an unauthorized address.
- **Inter-Agent Contention:** Multiple agents sharing a single wallet can collide, race on nonces, or exhaust each other's operating capital.
- **Unchecked AI Decisions:** Stochastic LLM outputs can hallucinate payment amounts or violate business policies.
- **Replay & Concurrency Attacks:** Network timeouts or retry loops can execute duplicate payments.

Traditional crypto wallets provide all-or-nothing signing authority. **AgentVault addresses this problem by moving financial policy enforcement to the Solana smart contract level.**

---

## Architectural Trust Boundaries

AgentVault enforces strict separation of concerns across five distinct trust boundaries:

```text
 1. ADVISORY LAYER (Google Gemini AI)
    - Analyzes incoming business context or invoices.
    - Emits structured advisory proposals (PAY / REJECT).
    - ZERO cryptographic authority: cannot sign transactions, cannot broadcast payments.
                             │
                             ▼
 2. INTENT INTAKE LAYER (Developer API & SDK)
    - Authenticates developers via dynamic scoped API keys (avk_<id>_<secret>).
    - Validates target vault, agent, task, recipient, and amount parameters.
    - Persists payment intents into durable storage and the agent's inbox.
                             │
                             ▼
 3. AGENT AUTHORIZATION LAYER (Cryptographic Identity)
    - Agents authenticate via challenge-response inbox polling (/api/model-a/agent-inbox).
    - Agent evaluates the intent and signs an explicit Ed25519 decision over the canonical v2 tuple:
      domain: "agentvault:agent-payment-decision:v2"
      (requestId, vault, agentAuthority, taskPda, recipient, amount, expiresAtUnix).
                             │
                             ▼
 4. UNATTENDED WORKER LAYER (Model A Worker)
    - Discovers acknowledged intents with cryptographically verified agent signatures.
    - Enforces capability isolation: simulated vs preview vs live broadcast.
    - Validates network genesis hash, on-chain clock, task budget, recipient, and nonce.
    - Writes durable journal records (.json -> .signed.json -> .confirmed.json).
                             │
                             ▼
 5. ON-CHAIN ENFORCEMENT LAYER (Solana Anchor Program)
    - Program ID: BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d
    - Enforces agent authority, active status, unexpired clock, exact recipient, and budget.
    - Increments task nonce and updates on-chain spent accounting atomically.
    - Executes SPL Token transfer via Vault PDA CPI without exposing owner custody.
```

---

## Execution Models: Model A vs Model B

AgentVault distinguishes between two operational models:

### Model A: Autonomous Agent-Authorized Execution (Fully Verified)

In Model A, an autonomous agent operates as an independent signing authority within bounded, pre-allocated on-chain task policies.

1. **Submission:** A developer submits a payment intent via `AgentVaultClient.submitModelAPaymentIntent()`.
2. **Delivery & Acknowledgment:** The agent polls its authenticated inbox, verifies intent terms, and records an acknowledgment receipt.
3. **Cryptographic Decision:** The agent signs an Ed25519 authorization decision bound to the exact request parameters.
4. **Autonomous Processing:** The `ModelAWorker` verifies the agent's signature, validates on-chain task readiness, simulates the transaction, broadcasts to Solana Devnet, and writes confirmed journal records.
5. **Status:** **Fully verified on Solana Devnet with live transaction confirmation and end-to-end integration tests.**

### Model B: Owner-Approved Workflow Dual Attestation (Experimental Preview)

In Model B, payments require two-party authorization: an off-chain owner approval and a corresponding agent attestation.

1. **Owner Workflow Signing:** The treasury owner signs a deterministic workflow specification approving a specific business task.
2. **AI Evaluation:** Google Gemini evaluates the approved workflow against operational rules and generates a structured proposal.
3. **Deterministic Policy Gate:** The executor verifies that the AI proposal strictly adheres to the owner's signed terms.
4. **Agent Dual-Signing:** The assigned agent signs the payment instruction before submission.
5. **Status:** **Historical preview demonstrated; architectural integration remains experimental and incomplete.**

---

## Live Solana Devnet Verified Payment

AgentVault demonstrated a live, unattended, autonomous Model A payment on Solana Devnet on **November 17, 2026**.

### Devnet Transaction Summary

| Parameter | On-Chain Value |
|---|---|
| **Transaction Signature** | [`YP5iFYqvKMoDzKi5thLbc31UVXL4CjEgpCdijonqQFxVF2cdR7qLyy7fWBs5tkRtf3wB24bZbX4uZYXtMH2RdH8`](https://explorer.solana.com/tx/YP5iFYqvKMoDzKi5thLbc31UVXL4CjEgpCdijonqQFxVF2cdR7qLyy7fWBs5tkRtf3wB24bZbX4uZYXtMH2RdH8?cluster=devnet) |
| **Solana Explorer** | [View Confirmed Transaction on Solana Explorer](https://explorer.solana.com/tx/YP5iFYqvKMoDzKi5thLbc31UVXL4CjEgpCdijonqQFxVF2cdR7qLyy7fWBs5tkRtf3wB24bZbX4uZYXtMH2RdH8?cluster=devnet) |
| **Network** | Solana Devnet (Genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) |
| **Program ID** | `BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d` |
| **Instruction** | `ExecuteTaskPayment` |
| **Status** | **Finalized** (Slot `523312475`, Confirmation slot `523316687`, `err: null`) |
| **Request ID** | `req_devnet_acc_20261117150942_2133f601` |
| **Vault PDA** | `G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U` |
| **Agent Authority** | `AeP6wgJ1BktbP7q4MyEuKbuXXbQJgoLgMtgbGDi7hp8L` |
| **Task PDA** | `83hhHmdgQG1vjYiUNtKCgyuQbC3ffWgEggp94iuvbKf1` (Task #3) |
| **Recipient** | `DmSyacb7BBjtUYFB76uk4K3YyQbHVwb38tn4uj7JuEVT` |
| **Transferred Amount** | **1,000 base units** (0.001000 SPL test tokens) |

### Independent On-Chain State Verification

- **Treasury Token Account (`9jf3fXNboToPTNqMpA5wxHiBTF442kRLF7dFYiasQucr`):** Balance decremented from `950,000` to `949,000` base units (-1,000).
- **Recipient Token Account (`DmSyacb7BBjtUYFB76uk4K3YyQbHVwb38tn4uj7JuEVT`):** Balance incremented from `50,000` to `51,000` base units (+1,000).
- **Task #3 State Account:**
  - `spent_amount`: Incremented from `0` to `1,000` base units.
  - `remaining_budget`: Decremented from `10,000` to `9,000` base units.
  - `nonce`: Incremented from `0` to `1`.
- **Durable Journal Files (Recorded on Disk):**
  - `demo/devnet/journal/req_devnet_acc_20261117150942_2133f601.json` (Initial claim)
  - `demo/devnet/journal/req_devnet_acc_20261117150942_2133f601.signed.json` (Prepared transaction bytes)
  - `demo/devnet/journal/req_devnet_acc_20261117150942_2133f601.confirmed.json` (Finalized transaction signature and slot)

### Historical Devnet Transactions (Model B Preview)

- **Procurement Agent (`procurement-005`):** [`ze591ZJ9t3teigshk29U1QDWQL1ig66r7WVR8mDLdj2oP2XbofSyYtmbgn812gf4cJdNECMhJsAUujvTrcydjDb`](https://explorer.solana.com/tx/ze591ZJ9t3teigshk29U1QDWQL1ig66r7WVR8mDLdj2oP2XbofSyYtmbgn812gf4cJdNECMhJsAUujvTrcydjDb?cluster=devnet)
- **Operations Agent (`operations-001`):** [`2jpT3iZrJ6jrtMEEGsvAEi13ueZKCSsHsHofvbfgbAqYSiFVMXnHisJMYAUchJAvCn5Pdu4jnZRjHZeUrXkzWsv4`](https://explorer.solana.com/tx/2jpT3iZrJ6jrtMEEGsvAEi13ueZKCSsHsHofvbfgbAqYSiFVMXnHisJMYAUchJAvCn5Pdu4jnZRjHZeUrXkzWsv4?cluster=devnet)

---

## Smart Contract Architecture

The on-chain program is implemented in Rust using the Anchor framework.

### Main On-Chain Accounts

| Account | Seeds | Purpose |
|---|---|---|
| `Vault` | `["vault", owner, vault_id]` | Holds vault configuration, owner authority, token mint, reserved accounting, and pause flag. |
| `Agent` | `["agent", vault, agent_authority]` | Authorizes an agent public key to operate on tasks within a specific vault. |
| `Task` | `["task", agent, task_id]` | Defines task spending constraints: budget, spent, recipient allowlist, expiration, and next nonce. |
| `Treasury` | Associated Token Account of Vault PDA | Holds the SPL tokens managed by the vault. |

### Core Instructions

| Instruction | Signer | Enforced Checks |
|---|---|---|
| `initialize_vault` | Owner | Sets owner, mint, and vault ID. |
| `initialize_treasury` | Owner | Creates the SPL token treasury account under Vault PDA authority. |
| `deposit_tokens` | Anyone | Transfers SPL tokens into the vault treasury. |
| `register_agent` | Owner | Registers an independent agent authority for the vault. |
| `create_task` | Owner | Creates a task PDA with budget, recipient allowlist, and expiry. |
| `execute_task_payment` | Agent Authority | Validates active vault, active agent, active task, unexpired clock, matching recipient, budget headroom, and matching nonce. Executes transfer CPI via Vault PDA seeds. |
| `revoke_task` | Owner | Deactivates task spending permissions immediately. |

---

## Developer API & SDK Usage

### Developer SDK (`AgentVaultClient`)

Applications integrate with AgentVault using the TypeScript SDK:

```typescript
import { AgentVaultClient } from "./demo/sdk/agentvault-client";

const client = new AgentVaultClient({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTVAULT_DEVELOPER_API_KEY, // avk_<keyId>_<secret>
});

// Submit a Model A payment intent
const intent = await client.submitModelAPaymentIntent({
  network: "devnet",
  vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
  agentAuthority: "AeP6wgJ1BktbP7q4MyEuKbuXXbQJgoLgMtgbGDi7hp8L",
  taskId: "3",
  recipient: "DmSyacb7BBjtUYFB76uk4K3YyQbHVwb38tn4uj7JuEVT",
  amountBaseUnits: "1000",
  expiresAtUnix: Math.floor(Date.now() / 1000) + 7200,
  reason: "Automated API subscription payment",
});

console.log(`Submitted Request ID: ${intent.requestId}`);
```

### Developer API Endpoints

| Endpoint | Method | Required Scope | Purpose |
|---|---|---|---|
| `/health` | `GET` | None | Service health and network check. |
| `/api/model-a/payment-intents` | `POST` | `payments:request` | Submit an autonomous payment intent. |
| `/api/model-a/payment-intents/:id` | `GET` | `payments:request` | Query intent status and journal confirmation. |
| `/api/model-a/agent-inbox/poll` | `POST` | Agent Auth | Challenge-response inbox polling for agents. |
| `/api/model-a/agent-inbox/ack` | `POST` | Agent Auth | Record agent delivery acknowledgment. |
| `/api/treasury` | `GET` | Owner Session | Treasury balances and reserved accounting. |
| `/api/agents` | `GET` | `agents:read` | List registered agents and active tasks. |
| `/api/activity` | `GET` | `activity:read` | Payment history and on-chain events. |

### API Key Issuance

Dynamic developer keys are issued using `issueDeveloperApiKey()`. Keys are formatted as `avk_<keyId>_<secret>` and hashed with timing-safe SHA-256 before storage in PostgreSQL:

```bash
AGENTVAULT_NETWORK=devnet \
pnpm exec tsx demo/issue-devnet-developer-key.ts
```

---

## Live Monitoring Dashboard

The frontend application (`frontend/`) provides a real-time operational interface:

- **Owner Session Gate:** Authenticates the vault owner via Ed25519 wallet signature challenge-response (`PaymentApprovalV2`), establishing a secure HttpOnly session.
- **Treasury Inspection:** Displays total balance, reserved task commitments, and available unreserved funds.
- **Scoped Agent & Task Reader:** Strictly filters agent and task data to the authenticated vault, preventing cross-tenant data leakage.
- **Activity & Workflow Feeds:** Visualizes historical payments, pending approvals, and execution confirmations.

```bash
# Start frontend dev server
pnpm --dir frontend run dev
```

---

## Verification & Test Suite

AgentVault includes an extensive, multi-layered test suite enforcing protocol security, capability isolation, and replay resistance.

### Test Results Summary

- **Total Test Suite:** **887 passed**, 0 failed, 17 skipped (database-specific tests requiring local PostgreSQL).
- **Integration Test Suite:** **65 passed**, 0 failed (`demo/acceptance-preparation.test.ts`, `demo/model-a-worker-runner.test.ts`, `demo/model-a-worker.test.ts`, `demo/devnet-acceptance-preflight.test.ts`, `demo/model-a-e2e-integration.test.ts`, `demo/product-integration-verification.test.ts`).
- **Frontend Quality:** ESLint passes with 0 warnings/errors; Vite production build passes cleanly.

### Running Test Commands

```bash
# Run unit and regression tests
pnpm test:api:unit

# Run full integration verification
pnpm exec tsx --test \
  demo/acceptance-preparation.test.ts \
  demo/model-a-worker-runner.test.ts \
  demo/model-a-worker.test.ts \
  demo/devnet-acceptance-preflight.test.ts \
  demo/model-a-e2e-integration.test.ts \
  demo/product-integration-verification.test.ts

# Frontend validation
pnpm --dir frontend run lint
pnpm --dir frontend run build
```

---

## Technical Honesty & Known Limitations

1. **Autonomous Worker Execution:** The Devnet payment demonstrated on November 17, 2026 was executed by the unattended `ModelAWorker` upon discovering a cryptographically signed agent decision on disk. It demonstrates deterministic cryptographic authorization and smart-contract policy enforcement, **not** unconstrained artificial intelligence making discretionary financial choices.
2. **Model B Integration Status:** Model B (dual-key owner-approved workflows) was demonstrated as an early proof-of-concept and remains an incomplete, experimental preview. Model A is the primary, fully verified implementation.
3. **Database Dependency:** Dynamic developer API key issuance and token revocation require a running PostgreSQL instance. When PostgreSQL is absent, the backend falls back to local file-based runtime storage.
4. **Devnet Prototype:** AgentVault is an educational prototype developed for Solana Fall School 2026. It has not been deployed to Solana Mainnet.

---

## Security & Production-Readiness Disclaimer

> [!CAUTION]
> **AgentVault is an experimental educational prototype.**
>
> The smart contracts and off-chain execution infrastructure have **not** undergone a formal, independent third-party security audit.
>
> This software is provided "as is", without warranty of any kind. It is **not** intended or ready for production use, mainnet deployment, or the custody of real financial assets. All demonstrations use custom SPL test tokens on Solana Devnet.

---

## Author

**Sathwik Sai Bogi**
Solana Fall School 2026
[GitHub Profile](https://github.com/Sathwiksaibogi) | [AgentVault Repository](https://github.com/Sathwiksaibogi/agentvault)
