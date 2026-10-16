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
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadLiveDashboard(): Promise<DashboardData> {
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

export type DashboardView = DashboardData &
  (
    | {
        dataSource: "live";
        snapshotCapturedAt: null;
      }
    | {
        dataSource: "snapshot";
        snapshotCapturedAt: string;
      }
  );

interface DemoSnapshot {
  snapshotVersion: number;
  capturedAt: string;
  dashboard: DashboardData;
}

function isDemoSnapshot(value: unknown): value is DemoSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Partial<DemoSnapshot>;
  const dashboard = snapshot.dashboard;

  return (
    snapshot.snapshotVersion === 1 &&
    typeof snapshot.capturedAt === "string" &&
    Number.isFinite(Date.parse(snapshot.capturedAt)) &&
    dashboard !== null &&
    typeof dashboard === "object" &&
    dashboard.treasury?.network === "devnet" &&
    typeof dashboard.treasury.balanceBaseUnits === "string" &&
    typeof dashboard.treasury.reservedBaseUnits === "string" &&
    typeof dashboard.treasury.availableBaseUnits === "string" &&
    Array.isArray(dashboard.agents) &&
    Array.isArray(dashboard.workflows) &&
    Array.isArray(dashboard.activity)
  );
}

export async function loadDashboard(): Promise<DashboardView> {
  try {
    // Prefer fresh data from the real Devnet backend.
    const live = await loadLiveDashboard();

    return {
      ...live,
      dataSource: "live",
      snapshotCapturedAt: null,
    };
  } catch (liveError) {
    console.warn(
      "Live AgentVault API unavailable. Trying public demo snapshot.",
      liveError
    );

    // Never silently pass stale data off as live.
    const snapshot = await getJson<unknown>("/demo-snapshot.json");

    if (!isDemoSnapshot(snapshot)) {
      throw new Error("Live API unavailable and demo snapshot is invalid", {
        cause: liveError,
      });
    }

    return {
      ...snapshot.dashboard,
      dataSource: "snapshot",
      snapshotCapturedAt: snapshot.capturedAt,
    };
  }
}
