import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PaymentIntentConflict,
  receiveModelAPaymentIntent,
  validateModelAPaymentIntent,
} from "./model-a-payment-intake.ts";

const VAULT = "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep";
const AGENT = "8xF8jf7n4WHVNekuEggo9Ekvt8NYEarNo1c9M6fFD7pY";
const RECIPIENT = "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc";
const NOW = 1794590000;
const scope = {
  network: "devnet",
  vault: VAULT,
  principalId: "developer:example",
  nowUnix: NOW,
};
const input = {
  requestId: "invoice_1042",
  agentAuthority: AGENT,
  taskId: "1",
  recipient: RECIPIENT,
  amountBaseUnits: "10000",
  expiresAtUnix: String(NOW + 3600),
  reason: "Completed report delivery",
};
function tempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "av-intake-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("valid request is durable, Devnet-scoped, and not marked executed or approved", () =>
  tempDir((dir) => {
    const result = receiveModelAPaymentIntent({
      runtimeDir: dir,
      trustedScope: scope,
      input,
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.record.status, "received");
    assert.equal(result.record.network, "devnet");
    assert.equal(result.record.vault, VAULT);
    assert.equal(result.record.principalId, scope.principalId);
    const files = readdirSync(join(dir, "payment-intent-inbox"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(dir, "payment-intent-inbox", files[0]), "utf8")
      ),
      result.record
    );
    assert.equal(
      statSync(join(dir, "payment-intent-inbox", files[0])).mode & 0o777,
      0o600
    );
    assert.equal(readdirSync(dir).includes("journal"), false);
  }));

test("identical retry reads the original entry without duplicating it", () =>
  tempDir((dir) => {
    const a = receiveModelAPaymentIntent({
      runtimeDir: dir,
      trustedScope: scope,
      input,
    });
    const b = receiveModelAPaymentIntent({
      runtimeDir: dir,
      trustedScope: { ...scope, nowUnix: NOW + 2 },
      input,
    });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.deepEqual(a.record, b.record);
    assert.equal(readdirSync(join(dir, "payment-intent-inbox")).length, 1);
  }));

test("different amount, recipient, or principal with same request ID conflicts", () =>
  tempDir((dir) => {
    receiveModelAPaymentIntent({ runtimeDir: dir, trustedScope: scope, input });
    for (const other of [
      { ...input, amountBaseUnits: "20000" },
      { ...input, recipient: AGENT },
    ]) {
      assert.throws(
        () =>
          receiveModelAPaymentIntent({
            runtimeDir: dir,
            trustedScope: scope,
            input: other,
          }),
        PaymentIntentConflict
      );
    }
    assert.throws(
      () =>
        receiveModelAPaymentIntent({
          runtimeDir: dir,
          trustedScope: { ...scope, principalId: "developer:other" },
          input,
        }),
      PaymentIntentConflict
    );
  }));

test("two vaults may use the same ID but are isolated on disk", () =>
  tempDir((dir) => {
    receiveModelAPaymentIntent({ runtimeDir: dir, trustedScope: scope, input });
    receiveModelAPaymentIntent({
      runtimeDir: dir,
      trustedScope: { ...scope, vault: RECIPIENT },
      input,
    });
    assert.equal(readdirSync(join(dir, "payment-intent-inbox")).length, 2);
  }));

test("strict amount parsing rejects floats, unsafe values and out-of-range u64", () => {
  for (const amountBaseUnits of [
    0,
    1,
    "0",
    "1.2",
    "-1",
    "01",
    "1e3",
    "18446744073709551616",
  ]) {
    assert.throws(() =>
      validateModelAPaymentIntent({ ...input, amountBaseUnits }, NOW)
    );
  }
  assert.equal(
    validateModelAPaymentIntent(
      { ...input, amountBaseUnits: "18446744073709551615" },
      NOW
    ).amountBaseUnits,
    "18446744073709551615"
  );
});

test("rejects noncanonical ids, invalid pubkeys, injected context and extra keys", () => {
  for (const invalid of [
    { ...input, requestId: "../bad" },
    { ...input, agentAuthority: "not-a-key" },
    { ...input, recipient: "0".repeat(44) },
    { ...input, vault: VAULT },
    { ...input, principalId: "owner" },
    { ...input, reason: "a\ntrick" },
  ])
    assert.throws(() => validateModelAPaymentIntent(invalid, NOW));
});

test("rejects expired, distant, or invalid request expiration", () => {
  for (const expiresAtUnix of [
    "0",
    String(NOW),
    String(NOW - 1),
    String(NOW + 86401),
    "1.5",
    "99999999999999999999999",
  ]) {
    assert.throws(() =>
      validateModelAPaymentIntent({ ...input, expiresAtUnix }, NOW)
    );
  }
});

test("fails closed outside Devnet or with an untrusted scope", () =>
  tempDir((dir) => {
    for (const trustedScope of [
      { ...scope, network: "localnet" },
      { ...scope, vault: "bad" },
      { ...scope, principalId: " " },
      { ...scope, nowUnix: NaN },
    ]) {
      assert.throws(() =>
        receiveModelAPaymentIntent({ runtimeDir: dir, trustedScope, input })
      );
    }
  }));

test("corrupted existing entry halts intake instead of pretending success", () =>
  tempDir((dir) => {
    receiveModelAPaymentIntent({ runtimeDir: dir, trustedScope: scope, input });
    const file = readdirSync(join(dir, "payment-intent-inbox"))[0];
    writeFileSync(join(dir, "payment-intent-inbox", file), "{broken");
    assert.throws(
      () =>
        receiveModelAPaymentIntent({
          runtimeDir: dir,
          trustedScope: scope,
          input,
        }),
      /reconciliation/
    );
  }));
