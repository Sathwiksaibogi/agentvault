import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyPayment,
  type ObservedSignatureStatus,
} from "./payment-recovery-state";

const successful = (
  confirmationStatus: "processed" | "confirmed" | "finalized"
): ObservedSignatureStatus => ({
  err: null,
  confirmationStatus,
});

test("recognizes a confirmed transaction", () => {
  assert.equal(classifyPayment(successful("confirmed"), 100, 120), "CONFIRMED");
});

test("recognizes a finalized transaction", () => {
  assert.equal(classifyPayment(successful("finalized"), 150, 120), "CONFIRMED");
});

test("recognizes a failed on-chain transaction", () => {
  assert.equal(
    classifyPayment(
      {
        err: { InstructionError: [1, "Custom"] },
        confirmationStatus: "confirmed",
      },
      110,
      120
    ),
    "FAILED_ON_CHAIN"
  );
});

test("does not treat processed as confirmed", () => {
  assert.equal(
    classifyPayment(successful("processed"), 105, 120),
    "OBSERVED_UNCONFIRMED"
  );
});

test("recognizes a pending unobserved transaction", () => {
  assert.equal(classifyPayment(null, 110, 120), "PENDING");
});

test("treats the last valid block height as pending", () => {
  assert.equal(classifyPayment(null, 120, 120), "PENDING");
});

test("keeps expired unobserved payments unresolved", () => {
  assert.equal(classifyPayment(null, 121, 120), "EXPIRED_UNRESOLVED");
});

test("does not discard an observed failure after expiry", () => {
  assert.equal(
    classifyPayment(
      {
        err: { InstructionError: [1, "Custom"] },
        confirmationStatus: "finalized",
      },
      200,
      120
    ),
    "FAILED_ON_CHAIN"
  );
});

test("does not treat processed-only errors as definitive", () => {
  assert.equal(
    classifyPayment(
      {
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "processed",
      },
      110,
      120
    ),
    "OBSERVED_UNCONFIRMED"
  );
});
