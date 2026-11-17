import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { GuardedPostgresModelBPaymentStore } from "./model-b-postgres-payment-store";
import type {
  ClaimModelBPayment,
  ModelBPaymentRecord,
  AuthorizedSignedModelBPayment,
} from "./model-b-postgres-payment-store";
import {
  prepareModelBPaymentDurably,
  reserveOriginalModelBSubmissionOnce,
  inspectDurableModelBPayment,
  type ModelBPreparationBackend,
} from "./model-b-postgres-durable-preparation";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";

function inMemoryBackend() {
  let current: ModelBPaymentRecord | null = null;
  const calls = { claim: 0, prepare: 0, reserve: 0, read: 0 };
  const store: ModelBPreparationBackend = {
    async claim(input: ClaimModelBPayment) {
      calls.claim++;
      if (current) throw new Error("already claimed");
      current = {
        ...input,
        phase: "CLAIMED",
        signedTransaction: null,
        signedTransactionSha256: null,
        signature: null,
        lastValidBlockHeight: null,
        finalizedSlot: null,
        finalityObservedAt: null,
      };
      return current;
    },
    async persistSignedPayment(input: AuthorizedSignedModelBPayment) {
      calls.prepare++;
      if (!current || current.phase !== "CLAIMED")
        throw new Error("already transitioned");
      const bytes = Buffer.from(input.signedTransaction);
      current = {
        ...current,
        phase: "PREPARED",
        signedTransaction: bytes,
        signedTransactionSha256: createHash("sha256")
          .update(bytes)
          .digest("hex"),
        signature: input.signature,
        lastValidBlockHeight: input.lastValidBlockHeight,
      };
      return current;
    },
    async reserveOneSubmission(_id: string) {
      calls.reserve++;
      if (!current || current.phase !== "PREPARED")
        throw new Error("already transitioned");
      current = { ...current, phase: "SUBMISSION_RESERVED" };
      return current;
    },
    async getForReconciliation(_id: string) {
      calls.read++;
      return current;
    },
  };
  return {
    store,
    calls,
    get current() {
      return current;
    },
  };
}

test("inactive adapter prepares an exact approved payment without reserving or sending", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-001");
  const backend = inMemoryBackend();
  const record = await prepareModelBPaymentDurably(backend.store, fx.payment);
  assert.equal(record.phase, "PREPARED");
  assert.deepEqual(record.signedTransaction, fx.payment.signedTransaction);
  assert.deepEqual(backend.calls, {
    claim: 1,
    prepare: 1,
    reserve: 0,
    read: 0,
  });
});

test("forged or mutated approved payment fails before any database operation", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-002");
  const backend = inMemoryBackend();
  const bytes = Buffer.from(fx.payment.signedTransaction);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(
    prepareModelBPaymentDurably(backend.store, {
      ...fx.payment,
      signedTransaction: bytes,
    }),
    /signature|serialized|payment/
  );
  assert.equal(backend.calls.claim, 0);
  assert.equal(backend.calls.prepare, 0);
});

test("unexpected claim identity or phase is never prepared", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-003");
  const backend = inMemoryBackend();
  const corrupt: ModelBPreparationBackend = {
    ...backend.store,
    claim: async (claim) => ({
      ...claim,
      vault: makeModelBPostgresFixture().claim.vault,
      phase: "CLAIMED",
      signedTransaction: null,
      signedTransactionSha256: null,
      signature: null,
      lastValidBlockHeight: null,
    }),
  };
  await assert.rejects(
    prepareModelBPaymentDurably(corrupt, fx.payment),
    /CONFLICT/
  );
  assert.equal(backend.calls.prepare, 0);
});

