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
