export const AGENT_WORKFLOWS = {
  "agent-a": "procurement",
  "agent-b": "operations",
} as const;

export type AgentId = keyof typeof AGENT_WORKFLOWS;

export type WorkflowKind = (typeof AGENT_WORKFLOWS)[AgentId];

export type TrustedWorkflow = {
  requestId: string;
  assignedAgent: AgentId;
  kind: WorkflowKind;
  taskId: number;
  amountBaseUnits: number;
  description: string;
};

export type AiProposal = {
  decision: "PAY" | "REJECT";
  amountBaseUnits: number;
  reason: string;
};

export type GateResult =
  | { approved: true }
  | {
      approved: false;
      code: string;
      reason: string;
    };

export const MAX_PAYMENT_AMOUNT = 50_000;

function reject(code: string, reason: string): GateResult {
  return { approved: false, code, reason };
}

export function validateWorkflowProposal(
  workflow: TrustedWorkflow,
  selectedAgent: AgentId,
  proposal: AiProposal
): GateResult {
  // 1. Validate the business request identifier.
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(workflow.requestId)) {
    return reject(
      "INVALID_REQUEST_ID",
      "Workflow must have a valid request ID"
    );
  }

  // 2. Enforce explicit workflow-to-agent assignment.
  if (workflow.assignedAgent !== selectedAgent) {
    return reject(
      "AGENT_MISMATCH",
      "Workflow is assigned to a different agent"
    );
  }

  // 3. Enforce deterministic business responsibility.
  if (AGENT_WORKFLOWS[selectedAgent] !== workflow.kind) {
    return reject(
      "WORKFLOW_MISMATCH",
      "Agent is not authorized for this workflow type"
    );
  }

  // 4. Require a valid task identifier.
  if (!Number.isSafeInteger(workflow.taskId) || workflow.taskId < 0) {
    return reject("INVALID_TASK", "Invalid workflow task ID");
  }

  // 5. Validate the original authorized amount.
  if (
    !Number.isSafeInteger(workflow.amountBaseUnits) ||
    workflow.amountBaseUnits <= 0
  ) {
    return reject(
      "INVALID_AMOUNT",
      "Workflow amount must be a positive safe integer"
    );
  }

  // 6. Enforce the application-level payment cap.
  if (workflow.amountBaseUnits > MAX_PAYMENT_AMOUNT) {
    return reject(
      "PAYMENT_CAP_EXCEEDED",
      "Workflow amount exceeds the per-payment cap"
    );
  }

  // 7. An AI rejection must never produce a payment.
  if (proposal.decision !== "PAY") {
    return reject("AI_REJECTED", "AI did not recommend this payment");
  }

  // 8. Ensure Gemini did not change the approved amount.
  if (
    !Number.isSafeInteger(proposal.amountBaseUnits) ||
    proposal.amountBaseUnits !== workflow.amountBaseUnits
  ) {
    return reject(
      "AMOUNT_MISMATCH",
      "AI proposal does not match the authorized amount"
    );
  }

  // 9. Require a nonempty reason for auditability.
  if (
    typeof proposal.reason !== "string" ||
    proposal.reason.trim().length === 0 ||
    proposal.reason.length > 500
  ) {
    return reject("INVALID_REASON", "AI proposal must provide a valid reason");
  }

  return { approved: true };
}
