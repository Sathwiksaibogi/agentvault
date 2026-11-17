import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";

import type { ModelBEvaluatedContext } from "./model-b-post-confirmation-gate";
import type { AgentId } from "./workflow-policy";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import { buildBoundModelBOwnerInstruction } from "./model-b-workflow-binding";
import type { verifyModelBPostConfirmation } from "./model-b-post-confirmation-gate";
import type { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import type { submitSignedModelBPayment } from "./model-b-signed-submission";

export type ModelBExecutionEnvironment = {
  network: string;
  interactive: boolean;
};

/**
 * Explicit dependencies keep this coordinator disconnected from the CLI.
 * Production wiring must supply the real policy gate, durable preparation,
 * and signed-byte submission functions. This module has no entry point.
 */
export type ModelBExecutionServices = {
  askForConfirmation: (expectedPhrase: string) => Promise<string>;
  verifyAfterConfirmation: typeof verifyModelBPostConfirmation;
  loadAgentSigner: (agent: AgentId) => Keypair;
  prepareDurablePayment: typeof prepareDurableModelBPayment;
  submitStoredPayment: typeof submitSignedModelBPayment;
};

export type ModelBExecutionResult = {
  requestId: string;
  signature: string;
  status: "confirmed";
};

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Compose an approved Model B payment without any retry or replacement path.
 * Never call this from a CLI until real local-validator lifecycle checks pass.
 *
 * Order:
 * 1. Authenticate input and require Devnet + interactive session.
 * 2. Ask for explicit human confirmation (no keys loaded yet).
 * 3. Re-fetch policy and validate expiry, nonce and blockhash.
 * 4. Load only the exact assigned agent's key.
 * 5. Exclusively claim, sign and durably persist once.
 * 6. Submit *only* the previously saved bytes once.
 *
 * Failure after step 5 leaves the journal locked. Recovery must inspect the
 * original signed transaction rather than create a new payment.
 */
export async function coordinateModelBExecution(
  runtimeDir: string,
  context: ModelBEvaluatedContext,
  environment: ModelBExecutionEnvironment,
  services: ModelBExecutionServices
): Promise<ModelBExecutionResult> {
  // Never permit an accidental live execution on localnet or without a TTY.
  assert.equal(
    environment.network,
    "devnet",
    "Model B execution is Devnet-only"
  );
  assert.equal(
    environment.interactive,
    true,
    "Model B execution requires a terminal"
  );
  assert.equal(
    context.binding.scope.network,
    "devnet",
    "Model B owner scope must be Devnet"
  );

  const signed = signedWorkflowV2Schema.parse(context.binding.signedWorkflow);
  const workflow = signed.workflow;
  const requestId = workflow.requestId;
  assert.match(requestId, REQUEST_ID_PATTERN, "Invalid Model B request ID");
  assert.equal(workflow.network, "devnet", "Model B workflow network mismatch");
  assert.deepEqual(
    context.workflow,
    workflow,
    "Model B evaluator workflow mismatch"
  );
  assert.ok(
    !existsSync(join(runtimeDir, "journal", `${requestId}.json`)),
    "Model B request already claimed; use payment recovery"
  );

  // Cryptographic approval check before soliciting consent.
  buildBoundModelBOwnerInstruction(context.binding);

  const phrase = `EXECUTE MODEL-B ${requestId}`;
  const answer = await services.askForConfirmation(phrase);
  assert.equal(answer.trim(), phrase, "Model B execution cancelled");

  // No signer access until a fresh post-confirmation chain revalidation passes.
  const fresh = await services.verifyAfterConfirmation(runtimeDir, context);
  assert.deepEqual(fresh.binding.scope, context.binding.scope);
  assert.deepEqual(
    fresh.binding.signedWorkflow,
    context.binding.signedWorkflow
  );
  assert.deepEqual(
    fresh.binding.paymentApproval,
    context.binding.paymentApproval
  );
  assert.equal(fresh.binding.signatureBase64, context.binding.signatureBase64);
  assert.ok(fresh.binding.agentPda.equals(context.binding.agentPda));
  assert.ok(
    fresh.binding.approvedTaskPda.equals(context.binding.approvedTaskPda)
  );
  assert.ok(
    fresh.binding.nowUnix >= context.binding.nowUnix,
    "Model B chain clock went backwards"
  );
  assert.equal(fresh.binding.nextNonce, context.binding.nextNonce);

  // The assigned authority comes from the authenticated owner workflow, not AI.
  const signer = services.loadAgentSigner(workflow.assignedAgent);
  assert.ok(
    signer.publicKey.toBase58() === workflow.agentAuthority,
    "Model B assigned agent key mismatch"
  );

  // This is the irreversible boundary: exclusive journal claim and persisted
  // signature. Never call the preparation function again after an error.
  const prepared = services.prepareDurablePayment(
    runtimeDir,
    fresh.binding,
    signer,
    fresh.blockhash,
    fresh.lastValidBlockHeight
  );
  assert.equal(
    prepared.requestId,
    requestId,
    "Model B prepared request mismatch"
  );
  assert.equal(
    prepared.blockhash,
    fresh.blockhash,
    "Model B prepared blockhash mismatch"
  );
  assert.equal(prepared.lastValidBlockHeight, fresh.lastValidBlockHeight);

  // The actual implementation only reloads the saved bytes and sends them.
  // Errors propagate without retrying, re-signing or clearing the journal.
  const result = await services.submitStoredPayment(
    runtimeDir,
    fresh.binding,
    prepared,
    context.connection
  );
  assert.equal(
    result.signature,
    prepared.signature,
    "Model B submitted signature mismatch"
  );
  assert.equal(result.status, "confirmed");

  return { requestId, signature: result.signature, status: "confirmed" };
}
