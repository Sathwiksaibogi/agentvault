import assert from "node:assert/strict";

export type PaymentRecoveryMode = "model-a" | "model-b";

export function recoveryModeFromClaim(
  input: unknown,
  requestId: string
): PaymentRecoveryMode {
  assert.match(requestId, /^[a-zA-Z0-9_-]{8,64}$/);

  assert.ok(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "Invalid payment recovery journal"
  );

  const claim = input as Record<string, unknown>;

  assert.equal(
    claim.status,
    "claimed",
    "Payment recovery journal is not claimed"
  );

  assert.equal(
    claim.requestId,
    requestId,
    "Payment recovery request ID mismatch"
  );

  // Historical Model A claims do not have an
  // authorizationModel field.
  if (claim.version === 1 && claim.authorizationModel === undefined) {
    return "model-a";
  }

  if (claim.version === 2 && claim.authorizationModel === "model-b") {
    return "model-b";
  }

  // Never guess, downgrade, or silently fall back.
  throw new Error("Unsupported or inconsistent payment recovery journal");
}
