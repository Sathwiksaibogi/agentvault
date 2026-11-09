import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { evaluateApprovedModelBWorkflow } from "./ai-workflow-model-b";
import { assertModelBAiWorkflowMatchesPolicy } from "./model-b-ai-evaluator-guard";
import { assertUnchangedModelBOwnerPolicy } from "./model-b-owner-policy";
import { buildBoundModelBOwnerInstruction } from "./model-b-workflow-binding";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";

export type ModelBEvaluatedContext = Awaited<
  ReturnType<typeof evaluateApprovedModelBWorkflow>
>;

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Read-only execution gate to call AFTER an explicit human confirmation.
 *
 * The initial evaluator's inspectLivePolicy function is reused, which
 * independently re-fetches chain state, validates all account relationships,
 * checks treasury collateral, reads the chain clock and rejects ledger changes.
 *
 * This gate never loads keys, claims a request, signs, or broadcasts.
 * A later coordinator must not cross the claim boundary until it succeeds.
 */
export async function verifyModelBPostConfirmation(
  runtimeDir: string,
  context: ModelBEvaluatedContext
): Promise<{
  binding: ModelBEvaluatedContext["binding"];
  blockhash: string;
  lastValidBlockHeight: number;
  observedBlockHeight: number;
}> {
  const requestId = context.workflow.requestId;
  assert.match(requestId, REQUEST_ID_PATTERN, "Invalid Model B request ID");
  const claimPath = join(runtimeDir, "journal", `${requestId}.json`);

  assert.ok(
    !existsSync(claimPath),
    "Model B request already claimed; use payment recovery"
  );

  // Fetch a *new* chain snapshot, not the data returned before human review.
  const refreshed = await context.readLivePolicy();
  assertUnchangedModelBOwnerPolicy(context.policySnapshot, refreshed);
  assertModelBAiWorkflowMatchesPolicy(
    context.workflow,
    refreshed,
    context.workflow.agentAuthority
  );

  // Signatures are unchanged. Only chain-observed nonce, expiry and clock
  // are refreshed. Revalidate both original owner signatures at the new time.
  const binding = {
    ...context.binding,
    nowUnix: refreshed.nowUnix,
    nextNonce: refreshed.nextNonce,
    taskExpiresAtUnix: refreshed.taskExpiresAtUnix,
  };
  buildBoundModelBOwnerInstruction(binding);
  const approvedWorkflow = signedWorkflowV2Schema.parse(
    binding.signedWorkflow
  ).workflow;
  assert.deepEqual(
    context.workflow,
    approvedWorkflow,
    "Model B evaluator workflow differs from the signed approval"
  );

  const actualGenesis = await context.connection.getGenesisHash();
  assert.equal(
    actualGenesis,
    context.binding.scope.genesisHash,
    "Model B RPC ledger changed after confirmation"
  );

  const { blockhash, lastValidBlockHeight } =
    await context.connection.getLatestBlockhash("confirmed");
  const observedBlockHeight = await context.connection.getBlockHeight(
    "confirmed"
  );
  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) &&
      Number.isSafeInteger(observedBlockHeight) &&
      observedBlockHeight >= 0 &&
      observedBlockHeight <= lastValidBlockHeight,
    "Model B blockhash already expired"
  );

  // Reject requests that were claimed while the RPC reads were in flight.
  // The later durable preparation still uses an exclusive atomic claim.
  assert.ok(
    !existsSync(claimPath),
    "Model B request claimed during post-confirmation verification"
  );

  return {
    binding,
    blockhash,
    lastValidBlockHeight,
    observedBlockHeight,
  };
}
