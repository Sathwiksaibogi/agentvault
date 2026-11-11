import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type {
  AuthorizedSignedModelBPayment,
  ClaimModelBPayment,
  ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import type { ModelBPreparationBackend } from "./model-b-postgres-durable-preparation";
import {
  createInactiveModelBCoordinatorRuntime,
  createInactiveModelBReaderRecoveryRuntime,
  inspectInactiveModelBRecovery,
  type TrustedModelBPreparationChecks,
} from "./model-b-postgres-inactive-runtime";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";

function memoryStore() {
  let current: ModelBPaymentRecord | null = null;
  const calls = { claim: 0, persist: 0, reserve: 0, reads: 0 };
  const store: ModelBPreparationBackend = {
    async claim(input: ClaimModelBPayment) {
      calls.claim++;
      if (current) throw Error("duplicate durable claim");
      current = {
        ...input,
        phase: "CLAIMED",
        signature: null,
        signedTransaction: null,
        signedTransactionSha256: null,
        lastValidBlockHeight: null,
        finalizedSlot: null,
        finalityObservedAt: null,
      };
      return current;
    },
    async persistSignedPayment(payment: AuthorizedSignedModelBPayment) {
      calls.persist++;
      if (!current || current.phase !== "CLAIMED")
        throw Error("cannot persist");
      const bytes = Buffer.from(payment.signedTransaction);
      current = {
        ...current,
        phase: "PREPARED",
        signedTransaction: bytes,
        signedTransactionSha256: createHash("sha256")
          .update(bytes)
          .digest("hex"),
        signature: payment.signature,
        lastValidBlockHeight: payment.lastValidBlockHeight,
      };
      return current;
    },
    async reserveOneSubmission(_requestId: string) {
      calls.reserve++;
      if (!current || current.phase !== "PREPARED") throw Error("not prepared");
      current = { ...current, phase: "SUBMISSION_RESERVED" };
      return current;
    },
    async getForReconciliation(_requestId: string) {
      calls.reads++;
      return current;
    },
  };
  return {
    store,
    calls,
    get current(): ModelBPaymentRecord | null {
      return current;
    },
    replace(value: ModelBPaymentRecord | null) {
      current = value;
    },
  };
}

function trusted(fx: ReturnType<typeof makeModelBPostgresFixture>) {
  const calls = { genesis: 0, height: 0, policy: 0 };
  let currentHeight = 100;
  let currentGenesis = fx.claim.genesisHash;
  let failPolicy = false;
  const checks: TrustedModelBPreparationChecks = {
    trustedDevnetGenesisHash: fx.claim.genesisHash,
    async getGenesisHash() {
      calls.genesis++;
      return currentGenesis;
    },
    async getBlockHeight(commitment) {
      assert.equal(commitment, "confirmed");
      calls.height++;
      return currentHeight;
    },
    async assertFreshOnChainPolicy() {
      calls.policy++;
      if (failPolicy) throw new Error("trusted policy denied");
    },
  };
  return {
    checks,
    calls,
    setHeight(value: number) {
      currentHeight = value;
    },
    setGenesis(value: string) {
      currentGenesis = value;
    },
    denyPolicy() {
      failPolicy = true;
    },
  };
}

test("inactive runtime exposes preparation and read-only inspection, never reservation or network send", () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-001");
  const runtime = createInactiveModelBCoordinatorRuntime(
    memoryStore().store,
    trusted(fx).checks
  );
  assert.deepEqual(Object.keys(runtime).sort(), ["inspect", "prepare"]);
  assert.equal(Object.isFrozen(runtime), true);
  const reader = createInactiveModelBReaderRecoveryRuntime(memoryStore().store);
  assert.deepEqual(Object.keys(reader), ["inspect"]);
});

test("valid approved payment reaches durable PREPARED only after repeated trusted checks", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-002");
  const db = memoryStore();
  const chain = trusted(fx);
  const runtime = createInactiveModelBCoordinatorRuntime(
    db.store,
    chain.checks
  );
  const result = await runtime.prepare(fx.payment);
  assert.equal(result.phase, "PREPARED");
  assert.deepEqual(chain.calls, { genesis: 2, height: 2, policy: 2 });
  assert.deepEqual(db.calls, { claim: 1, persist: 1, reserve: 0, reads: 0 });
  assert.equal((await runtime.inspect(fx.payment.requestId)).phase, "PREPARED");
});

test("untrusted deployment genesis denies before any PostgreSQL read or write", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-003");
  const db = memoryStore();
  const chain = trusted(fx);
  chain.checks.trustedDevnetGenesisHash =
    makeModelBPostgresFixture().claim.genesisHash;
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, chain.checks).prepare(
      fx.payment
    ),
    /untrusted Devnet/
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(chain.calls.genesis, 0);
});

test("RPC pointing at another ledger denies before the first claim", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-004");
  const db = memoryStore();
  const chain = trusted(fx);
  chain.setGenesis(makeModelBPostgresFixture().claim.genesisHash);
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, chain.checks).prepare(
      fx.payment
    ),
    /RPC ledger mismatch/
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(chain.calls.policy, 0);
});

test("expired blockhash rejects preparation without creating a claim", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-005");
  const db = memoryStore();
  const chain = trusted(fx);
  chain.setHeight(fx.payment.lastValidBlockHeight + 1);
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, chain.checks).prepare(
      fx.payment
    ),
    /blockhash expired/
  );
  assert.equal(db.calls.claim, 0);
});

