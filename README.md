# AgentVault

### Secure Spending Infrastructure for Autonomous AI Agents on Solana

**AgentVault** is a multi-agent financial security infrastructure project built on Solana. It enables multiple independent AI agents to operate using a shared, owner-controlled treasury while enforcing task-specific spending limits, approved recipients, expiration rules, and replay protection.

Instead of giving AI agents unrestricted access to a wallet, AgentVault separates **AI decision-making, owner authorization, agent execution, and on-chain financial enforcement**.

Built as part of **Solana Fall School 2026**.

**Project status:** Working Devnet prototype | **Tests:** 63 passing | **Network:** Solana Devnet

---

## The Problem

AI agents are increasingly capable of making decisions and executing financial workflows autonomously.

However, giving an AI agent direct access to a treasury wallet introduces serious security risks:

- An agent could spend more funds than intended.
- A compromised agent could transfer funds to an unauthorized recipient.
- Multiple agents sharing one wallet could interfere with each other's budgets.
- AI-generated decisions could violate business rules.
- Repeated or replayed payment requests could cause unintended transfers.

Traditional wallets are not designed for granular, task-level financial authorization for autonomous agents.

**AgentVault addresses this problem by making financial permissions enforceable at the smart-contract level.**

---

## Our Solution

AgentVault provides a shared treasury with independently controlled AI agents.

The treasury owner can register agents and assign tasks with specific policies. Each agent operates under its own authority and cannot exceed the restrictions enforced by the Solana program.

The AI evaluates business requests, while deterministic security checks and the on-chain program control whether a payment can proceed.

### Key Features

**1. Shared Owner-Controlled Treasury**

A single Solana vault holds SPL tokens that can be allocated across multiple AI-agent tasks.

**2. Independent AI Agent Identities**

Each registered agent has a separate signing authority and can operate only within its registered tasks.

**3. Task-Specific Spending Policies**

Every task defines an approved recipient, maximum budget, expiration time, and payment nonce.

**4. Owner-Signed Workflow Authorizations**

The owner cryptographically signs a specific workflow containing the assigned agent, destination, amount, expiry, and business description.

**5. AI-Powered Workflow Evaluation**

Google Gemini evaluates approved workflow requests and produces structured `PAY` or `REJECT` proposals.

**6. Deterministic Security Validation**

The execution layer independently checks the AI proposal against the signed authorization and application policies. AI output alone cannot trigger a payment.

**7. On-Chain Spending Enforcement**

The Solana program validates agent identity, task status, recipient, available budget, expiration, and nonce before transferring tokens.

**8. Replay Protection and Payment Recovery**

Persistent request journals, nonce validation, signed-transaction preservation, and recovery checks reduce the risk of accidental duplicate execution.

**9. Live Monitoring Dashboard**

A React dashboard displays treasury balances, active agents, task budgets, workflow approvals, and Solana Devnet activity.

---

## System Architecture

```text
                    TREASURY OWNER
                           |
                           v
                 Owner-Signed Workflow
                           |
                           v
             +---------------------------+
             | Protected Workflow Engine |
             |                           |
             | - Verify owner signature  |
             | - Verify workflow scope   |
             | - Read on-chain policies  |
             +-------------+-------------+
                           |
                           v
                 GEMINI AI EVALUATION
                           |
                    PAY or REJECT
                           |
                           v
             +---------------------------+
             | Deterministic Policy Gate |
             |                           |
             | - Agent assignment        |
             | - Exact approved amount   |
             | - Task authorization      |
             | - Spending limits         |
             +-------------+-------------+
                           |
                   Approved payment
                           |
                           v
             +---------------------------+
             | Independent Agent Signer  |
             | Transaction Simulation    |
             | Persistent Request Journal|
             +-------------+-------------+
                           |
                           v
                  SOLANA PROGRAM
                           |
             +-------------+-------------+
             | On-Chain Task Enforcement |
             |                           |
             | - Agent authority         |
             | - Recipient allowlist     |
             | - Spending budget         |
             | - Task expiration         |
             | - Nonce / replay checks   |
             +-------------+-------------+
                           |
                           v
                    SPL TOKEN PAYMENT
                           |
                           v
                  MONITORING DASHBOARD
```

