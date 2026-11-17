import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import type { PoolClient } from "pg";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import {
  createInactiveModelBFinalizerRuntime,
  type TrustedModelBFinalizer,
} from "./model-b-postgres-inactive-finalizer";
import {
  GuardedPostgresModelBPaymentStore,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";

const randomKey = () => Keypair.generate().publicKey.toBase58();

type RpcOverrides = {
  finality?: "processed" | "confirmed" | "finalized";
  statusErr?: unknown | null;
  transactionErr?: unknown | null;
  receiptSlot?: number;
  genesisOverride?: string;
  afterGenesisOverride?: string;
  rpcFailure?: boolean;
};
function fixture(id = "modelb-finalizer-001", overrides: RpcOverrides = {}) {
  const fx = makeModelBPostgresFixture(id);
  const calls: string[] = [];
  let genesisCalls = 0;
  const rpc: ModelBFinalityRpc = {
    async getGenesisHash() {
      calls.push("genesis");
      genesisCalls++;
      return genesisCalls === 1
        ? overrides.genesisOverride ?? fx.claim.genesisHash
        : overrides.afterGenesisOverride ?? fx.claim.genesisHash;
    },
    async getSignatureStatuses() {
      calls.push("status");
      if (overrides.rpcFailure) throw new Error("RPC unavailable");
      return {
        value: [
          {
            confirmationStatus: overrides.finality ?? "finalized",
            slot: 321,
            err: overrides.statusErr === undefined ? null : overrides.statusErr,
          },
        ],
      };
    },
    async getTransaction() {
      calls.push("receipt");
      return {
        slot: overrides.receiptSlot ?? 321,
        transaction: { signatures: [fx.payment.signature] },
        meta: {
          err:
            overrides.transactionErr === undefined
              ? overrides.statusErr === undefined
                ? null
                : overrides.statusErr
              : overrides.transactionErr,
        },
      };
    },
  };
  const deployment: TrustedModelBFinalizer = {
    genesisHash: fx.claim.genesisHash,
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: fx.claim.vault,
    rpc,
  };
  return { ...fx, deployment, calls };
}

class MemoryFinalizer {
  record: ModelBPaymentRecord | null;
  writes = 0;
  reads = 0;
  onCas?: (
    record: ModelBPaymentRecord,
    status: "UNRESOLVED" | "CONFIRMED" | "FAILED",
    slot: number | undefined
  ) => void;
  constructor(record: ModelBPaymentRecord | null) {
    this.record = record;
  }
  async getForReconciliation(_requestId: string) {
    this.reads++;
    return this.record;
  }
  async applyInspectedStatus(
    before: ModelBPaymentRecord,
    observation: {
      status: "UNRESOLVED" | "CONFIRMED" | "FAILED";
      requestId: string;
      signature: string;
      finalizedSlot?: number;
    }
  ) {
    this.writes++;
    if (this.onCas)
      this.onCas(before, observation.status, observation.finalizedSlot);
    if (
      !this.record ||
      this.record.phase !== before.phase ||
      this.record.requestId !== before.requestId ||
      this.record.signature !== before.signature ||
      !this.record.signedTransaction?.equals(before.signedTransaction!)
    )
      return null;
    this.record = {
      ...this.record,
      phase: observation.status,
      finalizedSlot: observation.finalizedSlot ?? null,
      finalityObservedAt:
        observation.finalizedSlot === undefined ? null : new Date(),
    };
    return this.record;
  }
}

test("finalizer exposes only inspect and reconcile, never signing, reservation or broadcast", () => {
  const fx = fixture();
  const runtime = createInactiveModelBFinalizerRuntime(
    new MemoryFinalizer(fx.record),
    fx.deployment
  );
  assert.deepEqual(Object.keys(runtime).sort(), ["inspect", "reconcile"]);
  for (const forbidden of [
    "claim",
    "prepare",
    "reserveOneSubmission",
    "send",
    "broadcast",
    "getRawSql",
  ]) {
    assert.equal(forbidden in runtime, false);
  }
  const cli = readFileSync(
    resolve("demo/execute-ai-workflow-model-b.ts"),
    "utf8"
  );
  const server = readFileSync(resolve("demo/api-server.ts"), "utf8");
  assert.doesNotMatch(cli, /model-b-postgres-inactive-finalizer/);
  assert.doesNotMatch(server, /model-b-postgres-inactive-finalizer/);
});

test("finalizer requires deployment-pinned genesis, program, vault and read-only RPC", () => {
  const fx = fixture();
  for (const wrong of [
    { genesisHash: "invalid" },
    { programId: randomKey() },
    { vault: "invalid" },
    { rpc: undefined },
    { rpc: { getGenesisHash: () => fx.claim.genesisHash } },
  ]) {
    assert.throws(
      () =>
        createInactiveModelBFinalizerRuntime(new MemoryFinalizer(fx.record), {
          ...fx.deployment,
          ...wrong,
        } as never),
      /invalid trusted deployment configuration/
    );
  }
});

test("verified finalized success produces one guarded write and a metadata-only result", async () => {
  const fx = fixture();
  const store = new MemoryFinalizer(fx.record);
  const result = await createInactiveModelBFinalizerRuntime(
    store,
    fx.deployment
  ).reconcile(fx.claim.requestId);
  assert.equal(result.action, "UPDATED");
  assert.equal(result.phase, "CONFIRMED");
  assert.equal(result.finalizedSlot, 321);
  assert.equal(store.writes, 1);
  assert.deepEqual(fx.calls, ["genesis", "status", "receipt", "genesis"]);
  assert.deepEqual(
    [
      result.canReserveSubmission,
      result.canBroadcast,
      result.canRetryPreparation,
    ],
    [false, false, false]
  );
  assert.equal("signedTransaction" in result, false);
});

test("matching finalized on-chain instruction error produces terminal FAILED, never another payment", async () => {
  const err = { InstructionError: [1, { Custom: 15 }] };
  const fx = fixture("modelb-finalizer-002", { statusErr: err });
  const store = new MemoryFinalizer(fx.record);
  const result = await createInactiveModelBFinalizerRuntime(
    store,
    fx.deployment
  ).reconcile(fx.claim.requestId);
  assert.equal(result.phase, "FAILED");
  assert.equal(result.finalizedSlot, 321);
  assert.equal(store.writes, 1);
});

test("confirmed-only evidence remains unresolved, then finalized on a later inspection", async () => {
  const fx = fixture("modelb-finalizer-003", { finality: "confirmed" });
  const store = new MemoryFinalizer(fx.record);
  const first = await createInactiveModelBFinalizerRuntime(
    store,
    fx.deployment
  ).reconcile(fx.claim.requestId);
  assert.equal(first.phase, "UNRESOLVED");
  assert.equal(first.finalizedSlot, null);
  // Keep the *same original signed payment* and only change the RPC result.
  const finalRpc: ModelBFinalityRpc = {
    ...fx.deployment.rpc,
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "finalized", slot: 321, err: null }],
    }),
  };
  const second = await createInactiveModelBFinalizerRuntime(store, {
    ...fx.deployment,
    rpc: finalRpc,
  }).reconcile(fx.claim.requestId);
  assert.equal(second.phase, "CONFIRMED");
  assert.equal(store.writes, 2);
});

