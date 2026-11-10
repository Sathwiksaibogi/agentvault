import assert from "node:assert/strict";
import test from "node:test";

import { requireModelBPayRecommendation } from "./model-b-ai-rejection";

test("Model B PAY passes unchanged to strict receipt validation", () => {
  const proposal = {
    decision: "PAY" as const,
    amountBaseUnits: 1000,
    reason: "Approved simulated procurement purchase",
  };
  assert.strictEqual(requireModelBPayRecommendation(proposal), proposal);
});

test("valid Gemini REJECT with zero amount fails closed with a policy reason", () => {
  assert.throws(
    () =>
      requireModelBPayRecommendation({
        decision: "REJECT",
        amountBaseUnits: 0,
        reason: "Not a procurement purchase",
      }),
    /AI_REJECTED.*Not a procurement purchase/
  );
});

test("REJECT never becomes PAY even if amount is nonzero", () => {
  assert.throws(
    () =>
      requireModelBPayRecommendation({
        decision: "REJECT",
        amountBaseUnits: 1000,
        reason: "Rejected",
      }),
    /AI_REJECTED/
  );
});

test("rejection message cannot inject control characters into terminal", () => {
  assert.throws(
    () =>
      requireModelBPayRecommendation({
        decision: "REJECT",
        amountBaseUnits: 0,
        reason: "No purchase\nLOG: forged",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AI_REJECTED/);
      assert.ok(!error.message.includes("\n"));
      return true;
    }
  );
});

test("a PAY amount remains unmodified for downstream exact-amount checks", () => {
  const proposal = {
    decision: "PAY" as const,
    amountBaseUnits: 999,
    reason: "Consider",
  };
  assert.equal(requireModelBPayRecommendation(proposal).amountBaseUnits, 999);
});