**Important security boundary:** Owner signatures and Gemini decisions are verified by the trusted off-chain execution layer. The Solana program independently enforces the registered on-chain task policies; it does not directly verify Gemini decisions or off-chain workflow signatures.

---

## Multi-Agent Treasury Model

The current Devnet demonstration includes two independent agents.

| Agent | Responsibility | Task Budget |
|---|---|---|
| Procurement Agent | Equipment and procurement payments | 0.15 test tokens |
| Operations Agent | Operational expenses and services | 0.10 test tokens |

Each agent has:

- A unique public-key authority
- A registered on-chain Agent PDA
- A task-specific PDA
- An approved recipient
- An independently tracked spending budget
- Task expiration and nonce state

Agents share the same treasury, but their task budgets and authorizations are enforced separately.

### Example Devnet State

The following values are from the tested deployment and may change as additional transactions occur.

| Metric | Value |
|---|---:|
| Treasury balance | 0.31 |
| Reserved funds | 0.16 |
| Unreserved funds | 0.15 |
| Registered agents | 2 |
| Procurement spent | 0.05 |
| Operations spent | 0.04 |

All amounts refer to **custom SPL test tokens with six decimals**, not SOL, USDC, or real-money stablecoins.

---

## How a Payment Works

### Step 1 — Owner Authorization

The treasury owner creates a workflow authorization specifying the agent, recipient, payment amount, business purpose, expiration, and unique request ID.

The owner signs a deterministic, domain-separated message using Ed25519.

### Step 2 — Workflow Verification

The protected executor verifies the owner's signature and checks the authorization against the expected Solana network, program, vault, and mint.

It also validates the registered agent, active task, approved recipient, remaining budget, and expiration.

### Step 3 — AI Evaluation

The approved request is evaluated by Google Gemini.

Gemini returns a structured proposal containing:

```json
{
  "decision": "PAY",
  "amountBaseUnits": 10000,
  "reason": "The request matches the procurement workflow."
}
```

This is an illustrative response format, not a guarantee that Gemini will approve a particular request.

### Step 4 — Deterministic Validation

The execution layer checks that the AI proposal does not change the approved amount or violate the agent's business responsibility.

A rejected or invalid proposal cannot proceed through the protected workflow executor.

### Step 5 — Transaction Construction and Simulation

The executor constructs the payment transaction using the exact on-chain task recipient and current nonce.

The transaction is validated and simulated before execution.

### Step 6 — Agent-Signed Execution

After explicit operator confirmation, only the assigned agent's signing key is loaded.

A persistent request journal records the claim, and the exact signed transaction is saved before broadcast.

### Step 7 — Solana Enforcement

The Anchor program validates the agent's registered authority and task restrictions before performing the SPL Token transfer.

A successful payment updates task spending, reserved accounting, and nonce state.

---

## Smart Contract Design

AgentVault is implemented using **Rust and the Anchor framework**.

### Main On-Chain Accounts

| Account | Purpose |
|---|---|
| Vault | Stores owner, token mint, vault ID, reserved accounting, and pause state |
| Agent | Represents a registered agent authority within a vault |
| Task | Stores spending rules, recipient, budget, spending, expiry, and nonce |
| Treasury Token Account | Holds SPL tokens controlled by the Vault PDA |

### PDA Derivation

```text
Vault PDA
["vault", owner_pubkey, vault_id_le_u64]

Agent PDA
["agent", vault_pubkey, agent_authority_pubkey]

Task PDA
["task", agent_pubkey, task_id_le_u64]
```

### Core Program Instructions

| Instruction | Purpose |
|---|---|
| `initialize_vault` | Create a new owner-controlled vault |
| `initialize_treasury` | Initialize its SPL token treasury |
| `deposit_tokens` | Deposit tokens into the vault |
| `register_agent` | Register an independent agent authority |
| `create_task` | Create a bounded spending task |
| `execute_task_payment` | Execute a payment subject to on-chain rules |
| `revoke_task` | Revoke task spending authority |

The program uses Program Derived Addresses and Cross-Program Invocations to manage token transfers without exposing the treasury owner's private key to individual agents.

---

## Security Architecture

AgentVault uses multiple layers of validation.