test("RPC failure leaves reserved request unchanged and never writes", async () => {
  const fx = fixture("modelb-finalizer-004", { rpcFailure: true });
  const store = new MemoryFinalizer(fx.record);
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /RPC unavailable/
  );
  assert.equal(store.record?.phase, "SUBMISSION_RESERVED");
  assert.equal(store.writes, 0);
});

test("RPC on a different genesis is refused before any status read or mutation", async () => {
  const fx = fixture("modelb-finalizer-005", { genesisOverride: randomKey() });
  const store = new MemoryFinalizer(fx.record);
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /genesis differs/
  );
  assert.deepEqual(fx.calls, ["genesis"]);
  assert.equal(store.writes, 0);
});

test("RPC ledger switch after a finalized receipt is refused without SQL mutation", async () => {
  const fx = fixture("modelb-finalizer-006", {
    afterGenesisOverride: randomKey(),
  });
  const store = new MemoryFinalizer(fx.record);
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /genesis changed/
  );
  assert.equal(store.writes, 0);
});

test("contradictory finalized receipt stays UNRESOLVED rather than falsely settling", async () => {
  const fx = fixture("modelb-finalizer-007", { receiptSlot: 999 });
  const store = new MemoryFinalizer(fx.record);
  assert.equal(
    (
      await createInactiveModelBFinalizerRuntime(
        store,
        fx.deployment
      ).reconcile(fx.claim.requestId)
    ).phase,
    "UNRESOLVED"
  );
  assert.equal(store.writes, 1);
});

