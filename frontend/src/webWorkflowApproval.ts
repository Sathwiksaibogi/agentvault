/** Browser-only Phantom owner authorization: no private keys or payments. */
import { Buffer } from "buffer";
import type { DashboardData } from "./api";
import type { PhantomProvider } from "./phantom";

export type WebAgentId = "agent-a" | "agent-b";

export interface WorkflowApproval {
  version: 1;
  network: "devnet";
  requestId: string;
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  assignedAgent: WebAgentId;
  agentAuthority: string;
  kind: "procurement" | "operations";
  taskId: number;
  recipient: string;
  amountBaseUnits: number;
  expiresAtUnix: number;
  description: string;
}

interface WorkflowContext {
  network: "devnet";
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  maxPaymentAmountBaseUnits: number;
  nowUnix: number;
}

export interface StoredWebApproval {
  status: "verified_saved_not_executed";
  requestId: string;
  vault: string;
  assignedAgent: WebAgentId;
  amountBaseUnits: number;
  expiresAtUnix: number;
}

/** Must remain BYTE-FOR-BYTE identical to demo/signed-workflow.ts. */
export function encodeWebWorkflow(workflow: WorkflowApproval): Uint8Array {
  const w = workflow;
  const fields = [
    "agentvault:owner-approved-workflow:v1",
    w.version,
    w.network,
    w.requestId,
    w.genesisHash,
    w.programId,
    w.vault,
    w.owner,
    w.mint,
    w.assignedAgent,
    w.agentAuthority,
    w.kind,
    w.taskId,
    w.recipient,
    w.amountBaseUnits,
    w.expiresAtUnix,
    w.description,
  ];
  return new TextEncoder().encode(JSON.stringify(fields));
}

/** Avoid floating-point errors when converting token amounts to base units. */
export function toBaseUnits(text: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error("Invalid token decimals");
  }
  const value = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Enter a positive decimal token amount");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Maximum ${decimals} decimal places`);
  }
  const units =
    BigInt(whole) * BigInt(10 ** decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= BigInt(0) || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount must be a positive safe integer in base units");
  }
  return Number(units);
}

async function checkedJson<T>(response: Response): Promise<T> {
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(json?.error ?? `HTTP ${response.status}`);
  }
  return json;
}

export async function signAndSaveWebWorkflow(params: {
  provider: PhantomProvider;
  dashboard: DashboardData;
  agentId: WebAgentId;
  amountTokens: string;
  description: string;
}): Promise<StoredWebApproval> {
  const { provider, dashboard, agentId, amountTokens } = params;
  const description = params.description.trim();
  const owner = provider.publicKey?.toBase58();

  if (!owner || owner !== dashboard.treasury.owner) {
    throw new Error("Connect the Phantom wallet that owns the selected vault");
  }
  if (typeof provider.signMessage !== "function") {
    throw new Error("Phantom message signing is not available");
  }
  if (dashboard.treasury.paused || dashboard.treasury.network !== "devnet") {
    throw new Error("The selected vault is unavailable for approvals");
  }
  if (description.length < 8 || description.length > 300) {
    throw new Error("Instruction must contain 8–300 characters");
  }

  const agent = dashboard.agents.find((item) => item.id === agentId);
  if (!agent || !agent.active || !agent.task.active) {
    throw new Error("Agent or task is not active");
  }
  const amountBaseUnits = toBaseUnits(
    amountTokens,
    dashboard.treasury.decimals
  );
  if (BigInt(amountBaseUnits) > BigInt(agent.task.remainingBaseUnits)) {
    throw new Error("Amount exceeds remaining task budget");
  }

  // Read the verified chain scope and clock from our LOCAL trusted API.
  const context = await checkedJson<WorkflowContext>(
    await fetch("/api/web/workflow-context", { cache: "no-store" })
  );
  if (
    context.network !== "devnet" ||
    context.vault !== dashboard.treasury.vault ||
    context.owner !== owner ||
    context.mint !== dashboard.treasury.tokenMint
  ) {
    throw new Error("Backend chain context does not match selected vault");
  }
  if (amountBaseUnits > context.maxPaymentAmountBaseUnits) {
    throw new Error("Amount exceeds the AgentVault workflow payment cap");
  }

  const expiresAtUnix = Math.min(
    context.nowUnix + 15 * 60,
    Number(agent.task.expiresAtUnix)
  );
  if (expiresAtUnix <= context.nowUnix + 60) {
    throw new Error("Task expires too soon for a new approval");
  }

  const workflow: WorkflowApproval = {
    version: 1,
    network: "devnet",
    requestId: `web-${crypto.randomUUID()}`,
    genesisHash: context.genesisHash,
    programId: context.programId,
    vault: context.vault,
    owner,
    mint: context.mint,
    assignedAgent: agentId,
    agentAuthority: agent.authority,
    kind: agentId === "agent-a" ? "procurement" : "operations",
    taskId: agent.task.taskId,
    recipient: agent.task.recipient,
    amountBaseUnits,
    expiresAtUnix,
    description,
  };

  // Wallet owns the private signing operation: NEVER use agent private keys.
  const signed = await provider.signMessage(
    encodeWebWorkflow(workflow),
    "utf8"
  );
  if (
    signed.publicKey.toBase58() !== owner ||
    signed.signature.length !== 64 ||
    provider.publicKey?.toBase58() !== owner
  ) {
    throw new Error("Unexpected Phantom owner or signature response");
  }

  const signature = Buffer.from(signed.signature).toString("base64");
  return checkedJson<StoredWebApproval>(
    await fetch("/api/web/approve-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ workflow, signature }),
    })
  );
}