| Security mechanism | Protection |
|---|---|
| Owner Ed25519 signature | Authenticates an exact workflow in the protected executor |
| Domain-separated message | Binds an approval to a specific protocol context |
| Agent authority validation | Restricts on-chain execution to registered agents |
| Recipient validation | Prevents transfers outside the task's registered destination |
| Task budgets | Limit how much an agent can spend |
| Expiration enforcement | Prevents execution of expired tasks |
| Nonce validation | Protects against replay of on-chain payment instructions |
| Deterministic AI validation | Prevents AI proposals from changing authorized amounts |
| Transaction instruction guards | Detect unexpected transaction instructions or account modifications |
| Durable request journal | Records execution claims to prevent unsafe automatic retries |
| Signed transaction recovery | Preserves transaction bytes for inspection after uncertain RPC outcomes |

### Security Boundary

AgentVault follows a separation-of-responsibilities model:

**AI layer:** Evaluates whether a business request should be accepted.

**Protected executor:** Verifies owner signatures, validates AI proposals, coordinates signing, and manages transaction recovery.

**Solana program:** Independently enforces registered task-level spending permissions.

A compromised agent signing key could still authorize payments within that agent's on-chain task permissions, even without a valid off-chain owner workflow approval. The additional owner-approval policy therefore depends on protecting and correctly operating the trusted executor and its signing keys.

This project is a prototype, has not been presented as independently audited, and should not be used to safeguard real funds.

---

## Live Solana Devnet Deployment

| Component | Address |
|---|---|
| Program ID | `BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d` |
| Vault PDA | `9uwN9YvPXKTdnRjKth6uAxK9AcWWLA5ckXMGdb5KbuXB` |
| Treasury Owner | `J2GL63eJnVsmJipKkFiaLvwrdSiGnfj5ESpa1HcJXS2G` |
| Test Token Mint | `Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38` |
| Network | Solana Devnet |

