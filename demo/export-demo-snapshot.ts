import { strict as assert } from "node:assert";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_BASE = "http://127.0.0.1:8787";

async function readApi<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

async function main() {
  console.log("=== AGENTVAULT DEMO SNAPSHOT ===");
  console.log("Source: Local read-only Devnet API");

  const treasury = await readApi<{
    network: string;
    balanceBaseUnits: string;
    reservedBaseUnits: string;
    availableBaseUnits: string;
  }>("/api/treasury");

  assert.equal(treasury.network, "devnet");

  const agentResponse = await readApi<{
    network: string;
    agents: unknown[];
  }>("/api/agents");

  assert.equal(agentResponse.network, "devnet");
  assert.ok(agentResponse.agents.length >= 2);

  const workflowIndex = await readApi<{
    network: string;
    requestIds: string[];
  }>("/api/workflows");

  assert.equal(workflowIndex.network, "devnet");

  const workflows: unknown[] = [];

  for (const requestId of workflowIndex.requestIds) {
    const workflow = await readApi<unknown>(
      `/api/workflows/${encodeURIComponent(requestId)}`
    );

    workflows.push(workflow);
  }

  const activityResponse = await readApi<{
    network: string;
    activity: unknown[];
  }>("/api/activity");

  assert.equal(activityResponse.network, "devnet");

  const snapshot = {
    snapshotVersion: 1,
    capturedAt: new Date().toISOString(),
    source: "Solana Devnet via AgentVault read-only API",
    dashboard: {
      treasury,
      agents: agentResponse.agents,
      workflows,
      activity: activityResponse.activity,
    },
  };

  const outputDir = join(process.cwd(), "frontend", "public");

  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, "demo-snapshot.json");

  const temporaryPath = `${outputPath}.tmp`;

  writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", {
    mode: 0o644,
  });

  renameSync(temporaryPath, outputPath);

  console.log("Snapshot saved:", outputPath);
  console.log("Captured:", snapshot.capturedAt);
  console.log("Agents:", snapshot.dashboard.agents.length);
  console.log("Workflows:", snapshot.dashboard.workflows.length);
  console.log("Activity:", snapshot.dashboard.activity.length);
  console.log("No transaction signed or broadcast.");
}

main().catch((error: unknown) => {
  console.error(
    "Snapshot export failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});
