import assert from "node:assert/strict";
import test from "node:test";

import { recoveryModeFromClaim } from "./payment-recovery-mode";

const requestId = "recovery-test-001";

const base = {
  requestId,
  status: "claimed",
};

test("routes historical v1 claims to Model A", () => {
  assert.equal(
    recoveryModeFromClaim({ ...base, version: 1 }, requestId),
    "model-a"
  );
});

test("routes explicit v2 claims to Model B", () => {
  assert.equal(
    recoveryModeFromClaim(
      {
        ...base,
        version: 2,
        authorizationModel: "model-b",
      },
      requestId
    ),
    "model-b"
  );
});

test("rejects unknown journal versions", () => {
  assert.throws(
    () => recoveryModeFromClaim({ ...base, version: 3 }, requestId),
    /Unsupported or inconsistent/
  );
});

test("rejects v2 without Model B identification", () => {
  assert.throws(
    () => recoveryModeFromClaim({ ...base, version: 2 }, requestId),
    /Unsupported or inconsistent/
  );
});

test("rejects a Model B claim masquerading as v1", () => {
  assert.throws(
    () =>
      recoveryModeFromClaim(
        {
          ...base,
          version: 1,
          authorizationModel: "model-b",
        },
        requestId
      ),
    /Unsupported or inconsistent/
  );
});

test("rejects another request ID", () => {
  assert.throws(
    () => recoveryModeFromClaim({ ...base, version: 1 }, "another-request-001"),
    /Payment recovery request ID mismatch/
  );
});

test("rejects an unclaimed journal", () => {
  assert.throws(
    () =>
      recoveryModeFromClaim(
        {
          ...base,
          version: 2,
          authorizationModel: "model-b",
          status: "pending",
        },
        requestId
      ),
    /Payment recovery journal is not claimed/
  );
});