test("policy failure prevents durable claim, even with matching ledger", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-006");
  const db = memoryStore();
  const chain = trusted(fx);
  chain.denyPolicy();
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, chain.checks).prepare(
      fx.payment
    ),
    /trusted policy denied/
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(db.calls.persist, 0);
});

test("missing policy reader is fail-closed before SQL", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-007");
  const db = memoryStore();
  const checks = trusted(fx).checks;
  const broken = {
    ...checks,
    assertFreshOnChainPolicy: undefined,
  } as unknown as TrustedModelBPreparationChecks;
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, broken).prepare(
      fx.payment
    ),
    /trusted chain checks missing/
  );
  assert.equal(db.calls.claim, 0);
});

test("tampered signed transaction is rejected before chain or database access", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-008");
  const db = memoryStore();
  const chain = trusted(fx);
  const altered = Buffer.from(fx.payment.signedTransaction);
  altered[altered.length - 1] ^= 0x01;
  await assert.rejects(
    createInactiveModelBCoordinatorRuntime(db.store, chain.checks).prepare({
      ...fx.payment,
      signedTransaction: altered,
    }),
    /signature|serialized|payment/
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(chain.calls.genesis, 0);
});

test("lost preparation acknowledgment strands CLAIMED; recovery cannot unlock or retry", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-009");
  const db = memoryStore();
  const faulty: ModelBPreparationBackend = {
    ...db.store,
    async persistSignedPayment() {
      throw new Error("lost write acknowledgment");
    },
  };
  const runtime = createInactiveModelBCoordinatorRuntime(
    faulty,
    trusted(fx).checks
  );
  await assert.rejects(
    runtime.prepare(fx.payment),
    /lost write acknowledgment/
  );
  assert.equal(db.current?.phase, "CLAIMED");
  const recovery = await createInactiveModelBReaderRecoveryRuntime(
    db.store
  ).inspect(fx.payment.requestId);
  assert.equal(recovery.nextAction, "MANUAL_REVIEW");
  assert.equal(recovery.canRetryPreparation, false);
  assert.equal(recovery.canReserveSubmission, false);
  assert.equal(recovery.canBroadcast, false);
  await assert.rejects(runtime.prepare(fx.payment), /duplicate durable claim/);
  assert.equal(db.calls.reserve, 0);
});

test("read-only restart snapshots have no bytes and never call mutation methods", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-010");
  const db = memoryStore();
  const reader = createInactiveModelBReaderRecoveryRuntime(db.store);
  assert.equal((await reader.inspect(fx.payment.requestId)).phase, "NOT_FOUND");
  db.replace({ ...fx.record, phase: "SUBMISSION_RESERVED" });
  const reserved = await reader.inspect(fx.payment.requestId);
  assert.equal(reserved.nextAction, "INSPECT_FINALITY");
  assert.equal(reserved.signature, fx.payment.signature);
  assert.equal("signedTransaction" in reserved, false);
  assert.equal(Object.isFrozen(reserved), true);
  db.replace({ ...fx.record, phase: "UNRESOLVED" });
  assert.equal(
    (await reader.inspect(fx.payment.requestId)).nextAction,
    "INSPECT_FINALITY"
  );
  db.replace({ ...fx.record, phase: "CONFIRMED", finalizedSlot: 321 });
  assert.equal(
    (await reader.inspect(fx.payment.requestId)).nextAction,
    "TERMINAL"
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(db.calls.persist, 0);
  assert.equal(db.calls.reserve, 0);
});

test("corrupted saved bytes fail recovery closed without any mutation", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-011");
  const db = memoryStore();
  db.replace({ ...fx.record, signedTransaction: Buffer.alloc(30) });
  await assert.rejects(
    inspectInactiveModelBRecovery(db.store, fx.payment.requestId),
    /serialized|signature|transaction|digest/i
  );
  assert.equal(db.calls.claim, 0);
  assert.equal(db.calls.reserve, 0);
});

test("recovery rejects a substituted request ID and malformed caller IDs", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-012");
  const db = memoryStore();
  db.replace(fx.record);
  await assert.rejects(
    inspectInactiveModelBRecovery(db.store, "other-request-12"),
    /identity mismatch/
  );
  await assert.rejects(
    inspectInactiveModelBRecovery(db.store, "bad id"),
    /Invalid Model B recovery/
  );
  assert.equal(db.calls.reads, 1);
});

test("terminal phase without finalized slot is never trusted", async () => {
  const fx = makeModelBPostgresFixture("modelb-runtime-guard-013");
  const db = memoryStore();
  db.replace({ ...fx.record, phase: "FAILED", finalizedSlot: null });
  await assert.rejects(
    inspectInactiveModelBRecovery(db.store, fx.payment.requestId),
    /terminal status lacks finalized slot/
  );
});

test("inactive runtime is not imported by the executable Model B CLI", () => {
  const cli = readFileSync(
    resolve(process.cwd(), "demo/execute-ai-workflow-model-b.ts"),
    "utf8"
  );
  assert.doesNotMatch(cli, /model-b-postgres-inactive-runtime/);
  const broadcast = readFileSync(
    resolve(process.cwd(), "demo/model-b-postgres-broadcast-boundary.ts"),
    "utf8"
  );
  assert.doesNotMatch(broadcast, /model-b-postgres-inactive-runtime/);
});
