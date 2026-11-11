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