[View AgentVault Program on Solana Explorer](https://explorer.solana.com/address/BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d?cluster=devnet)

### Confirmed AI-Authorized Payments

AgentVault has demonstrated owner-approved, Gemini-evaluated payment execution for two independent agents.

**Procurement Agent**

Workflow: `procurement-005`

[View Procurement Payment Transaction](https://explorer.solana.com/tx/ze591ZJ9t3teigshk29U1QDWQL1ig66r7WVR8mDLdj2oP2XbofSyYtmbgn812gf4cJdNECMhJsAUujvTrcydjDb?cluster=devnet)

**Operations Agent**

Workflow: `operations-001`

[View Operations Payment Transaction](https://explorer.solana.com/tx/2jpT3iZrJ6jrtMEEGsvAEi13ueZKCSsHsHofvbfgbAqYSiFVMXnHisJMYAUchJAvCn5Pdu4jnZRjHZeUrXkzWsv4?cluster=devnet)

These are historical confirmed Devnet transactions. Other on-chain activity includes agent setup and task initialization transactions.

---

## Technology Stack

| Layer | Technologies |
|---|---|
| Smart contracts | Rust, Anchor Framework |
| Blockchain | Solana |
| Token standard | SPL Token |
| Agent identity | Solana Keypairs and PDAs |
| AI evaluation | Google Gemini API |
| Backend and CLI | Node.js, TypeScript |
| Validation | Zod, deterministic policy checks |
| Frontend | React, TypeScript, Vite |
| Cryptography | Ed25519, SHA-256, HMAC |
| Testing | TypeScript regression tests, Solana transaction simulation |

---

## Repository Structure

```text
agentvault/
|
|-- programs/
|   `-- agentvault/
|       `-- src/
|           |-- lib.rs
|           |-- state.rs
|           |-- error.rs
|           `-- instructions/
|
|-- demo/
|   |-- owner-approve.ts
|   |-- signed-workflow.ts
|   |-- ai-workflow.ts
|   |-- execute-ai-workflow.ts
|   |-- workflow-policy.ts
|   |-- request-journal.ts
|   |-- prepared-payment.ts
|   |-- payment-recovery.ts
|   |-- api-server.ts
|   `-- *.test.ts
|
|-- frontend/
|   `-- src/
|
|-- Anchor.toml
|-- Cargo.toml
|-- package.json
`-- README.md
```

The `demo/` directory contains the owner authorization, AI evaluation, policy validation, execution, recovery, and API modules.

The `frontend/` directory contains the React monitoring dashboard.

---

## Local Development

### Prerequisites

- Node.js and pnpm
- Rust toolchain
- Solana CLI
- Anchor CLI
- Access to a Solana RPC endpoint
- Gemini API key for AI workflow evaluation

### 1. Clone the Stable Demo Branch

```bash
git clone --branch demo/fall-school-stable \
  https://github.com/Sathwiksaibogi/agentvault.git

cd agentvault
```

### 2. Install Dependencies

```bash
pnpm install
```

For development involving the Solana program, ensure the Anchor program has been built and its generated IDL is available.

```bash
anchor build
```

### 3. Run the Read-Only Devnet API

```bash
AGENTVAULT_NETWORK=devnet \
pnpm exec tsx demo/api-server.ts
```

API endpoints:

```text
GET http://127.0.0.1:8787/health
GET http://127.0.0.1:8787/api/treasury
GET http://127.0.0.1:8787/api/agents
GET http://127.0.0.1:8787/api/workflows
GET http://127.0.0.1:8787/api/activity
```

The backend exposes monitoring data only. It does not expose public Gemini or transaction-signing endpoints.

### 4. Run the Dashboard

In a separate terminal:

```bash
pnpm --dir frontend run dev
```

Open:

```text
http://127.0.0.1:5173
```

The dashboard displays live Devnet treasury state, registered agents, task policies, historical approvals, and recent on-chain activity when the local backend is available.

It is currently a read-only monitoring interface.

### 5. Validate the Project

Run TypeScript compilation:

```bash
pnpm exec tsc --noEmit
```

Run frontend linting and production build:

```bash
pnpm --dir frontend run lint
pnpm --dir frontend run build
```

Run the security and regression test suite:

```bash
pnpm exec tsx --test demo/*.test.ts
```

**Latest verified result: 63 tests passed, 0 failed.**

### AI Workflow Execution

AI workflow evaluation and payment execution are separate protected CLI operations, not public browser actions.

They require valid local runtime configuration, owner-approved workflows, agent signing keys, and Gemini credentials.

The relevant code is located in:

- `demo/owner-approve.ts`
- `demo/ai-workflow.ts`
- `demo/execute-ai-workflow.ts`

The execution coordinator supports preview-only operation before any transaction signing or broadcast.

Private signing keys, Gemini API credentials, HMAC secrets, and local execution journals must not be committed to the repository.

Cloning this repository does not provide access to the private signing identities used by the deployed demo.

---

## Demonstrated Results

The current prototype demonstrates:

- A deployed Anchor program on Solana Devnet
- A functioning shared treasury with custom SPL test tokens
- Two independently registered agent authorities
- Task-specific budgets and recipient restrictions
- Cryptographically signed owner workflow approvals
- Gemini-based workflow evaluation
- Deterministic validation of AI payment proposals
- Confirmed agent-signed SPL token payments
- Transaction simulation and durable execution records
- Replay protection and payment recovery safeguards
- A live monitoring dashboard
- 63 passing TypeScript security and regression tests

---

## Future Development

Planned improvements include:

- Further consolidation of agent execution infrastructure
- A unified browser-based owner authorization experience
- Better deployment and persistent storage infrastructure
- Expanded agent and task management interfaces
- Additional adversarial testing and security review
- Improved multi-agent workflow orchestration
- Support for production-grade monitoring and operational controls

These are future development goals, not claims about the current stable prototype.

---

## Project Motivation

AI agents can make financial decisions, but financial autonomy must be constrained by permissions that do not depend solely on AI behavior.

AgentVault explores how Solana smart contracts, cryptographic authorization, and deterministic validation can work together to provide controlled financial execution for independent AI agents.

The objective is to enable useful autonomous financial workflows while ensuring that spending permissions remain explicit, limited, and enforceable.

**AgentVault — Give AI agents permission to act, not unrestricted permission to spend.**

---

## Author

**Sathwik Sai Bogi**

Solana Fall School 2026

Focused on Solana, Rust, smart-contract security, and decentralized financial infrastructure.

[GitHub Profile](https://github.com/Sathwiksaibogi) | [AgentVault Repository](https://github.com/Sathwiksaibogi/agentvault)

---

## Disclaimer

AgentVault is an educational and experimental Devnet prototype. The project has not undergone a formal independent security audit and is not intended for production custody of real assets.

All financial demonstrations use custom Devnet test tokens.
