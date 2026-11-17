/**
 * Browser encoder for the existing Model A v1 owner-approved workflow.
 * The array order and JSON serialization MUST match demo/signed-workflow.ts.
 * No private key is stored or transmitted by this module.
 */
export const AGENTVAULT_PROGRAM_ID =
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";
export const MAX_SELECTED_PAYMENT_BASE_UNITS = 50_000;

export type SelectedVaultApproval = {
  version: 1;
  network: "devnet";
  requestId: string;
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  assignedAgent: "agent-a" | "agent-b";
  agentAuthority: string;
  kind: "procurement" | "operations";
  taskId: number;
  recipient: string;
  amountBaseUnits: number;
  expiresAtUnix: number;
  description: string;
};

export function encodeSelectedVaultApproval(
  w: SelectedVaultApproval
): Uint8Array {
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
