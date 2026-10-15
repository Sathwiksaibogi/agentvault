import { existsSync } from "node:fs";
import { join } from "node:path";

import { verifyWorkflowApproval, type ApprovalScope } from "./signed-workflow";

import type { AiProposal } from "./workflow-policy";

import {
  loadAiDecisionReceipt,
  saveAiDecisionReceipt,
} from "./ai-decision-receipt";

export type AiDecisionSource = "cache" | "gemini";

export async function resolveAiDecision(
  runtimeDir: string,
  signedApproval: unknown,
  scope: ApprovalScope,
  keyHex: string,
  nowUnix: number,
  evaluateWithGemini: () => Promise<AiProposal>
): Promise<{
  proposal: AiProposal;
  source: AiDecisionSource;
}> {
  // Verify the signed workflow before constructing
  // any path or using a cached decision.
  const workflow = verifyWorkflowApproval(signedApproval, scope, nowUnix);

  const path = join(runtimeDir, "ai-decisions", `${workflow.requestId}.json`);

  if (existsSync(path)) {
    // IMPORTANT:
    // An invalid or expired receipt must fail closed.
    // Never fall back to Gemini automatically.
    const proposal = loadAiDecisionReceipt(
      runtimeDir,
      signedApproval,
      scope,
      keyHex,
      nowUnix
    );

    return { proposal, source: "cache" };
  }

  // Only a missing receipt permits a new Gemini call.
  const proposal = await evaluateWithGemini();

  // This performs deterministic policy validation,
  // authentication and exclusive durable storage.
  const saved = saveAiDecisionReceipt(
    runtimeDir,
    signedApproval,
    scope,
    proposal,
    keyHex,
    nowUnix
  );

  return {
    proposal: saved.receipt.proposal,
    source: "gemini",
  };
}