test("corrupted stored transaction fails before accessing RPC or mutating database", async () => {
  const fx = fixture("modelb-finalizer-008");
  const store = new MemoryFinalizer({
    ...fx.record,
    signedTransactionSha256: "0".repeat(64),
  });
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /digest differs|digest mismatch/
  );
  assert.equal(store.writes, 0);
  assert.deepEqual(fx.calls, []);
});

test("CLAIMED and PREPARED payments cannot be finalized before submission reservation", async () => {
  for (const phase of ["CLAIMED", "PREPARED"] as const) {
    const fx = fixture(`modelb-finalizer-${phase.toLowerCase()}001`);
    const record: ModelBPaymentRecord =
      phase === "CLAIMED"
        ? {
            ...fx.record,
            phase,
            signedTransaction: null,
            signature: null,
            signedTransactionSha256: null,
            lastValidBlockHeight: null,
          }
        : { ...fx.record, phase };
    const store = new MemoryFinalizer(record);
    await assert.rejects(
      createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
        fx.claim.requestId
      ),
      /no submission reservation/
    );
    assert.equal(store.writes, 0);
    assert.deepEqual(fx.calls, []);
  }
});

test("already-terminal requests never contact RPC or change finality", async () => {
  const fx = fixture("modelb-finalizer-009", { rpcFailure: true });
  const store = new MemoryFinalizer({
    ...fx.record,
    phase: "CONFIRMED",
    finalizedSlot: 321,
  });
  const result = await createInactiveModelBFinalizerRuntime(
    store,
    fx.deployment
  ).reconcile(fx.claim.requestId);
  assert.equal(result.action, "ALREADY_TERMINAL");
  assert.equal(store.writes, 0);
  assert.deepEqual(fx.calls, []);
});

test("a competing identical CAS outcome is accepted without an additional write", async () => {
  const fx = fixture("modelb-finalizer-010");
  const store = new MemoryFinalizer(fx.record);
  store.onCas = (_before, _status, slot) => {
    store.record = {
      ...store.record!,
      phase: "CONFIRMED",
      finalizedSlot: slot ?? null,
    };
    store.onCas = undefined;
  };
  const result = await createInactiveModelBFinalizerRuntime(
    store,
    fx.deployment
  ).reconcile(fx.claim.requestId);
  assert.equal(result.action, "ALREADY_TERMINAL");
  assert.equal(store.writes, 1);
});

test("a conflicting terminal result from a competing finalizer is rejected", async () => {
  const fx = fixture("modelb-finalizer-011");
  const store = new MemoryFinalizer(fx.record);
  store.onCas = () => {
    store.record = { ...store.record!, phase: "FAILED", finalizedSlot: 321 };
    store.onCas = undefined;
  };
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /RECONCILIATION_CONFLICT/
  );
  assert.equal(store.record?.phase, "FAILED");
});

