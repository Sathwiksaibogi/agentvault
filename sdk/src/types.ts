/** Mirrors the existing `/api/treasury` frontend contract; base-unit amounts stay strings. */
export interface Treasury {
  network: string;
  vault: string;
  owner: string;
  tokenMint: string;
  treasury: string;
  vaultId: string;
  decimals: number;
  paused: boolean;
  balanceBaseUnits: string;
  reservedBaseUnits: string;
  availableBaseUnits: string;
}

/** Mirrors the existing `/api/agents` frontend contract. */
export interface Agent {
  id: string;
  name: string;
  workflow: string;
  authority: string;
  agentPda: string;
  active: boolean;
  task: {
    taskId: number;
    taskPda: string;
    active: boolean;
    recipient: string;
    budgetBaseUnits: string;
    spentBaseUnits: string;
    remainingBaseUnits: string;
    nextNonce: string;
    expiresAtUnix: string;
  };
}

/** The existing `/api/workflows/:requestId` read-only response. */
export interface WorkflowStatus {
  requestId: string;
  assignedAgent: string;
  workflowKind: string;
  taskId: number;
  amountBaseUnits: number;
  network: string;
  recipient: string;
  approval: {
    signatureVerified: boolean;
    currentlyValid: boolean;
    expiresAtUnix: number;
  };
  aiDecision: {
    receiptFilePresent: boolean;
    verification: string;
  };
  execution: {
    journalStatus: string;
    payment: {
      signature: string;
      recoveryState: string;
      amountBaseUnits: number;
      nonce: string;
    } | null;
  };
}

/** The existing `/api/activity` on-chain activity entry. */
export interface ActivityEntry {
  signature: string;
  slot: number;
  blockTimeUnix: number | null;
  agentId: string;
  workflow: string;
  taskId: number;
  taskPda: string;
  succeeded: boolean;
  explorerUrl: string;
}

/** POST body for the Devnet Model A payment-intent endpoint.
 * The verified developer credential determines the vault; NEVER send a vault override.
 * Canonical u64 amounts/IDs and expiry are decimal strings, not JS numbers.
 */
export interface ModelAPaymentIntentInput {
  requestId: string;
  agentAuthority: string;
  taskId: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAtUnix: string;
  reason?: string;
}

/** HTTP 202 for new receipts, HTTP 200 for exact idempotent duplicates.
 * "received" means stored only, NOT approved, dispatched or paid.
 */
export interface ModelAPaymentIntentAccepted {
  requestId: string;
  status: "received";
  duplicate: boolean;
  network: "devnet";
  vault: string;
  notice: "Request only; not approved, queued for execution, or paid";
}

export interface StoredModelAPaymentExecution {
  claimed: boolean;
  prepared: boolean;
  status:
    | "unclaimed"
    | "claimed"
    | "prepared"
    | "confirmed"
    | "failed_on_chain"
    | "rejected"
    | "expired_unresolved";
  signature?: string;
  nonce?: string;
  rejectionReason?: string;
  failureReason?: string;
}

/** GET /api/model-a/payment-intents/:requestId. */
export interface StoredModelAPaymentIntent {
  version: 1;
  kind: "model-a-payment-intent";
  status: "received";
  network: "devnet";
  vault: string;
  principalId: string;
  createdAtUnix: number;
  request: ModelAPaymentIntentInput;
  delivery?: {
    acknowledged: boolean;
    acknowledgedAtUnix?: number;
  };
  execution?: StoredModelAPaymentExecution;
}

export interface AgentInboxChallenge {
  nonce: string;
  message: string;
  expiresAtUnix: number;
}

export interface AgentInboxPollResult {
  network: "devnet";
  vault: string;
  agentAuthority: string;
  items: StoredModelAPaymentIntent[];
  notice: string;
}

export interface AgentInboxAckResult {
  network: "devnet";
  vault: string;
  agentAuthority: string;
  requestId: string;
  acknowledgedAtUnix: number;
  duplicate: boolean;
  notice: string;
}

export interface AgentVaultClientOptions {
  /** API origin, e.g. http://127.0.0.1:3000 or https://api.example.com. */
  baseUrl: string;
  /** Server-side Bearer token; never embed it in a frontend bundle. */
  token: string;
  /** Abort a request after this interval. Default 10000 milliseconds. */
  timeoutMs?: number;
  /** For unit tests and dependency injection; default is global fetch. */
  fetchImpl?: typeof fetch;
}