test("an exception after claim leaves a locked request; the adapter never retries", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-004");
  const backend = inMemoryBackend();
  const faulty: ModelBPreparationBackend = {
    ...backend.store,
    async persistSignedPayment() {
      throw Error("simulated post-claim crash");
    },
  };
  await assert.rejects(
    prepareModelBPaymentDurably(faulty, fx.payment),
    /post-claim crash/
  );
  assert.equal(backend.current?.phase, "CLAIMED");
  assert.equal(backend.calls.claim, 1);
  await assert.rejects(
    prepareModelBPaymentDurably(faulty, fx.payment),
    /already claimed/
  );
  assert.equal(backend.calls.claim, 2);
  assert.equal(backend.calls.reserve, 0);
});

test("corrupted prepared response is rejected rather than accepted", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-005");
  const backend = inMemoryBackend();
  const faulty: ModelBPreparationBackend = {
    ...backend.store,
    async persistSignedPayment(input) {
      const record = await backend.store.persistSignedPayment(input);
      return { ...record, signedTransactionSha256: "f".repeat(64) };
    },
  };
  await assert.rejects(
    prepareModelBPaymentDurably(faulty, fx.payment),
    /CONFLICT/
  );
  assert.equal(backend.calls.reserve, 0);
});

test("reservation requires an existing exact PREPARED request", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-006");
  const backend = inMemoryBackend();
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    /SUBMISSION_LOCKED/
  );
  assert.equal(backend.calls.reserve, 0);
  await backend.store.claim(fx.claim);
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    /SUBMISSION_LOCKED/
  );
  assert.equal(backend.calls.reserve, 0);
});

test("the one winner receives the exact original bytes, and a second permit is denied", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-007");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const permit = await reserveOriginalModelBSubmissionOnce(
    backend.store,
    fx.payment
  );
  assert.equal(permit.phase, "SUBMISSION_RESERVED");
  assert.equal(permit.signature, fx.payment.signature);
  assert.deepEqual(permit.signedTransaction, fx.payment.signedTransaction);
  assert.notStrictEqual(permit.signedTransaction, fx.payment.signedTransaction);
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    /SUBMISSION_LOCKED/
  );
  assert.equal(backend.calls.reserve, 1);
});

test("an altered owner approval is denied before a submission permit", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-008");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const changed = {
    ...fx.payment,
    binding: {
      ...fx.payment.binding,
      paymentApproval: {
        ...fx.binding.paymentApproval,
        amountBaseUnits: "2",
      },
    },
  };
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, changed),
    /amount|approval|signature|match/
  );
  assert.equal(backend.calls.reserve, 0);
});

test("a corrupted stored transaction never receives a permit", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-009");
  const backend = inMemoryBackend();
  const faulty: ModelBPreparationBackend = {
    ...backend.store,
    async getForReconciliation(id) {
      const record = await backend.store.getForReconciliation(id);
      if (!record) return null;
      return { ...record, signedTransaction: Buffer.alloc(20) };
    },
  };
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(faulty, fx.payment),
    /CONFLICT/
  );
  assert.equal(backend.calls.reserve, 0);
});

test("two concurrent reservations produce exactly one winner", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-010");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const outcomes = await Promise.allSettled([
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
  assert.equal(backend.current?.phase, "SUBMISSION_RESERVED");
});

test("ambiguous reservation response never creates a second attempt", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-011");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const ambiguous: ModelBPreparationBackend = {
    ...backend.store,
    async reserveOneSubmission(id) {
      await backend.store.reserveOneSubmission(id);
      throw Error("lost SQL response after committed reservation");
    },
  };
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(ambiguous, fx.payment),
    /lost SQL response/
  );
  assert.equal(backend.current?.phase, "SUBMISSION_RESERVED");
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    /SUBMISSION_LOCKED/
  );
  assert.equal(backend.calls.reserve, 1);
});