test("stored identity is pinned on every read; substituted vault cannot reach finality write", async () => {
  const fx = fixture("modelb-finalizer-012");
  const store = new MemoryFinalizer(fx.record);
  // Initial read succeeds; a later re-read returns a different vault.
  const original = store.getForReconciliation.bind(store);
  store.getForReconciliation = async (id: string) => {
    const row = await original(id);
    if (store.reads >= 2 && row) return { ...row, vault: randomKey() };
    return row;
  };
  await assert.rejects(
    createInactiveModelBFinalizerRuntime(store, fx.deployment).reconcile(
      fx.claim.requestId
    ),
    /outside pinned deployment/
  );
  assert.equal(store.writes, 0);
  assert.deepEqual(fx.calls, []);
});

test("read-only finality inspection never returns signed transaction bytes or mutates SQL", async () => {
  const fx = fixture("modelb-finalizer-013");
  const store = new MemoryFinalizer(fx.record);
  const runtime = createInactiveModelBFinalizerRuntime(store, fx.deployment);
  const snapshot = await runtime.inspect(fx.claim.requestId);
  assert.equal(snapshot.phase, "SUBMISSION_RESERVED");
  assert.equal(snapshot.nextAction, "INSPECT_FINALITY");
  assert.equal("signedTransaction" in snapshot, false);
  assert.equal(snapshot.canBroadcast, false);
  assert.equal(store.writes, 0);
  assert.deepEqual(fx.calls, []);
});

test("unknown request cannot be reconstructed, claimed or submitted by the finalizer", async () => {
  const fx = fixture("modelb-finalizer-014");
  const store = new MemoryFinalizer(null);
  const runtime = createInactiveModelBFinalizerRuntime(store, fx.deployment);
  await assert.rejects(
    runtime.reconcile(fx.claim.requestId),
    /Unknown Model B payment request/
  );
  assert.equal((await runtime.inspect(fx.claim.requestId)).phase, "NOT_FOUND");
  assert.equal(store.writes, 0);
});

/**
 * Real, disposable, local-PostgreSQL regression using the already provisioned
 * NOLOGIN test roles. Does not require or silently create a runtime LOGIN;
 * production-style credentials are covered separately by the D.1 preflight.
 */
test("real PostgreSQL: guarded finalizer settles verified finality but cannot claim or reserve", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("Set AGENTVAULT_TEST_DATABASE_URL for local finalizer integration");
    return;
  }
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error(
      "REFUSE: finalizer test needs a local agentvault_test* database"
    );
  }
  const { Pool } = await import("pg");
  const schema = `av76d5_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let client: PoolClient | undefined;
  let created = false;
  try {
    const roles = await admin.query<{ allowed: boolean }>(`SELECT
      pg_catalog.to_regrole('av_model_b_coordinator') IS NOT NULL
      AND pg_catalog.to_regrole('av_model_b_finalizer') IS NOT NULL
      AND pg_catalog.pg_has_role(session_user, 'av_model_b_coordinator', 'SET')
      AND pg_catalog.pg_has_role(session_user, 'av_model_b_finalizer', 'SET') AS allowed`);
    assert.equal(
      roles.rows[0]?.allowed,
      true,
      "Missing test-only coordinator/finalizer memberships"
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    for (const migration of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ])
      await pool.query(readFileSync(resolve("sql", migration), "utf8"));
    client = await pool.connect();
    await client.query("BEGIN");
    const fx = fixture("modelb-finalizer-real001");
    const store = new GuardedPostgresModelBPaymentStore(client, schema);
    await client.query("SET LOCAL ROLE av_model_b_coordinator");
    await store.claim(fx.claim);
    await store.persistSignedPayment(fx.payment);
    await store.reserveOneSubmission(fx.claim.requestId);
    await client.query("SET LOCAL ROLE av_model_b_finalizer");
    const result = await createInactiveModelBFinalizerRuntime(
      store,
      fx.deployment
    ).reconcile(fx.claim.requestId);
    assert.equal(result.phase, "CONFIRMED");
    assert.equal(result.finalizedSlot, 321);
    await assert.rejects(
      store.reserveOneSubmission(fx.claim.requestId),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "42501");
        return true;
      }
    );
    // SQL denial makes transaction aborted; ROLLBACK in finally discards data.
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
