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

async function getJson<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
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

/** Vault selection is explicit so the CLI snapshot is never reused for Vault 2. */
export type VaultSelection = "cli" | "web";

export async function loadDashboard(
  selectedVault: VaultSelection = "cli"
): Promise<DashboardView> {
  if (selectedVault === "web") {
    // This endpoint returns ONLY web-vault on-chain accounts. Until we build
    // an authenticated approval service it deliberately has no workflows.
    // If unavailable, report the error, not Vault 1's historical snapshot.
    const web = await getJson<DashboardData>("/api/web/dashboard", 25_000);
    if (web.treasury.vault !== "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep") {
      throw new Error("Web dashboard returned an unexpected vault");
    }
    return { ...web, dataSource: "live", snapshotCapturedAt: null };
  }

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

    if (
      !isDemoSnapshot(snapshot) ||
      snapshot.dashboard.treasury.vault !==
        "9uwN9YvPXKTdnRjKth6uAxK9AcWWLA5ckXMGdb5KbuXB"
    ) {
      const fallbackError = new Error(
        "Live API unavailable or CLI demo snapshot is invalid"
      ) as Error & { cause: unknown };

      fallbackError.cause = liveError;

      throw fallbackError;
    }

    return {
      ...snapshot.dashboard,
      dataSource: "snapshot",
      snapshotCapturedAt: snapshot.capturedAt,
    };
  }
}