test("reservation response substitution fails closed after one committed CAS", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-013");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const faulty: ModelBPreparationBackend = {
    ...backend.store,
    async reserveOneSubmission(id) {
      const record = await backend.store.reserveOneSubmission(id);
      return { ...record, signature: "invalid-signature" };
    },
  };
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(faulty, fx.payment),
    /CONFLICT/
  );
  assert.equal(backend.current?.phase, "SUBMISSION_RESERVED");
  await assert.rejects(
    reserveOriginalModelBSubmissionOnce(backend.store, fx.payment),
    /SUBMISSION_LOCKED/
  );
  assert.equal(backend.calls.reserve, 1);
});

test("terminal and unresolved records never become new submissions", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-014");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  for (const phase of ["UNRESOLVED", "CONFIRMED", "FAILED"] as const) {
    const frozen: ModelBPreparationBackend = {
      ...backend.store,
      async getForReconciliation(id) {
        const record = await backend.store.getForReconciliation(id);
        return record ? { ...record, phase } : null;
      },
    };
    await assert.rejects(
      reserveOriginalModelBSubmissionOnce(frozen, fx.payment),
      /SUBMISSION_LOCKED/
    );
  }
  assert.equal(backend.calls.reserve, 0);
});

test("restart inspection reads the locked request but never signs or reserves", async () => {
  const fx = makeModelBPostgresFixture("modelb-durable-adapter-012");
  const backend = inMemoryBackend();
  await prepareModelBPaymentDurably(backend.store, fx.payment);
  const record = await inspectDurableModelBPayment(
    backend.store,
    fx.claim.requestId
  );
  assert.equal(record?.phase, "PREPARED");
  assert.equal(backend.calls.reserve, 0);
});

test("real PostgreSQL: two separate clients receive only one durable reservation", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "Set AGENTVAULT_TEST_DATABASE_URL to enable real PostgreSQL concurrency test"
    );
    return;
  }
  const url = new URL(connectionString);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error(
      "REFUSE: isolated Model B test database must be local agentvault_test*"
    );
  }
  const { Pool } = await import("pg");
  const schema = `av76d2_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let migrations: InstanceType<typeof Pool> | undefined;
  let pool: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    const permission = await admin.query<{ can_set_role: boolean }>(
      "SELECT COALESCE(pg_catalog.pg_has_role(current_user, 'av_model_b_coordinator', 'SET'), false) AS can_set_role"
    );
    assert.equal(
      permission.rows[0].can_set_role,
      true,
      "Missing local test coordinator role membership"
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    migrations = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    for (const name of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await migrations.query(readFileSync(resolve("sql", name), "utf8"));
    }
    await migrations.end();
    migrations = undefined;
    pool = new Pool({
      connectionString,
      max: 2,
      options: `-c search_path=${schema}`,
    });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("SET ROLE av_model_b_coordinator");
      await second.query("SET ROLE av_model_b_coordinator");
      const storeA = new GuardedPostgresModelBPaymentStore(first, schema);
      const storeB = new GuardedPostgresModelBPaymentStore(second, schema);
      const fx = makeModelBPostgresFixture("modelb-durable-real-001");
      const prepared = await prepareModelBPaymentDurably(storeA, fx.payment);
      assert.equal(prepared.phase, "PREPARED");
      const outcomes = await Promise.allSettled([
        reserveOriginalModelBSubmissionOnce(storeA, fx.payment),
        reserveOriginalModelBSubmissionOnce(storeB, fx.payment),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
      const winner = outcomes.find((o) => o.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled")
        throw new Error("No reservation winner");
      assert.deepEqual(
        winner.value.signedTransaction,
        fx.payment.signedTransaction
      );
      assert.equal(
        (await inspectDurableModelBPayment(storeB, fx.claim.requestId))?.phase,
        "SUBMISSION_RESERVED"
      );
      await assert.rejects(
        reserveOriginalModelBSubmissionOnce(storeA, fx.payment),
        /SUBMISSION_LOCKED/
      );
    } finally {
      await first.query("RESET ROLE").catch(() => undefined);
      await second.query("RESET ROLE").catch(() => undefined);
      first.release();
      second.release();
    }
  } finally {
    if (pool) await pool.end();
    if (migrations) await migrations.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
