import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";

import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { NETWORK, RUNTIME_DIR } from "./runtime-config";
import { evaluateApprovedModelBWorkflow } from "./ai-workflow-model-b";
import { buildUnsignedModelBPayment } from "./model-b-payment-builder";
import { coordinateModelBExecution } from "./model-b-execution-coordinator";
import { verifyModelBPostConfirmation } from "./model-b-post-confirmation-gate";
import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { submitSignedModelBPayment } from "./model-b-signed-submission";
import {
  assertModelBExecutionAllowed,
  loadModelBAgentSigner,
  parseModelBCliArguments,
} from "./model-b-cli-policy";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/** Preview-only Model B workflow path. This function never touches signing keys. */
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

/**
 * Explicit, Devnet-only execution wiring. The isolated coordinator owns
 * confirmation, post-confirmation policy rechecks, signing, persistence and
 * exactly one signed-byte send. Never retry after a journal claim.
 */
export async function executeModelBPayment(requestId: string): Promise<void> {
  assert.match(requestId, REQUEST_ID_PATTERN, "Invalid Model B request ID");
  assertModelBExecutionAllowed(NETWORK, process.stdin.isTTY === true);
  assert.ok(
    !existsSync(join(RUNTIME_DIR, "journal", `${requestId}.json`)),
    "Model B request already claimed; use payment recovery"
  );

  const context = await evaluateApprovedModelBWorkflow(requestId);
  console.log("\n=== MODEL B DEVNET PAYMENT AUTHORIZED FOR REVIEW ===");
  console.log("Request:", requestId);
  console.log("Agent:", context.workflow.assignedAgent);
  console.log("Approved task:", context.approvedTaskPda.toBase58());
  console.log("Recipient:", context.recipient.toBase58());
  console.log("Amount (base units):", context.workflow.amountBaseUnits);
  console.log("Nonce:", context.nonce);
  console.log("Journal will be locked once signing begins.");

  const result = await coordinateModelBExecution(
    RUNTIME_DIR,
    context,
    { network: NETWORK, interactive: process.stdin.isTTY === true },
    {
      async askForConfirmation(expectedPhrase: string): Promise<string> {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          return await rl.question(
            `\nType ${expectedPhrase} to authorize ONE Devnet payment: `
          );
        } finally {
          rl.close();
        }
      },
      verifyAfterConfirmation: verifyModelBPostConfirmation,
      loadAgentSigner(agent) {
        return loadModelBAgentSigner(RUNTIME_DIR, agent);
      },
      prepareDurablePayment: prepareDurableModelBPayment,
      submitStoredPayment: submitSignedModelBPayment,
    }
  );

  console.log("\n=== MODEL B PAYMENT CONFIRMED ===");
  console.log("Request:", result.requestId);
  console.log("Signature:", result.signature);
  console.log(
    `Explorer: https://explorer.solana.com/tx/${result.signature}?cluster=devnet`
  );
  console.log("Original signed bytes remain durably journaled.");
}

if (require.main === module) {
  Promise.resolve()
    .then(async () => {
      const { requestId, mode } = parseModelBCliArguments(
        process.argv.slice(2)
      );
      if (mode === "preview") {
        await previewModelBPayment(requestId);
      } else {
        await executeModelBPayment(requestId);
      }
    })
    .catch((error: unknown) => {
      console.error(
        "\nMODEL B WORKFLOW STOPPED:",
        error instanceof Error ? error.message : error
      );
      console.error(
        "If a journal claim exists, NEVER delete it or run --execute again."
      );
      console.error("Inspect the original saved payment with:");
      console.error("  pnpm exec tsx demo/payment-recovery.ts <request-id>");
      process.exitCode = 1;
    });
}
