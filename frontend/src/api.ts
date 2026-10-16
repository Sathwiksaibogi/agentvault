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

export interface DashboardData {
  treasury: Treasury;
  agents: Agent[];
  activity: ActivityEntry[];
  workflows: WorkflowStatus[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadDashboard(): Promise<DashboardData> {
  // Avoid bursting requests against the Devnet RPC.
  const treasury = await getJson<Treasury>("/api/treasury");

  await delay(400);

  const agentsResponse = await getJson<{
    agents: Agent[];
  }>("/api/agents");

  await delay(400);

  const workflowIndex = await getJson<{
    requestIds: string[];
  }>("/api/workflows");

  const workflows: WorkflowStatus[] = [];

  for (const requestId of workflowIndex.requestIds) {
    await delay(400);

    const workflow = await getJson<WorkflowStatus>(
      `/api/workflows/${encodeURIComponent(requestId)}`
    );

    workflows.push(workflow);
  }

  await delay(400);

  const activityResponse = await getJson<{
    activity: ActivityEntry[];
  }>("/api/activity");

  return {
    treasury,
    agents: agentsResponse.agents,
    workflows,
    activity: activityResponse.activity,
  };
}
