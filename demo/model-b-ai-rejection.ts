import type { AiProposal } from "./workflow-policy";

/**
 * The Model B decision-receipt code only persists payable decisions.
 * A valid Gemini REJECT (amount=0) must fail closed as AI_REJECTED,
 * not surface as an unrelated PAY-only receipt-schema error.
 *
 * Never transform REJECT into PAY, and never cache a negative decision
 * as an approved receipt. This function has no filesystem/network effects.
 */
export function requireModelBPayRecommendation(
  proposal: AiProposal
): AiProposal {
  if (proposal.decision === "REJECT") {
    const reason = proposal.reason.replace(/[\x00-\x1f\x7f]/g, " ").trim();
    throw new Error(
      `Model B AI policy rejected: AI_REJECTED${reason ? ` — ${reason}` : ""}`
    );
  }
  return proposal;
}
