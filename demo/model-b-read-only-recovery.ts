import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import bs58 from "bs58";
import type { Connection } from "@solana/web3.js";

import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import { recoveryModeFromClaim } from "./payment-recovery-mode";
import { classifyPayment } from "./payment-recovery-state";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { ApprovalScope } from "./signed-workflow";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";

export type ModelBRecoveryRpc = Pick<
  Connection,
  "getGenesisHash" | "getSignatureStatuses" | "getBlockHeight"
>;

export type ModelBRecoveryInspection = {
  network: string;
  requestId: string;
  signature: string;
  amountBaseUnits: number;
  nonce: string;
  savedBytes: number;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  recoveryState: ReturnType<typeof classifyPayment>;
};

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Read-only Model B inspection of the original v2 claim + owner workflow +
 * signed transaction, followed by RPC status inspection.
 *
 * No signer, claim creation, transaction construction, rebroadcast, or
 * journal mutation is possible through this interface. RPC observations
 * are NOT evidence of permission to create another payment.
 */
export async function inspectModelBRecovery(
  runtimeDir: string,
  requestId: string,
  scope: ApprovalScope,
  rpc: ModelBRecoveryRpc
): Promise<ModelBRecoveryInspection> {
  assert.match(
    requestId,
    REQUEST_ID_PATTERN,
    "Invalid Model B recovery request ID"
  );
  assert.equal(
    scope.programId,
    AGENTVAULT_PROGRAM_ID.toBase58(),
    "Wrong Model B program ID"
  );

  const claim = JSON.parse(
    readFileSync(join(runtimeDir, "journal", `${requestId}.json`), "utf8")
  ) as Record<string, unknown>;
  assert.equal(
    recoveryModeFromClaim(claim, requestId),
    "model-b",
    "Not a Model B journal"
  );

  // The local state and claim must describe the same owner, vault and ledger.
  for (const field of [
    "network",
    "genesisHash",
    "programId",
    "vault",
    "owner",
    "mint",
  ] as const) {
    assert.equal(
      claim[field],
      scope[field],
      `Model B recovery ${field} mismatch`
    );
  }

  // Read the original owner-signed workflow (never re-sign or generate it).
  const signedWorkflow = signedWorkflowV2Schema.parse(
    JSON.parse(
      readFileSync(join(runtimeDir, "approvals", `${requestId}.json`), "utf8")
    )
  );
  assert.equal(signedWorkflow.workflow.requestId, requestId);

  // The existing loader verifies the claimed approval digests, Ed25519 owner
  // signature, full serialized message, and saved agent signature.
  const restored = loadPreparedModelBPayment(
    runtimeDir,
    requestId,
    signedWorkflow,
    scope
  );
  assert.equal(restored.record.network, scope.network);
  assert.ok(
    restored.transaction.signature,
    "Recovered Model B agent signature missing"
  );

  const signatureBytes = Buffer.from(restored.transaction.signature);
  assert.equal(
    signatureBytes.toString("base64"),
    restored.record.transactionSignatureBase64,
    "Recovered Model B agent signature mismatch"
  );
  const signature = bs58.encode(signatureBytes);

  // All local, cryptographic checks must pass BEFORE contacting RPC.
  assert.equal(
    await rpc.getGenesisHash(),
    scope.genesisHash,
    "Model B recovery RPC ledger mismatch"
  );
  const statusResponse = await rpc.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  assert.ok(
    statusResponse && statusResponse.value && statusResponse.value.length === 1
  );
  const currentBlockHeight = await rpc.getBlockHeight("confirmed");
  assert.ok(
    Number.isSafeInteger(currentBlockHeight) && currentBlockHeight >= 0,
    "Invalid Model B recovery block height"
  );
  assert.equal(
    await rpc.getGenesisHash(),
    scope.genesisHash,
    "Model B recovery RPC ledger changed"
  );

  return {
    network: scope.network,
    requestId,
    signature,
    amountBaseUnits: restored.record.amountBaseUnits,
    nonce: restored.record.nonce,
    savedBytes: restored.raw.length,
    currentBlockHeight,
    lastValidBlockHeight: restored.record.lastValidBlockHeight,
    recoveryState: classifyPayment(
      statusResponse.value[0],
      currentBlockHeight,
      restored.record.lastValidBlockHeight
    ),
  };
}
