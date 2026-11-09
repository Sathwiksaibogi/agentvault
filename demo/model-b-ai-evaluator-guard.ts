import assert from "node:assert/strict";

import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { ModelBOwnerPolicySnapshot } from "./model-b-owner-policy";
import { AGENT_WORKFLOWS, MAX_PAYMENT_AMOUNT } from "./workflow-policy";

/**
 * Compare an authenticated Model B workflow with a fresh on-chain
 * policy snapshot. Signature validation happens separately in the
 * Model B approval loader; this helper must not authorize payments.
 */
export function assertModelBAiWorkflowMatchesPolicy(
  workflow: WorkflowApprovalV2,
  snapshot: ModelBOwnerPolicySnapshot,
  trustedAgentAuthority: string
): void {
  assert.equal(workflow.version, 2, "Model B requires workflow v2");
  assert.equal(workflow.authorizationModel, "model-b");
  assert.equal(
    workflow.kind,
    AGENT_WORKFLOWS[workflow.assignedAgent],
    "Model B agent workflow mismatch"
  );
  assert.equal(
    workflow.agentAuthority,
    trustedAgentAuthority,
    "Model B untrusted agent authority"
  );
  assert.equal(
    workflow.recipient,
    snapshot.recipient,
    "Model B on-chain recipient differs from signed workflow"
  );
  assert.ok(
    Number.isSafeInteger(workflow.amountBaseUnits) &&
      workflow.amountBaseUnits > 0 &&
      workflow.amountBaseUnits <= MAX_PAYMENT_AMOUNT,
    "Model B amount exceeds application cap"
  );
  assert.ok(
    BigInt(workflow.expiresAtUnix) <= BigInt(snapshot.taskExpiresAtUnix),
    "Model B workflow outlives on-chain task"
  );
  assert.ok(
    BigInt(workflow.amountBaseUnits) <= BigInt(snapshot.remaining),
    "Model B workflow exceeds remaining task budget"
  );
  assert.ok(
    BigInt(workflow.amountBaseUnits) <= BigInt(snapshot.totalReserved),
    "Model B workflow exceeds reserved funds"
  );
}
