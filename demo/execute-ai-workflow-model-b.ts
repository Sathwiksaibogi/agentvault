import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { NETWORK, RUNTIME_DIR } from "./runtime-config";
import { evaluateApprovedModelBWorkflow } from "./ai-workflow-model-b";
import { buildUnsignedModelBPayment } from "./model-b-payment-builder";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Preview-only Model B execution coordinator.
 * NO --execute path, NO private keys, NO journal claims, NO signed bytes,
 * NO broadcast. A separate reviewed change will add execution.
 */
export async function previewModelBPayment(requestId: string): Promise<void> {
  assert.match(requestId, REQUEST_ID_PATTERN, "Invalid request ID");
  assert.ok(
    !existsSync(join(RUNTIME_DIR, "journal", `${requestId}.json`)),
    "Request already claimed; use payment recovery"
  );

  // This evaluator authenticates both owner approvals, checks live policy,
  // and re-fetches after inference. It can persist an AI decision receipt,
  // but never signs, claims, or broadcasts a transaction.
  const context = await evaluateApprovedModelBWorkflow(requestId);

  const { blockhash } = await context.connection.getLatestBlockhash(
    "confirmed"
  );
  const { transaction } = buildUnsignedModelBPayment(
    context.binding,
    blockhash
  );

  // Simulate with empty transaction signatures. The native Ed25519 instruction
  // still verifies the owner's actual signed approval in the simulated program.
  const message = new TransactionMessage({
    payerKey: transaction.feePayer!,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const unsignedSimulation = new VersionedTransaction(message);
  const simulation = await context.connection.simulateTransaction(
    unsignedSimulation,
    { commitment: "confirmed", sigVerify: false }
  );

  if (simulation.value.err !== null) {
    console.error(simulation.value.logs?.join("\n") ?? "");
    throw new Error(
      `Model B preview simulation failed: ${JSON.stringify(
        simulation.value.err
      )}`
    );
  }

  console.log("\n=== MODEL B PAYMENT PREVIEW VERIFIED ===");
  console.log("Network:", NETWORK);
  console.log("Request:", requestId);
  console.log("Agent:", context.workflow.assignedAgent);
  console.log("Agent authority:", context.workflow.agentAuthority);
  console.log("ApprovedTask:", context.approvedTaskPda.toBase58());
  console.log("Recipient:", context.recipient.toBase58());
  console.log("Amount (base units):", context.workflow.amountBaseUnits);
  console.log("On-chain nonce:", context.nonce);
  console.log("AI decision source:", context.source);
  console.log("Instructions:", transaction.instructions.length);
  console.log(
    "Compute units:",
    simulation.value.unitsConsumed ?? "unavailable"
  );
  console.log("\nNO PRIVATE KEYS LOADED. NO CLAIM, SIGNATURE OR BROADCAST.");
}

if (require.main === module) {
  const [requestId, mode, ...extra] = process.argv.slice(2);
  Promise.resolve()
    .then(async () => {
      assert.ok(
        requestId && REQUEST_ID_PATTERN.test(requestId),
        "Usage: execute-ai-workflow-model-b.ts <request-id> [--preview]"
      );
      assert.ok(
        extra.length === 0 && (mode === undefined || mode === "--preview"),
        "Model B execution is disabled; preview mode only"
      );
      await previewModelBPayment(requestId);
    })
    .catch((error: unknown) => {
      console.error(
        "\nMODEL B PREVIEW STOPPED:",
        error instanceof Error ? error.message : error
      );
      process.exitCode = 1;
    });
}
