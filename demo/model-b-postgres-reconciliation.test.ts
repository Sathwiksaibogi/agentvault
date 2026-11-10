import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { reconcileModelBPayment } from "./model-b-postgres-reconciliation";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import {
  PostgresModelBPaymentStore,
  type ClaimModelBPayment,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > BigInt(0)) {
    out = B58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || "1";
}
function fixture(id = "modelb-finality-007"): ModelBPaymentRecord {
  const signer = Keypair.generate();
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })
  );
  tx.sign(signer);
  const signedTransaction = Buffer.from(tx.serialize());
  return {
    requestId: id,
    genesisHash: Keypair.generate().publicKey.toBase58(),
    programId: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    workflowDigest: "a".repeat(64),
    paymentDigest: "b".repeat(64),
    phase: "SUBMISSION_RESERVED",
    signedTransaction,
    signedTransactionSha256: createHash("sha256")
      .update(signedTransaction)
      .digest("hex"),
    signature: b58(tx.signature!),
    lastValidBlockHeight: 9000,
    finalizedSlot: null,
    finalityObservedAt: null,
  };
}

type RpcOptions = {
  status?: "processed" | "confirmed" | "finalized";
  err?: unknown | null;
  genesis?: string;
  slot?: number;
  fail?: boolean;
};
function rpcFor(record: ModelBPaymentRecord, options: RpcOptions = {}) {
  let calls = 0;
  const rpc: ModelBFinalityRpc = {
    async getGenesisHash() {
      calls++;
      return options.genesis ?? record.genesisHash;
    },
    async getSignatureStatuses() {
      calls++;
      if (options.fail) throw new Error("RPC unavailable");
      return {
        value: [
          {
            confirmationStatus: options.status ?? "finalized",
            slot: options.slot ?? 321,
            err: options.err ?? null,
          },
        ],
      };
    },
    async getTransaction() {
      calls++;
      return {
        slot: options.slot ?? 321,
        transaction: { signatures: [record.signature!] },
        meta: { err: options.err ?? null },
      };
    },
  };
  return {
    rpc,
    get calls() {
      return calls;
    },
  };
}

// In-memory atomic stand-in; SQL-level CAS and trigger are tested below with
// the dedicated optional PostgreSQL integration case.
class MemoryStore {
  current: ModelBPaymentRecord | null;
  writes = 0;
  onMiss?: () => void;
  constructor(record: ModelBPaymentRecord | null) {
    this.current = record;
  }
  async getForReconciliation(_requestId: string) {
    return this.current;
  }
  async applyInspectedStatus(
    expected: ModelBPaymentRecord,
    obs: {
      status: "CONFIRMED" | "FAILED" | "UNRESOLVED";
      requestId: string;
      signature: string;
      finalizedSlot?: number;
    }
  ) {
    this.writes++;
    if (this.onMiss) {
      this.onMiss();
      return null;
    }
    if (
      !this.current ||
      (this.current.phase !== "SUBMISSION_RESERVED" &&
        this.current.phase !== "UNRESOLVED") ||
      this.current.signature !== expected.signature
    )
      return null;
    this.current = {
      ...this.current,
      phase: obs.status,
      finalizedSlot: obs.finalizedSlot ?? null,
      finalityObservedAt: obs.finalizedSlot === undefined ? null : new Date(),
    };
    return this.current;
  }
}
const asStore = (store: MemoryStore): PostgresModelBPaymentStore =>
  store as unknown as PostgresModelBPaymentStore;

test("verified finalized success is persisted and an additional inspection is not needed", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  const rpc = rpcFor(initial);
  const result = await reconcileModelBPayment(
    initial.requestId,
    asStore(store),
    rpc.rpc
  );
  assert.equal(result.action, "UPDATED");
  assert.equal(result.record.phase, "CONFIRMED");
  assert.equal(result.record.finalizedSlot, 321);
  assert.equal(store.writes, 1);
  const later = rpcFor(initial, { fail: true });
  assert.equal(
    (await reconcileModelBPayment(initial.requestId, asStore(store), later.rpc))
      .action,
    "ALREADY_TERMINAL"
  );
  assert.equal(later.calls, 0);
});

test("verified finalized instruction error persists FAILED, never a retry", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  const err = { InstructionError: [2, { Custom: 23 }] };
  const result = await reconcileModelBPayment(
    initial.requestId,
    asStore(store),
    rpcFor(initial, { err }).rpc
  );
  assert.equal(result.record.phase, "FAILED");
  assert.equal(result.record.finalizedSlot, 321);
  assert.equal(store.writes, 1);
});

test("confirmed-only evidence becomes UNRESOLVED and never authorizes resubmission", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  const rpc = rpcFor(initial, { status: "confirmed" });
  assert.equal(
    (await reconcileModelBPayment(initial.requestId, asStore(store), rpc.rpc))
      .record.phase,
    "UNRESOLVED"
  );
  assert.equal(store.writes, 1);
  assert.equal(
    (await reconcileModelBPayment(initial.requestId, asStore(store), rpc.rpc))
      .action,
    "UNCHANGED"
  );
  assert.equal(store.writes, 1);
  assert.equal(
    (
      await reconcileModelBPayment(
        initial.requestId,
        asStore(store),
        rpcFor(initial).rpc
      )
    ).record.phase,
    "CONFIRMED"
  );
});

test("RPC error, wrong ledger, and corrupted saved bytes cause no database writes", async () => {
  for (const mode of ["rpc", "genesis", "corrupt"] as const) {
    const initial = fixture();
    if (mode === "corrupt") initial.signedTransactionSha256 = "0".repeat(64);
    const store = new MemoryStore(initial);
    const opts =
      mode === "rpc"
        ? { fail: true }
        : mode === "genesis"
        ? { genesis: Keypair.generate().publicKey.toBase58() }
        : {};
    await assert.rejects(
      reconcileModelBPayment(
        initial.requestId,
        asStore(store),
        rpcFor(initial, opts).rpc
      )
    );
    assert.equal(store.writes, 0);
    assert.equal(store.current?.phase, "SUBMISSION_RESERVED");
  }
});

test("missing and unsubmitted claims are rejected before RPC", async () => {
  const initial = fixture();
  const rpc = rpcFor(initial);
  await assert.rejects(
    reconcileModelBPayment(
      initial.requestId,
      asStore(new MemoryStore(null)),
      rpc.rpc
    ),
    /Unknown/
  );
  await assert.rejects(
    reconcileModelBPayment(
      initial.requestId,
      asStore(new MemoryStore({ ...initial, phase: "PREPARED" })),
      rpc.rpc
    ),
    /before submission/
  );
  assert.equal(rpc.calls, 0);
});

test("losing CAS to identical finality is idempotent and preserves original row", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  store.onMiss = () => {
    store.current = {
      ...initial,
      phase: "CONFIRMED",
      finalizedSlot: 321,
      finalityObservedAt: new Date(),
    };
  };
  const result = await reconcileModelBPayment(
    initial.requestId,
    asStore(store),
    rpcFor(initial).rpc
  );
  assert.equal(result.action, "ALREADY_TERMINAL");
  assert.equal(result.record.phase, "CONFIRMED");
});

test("losing CAS to contradictory terminal outcome or slot rejects without overwrite", async () => {
  for (const difference of ["phase", "slot"] as const) {
    const initial = fixture();
    const store = new MemoryStore(initial);
    store.onMiss = () => {
      store.current = {
        ...initial,
        phase: difference === "phase" ? "FAILED" : "CONFIRMED",
        finalizedSlot: difference === "slot" ? 322 : 321,
        finalityObservedAt: new Date(),
      };
    };
    await assert.rejects(
      reconcileModelBPayment(
        initial.requestId,
        asStore(store),
        rpcFor(initial).rpc
      ),
      /RECONCILIATION_CONFLICT/
    );
  }
});

test("CAS rejects a replacement payment identity, even for same request", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  store.onMiss = () => {
    store.current = {
      ...initial,
      workflowDigest: "c".repeat(64),
      phase: "CONFIRMED",
      finalizedSlot: 321,
      finalityObservedAt: new Date(),
    };
  };
  await assert.rejects(
    reconcileModelBPayment(
      initial.requestId,
      asStore(store),
      rpcFor(initial).rpc
    ),
    /immutable payment identity changed/
  );
});

test("unresolved CAS loses to terminal safely without downgrading", async () => {
  const initial = fixture();
  const store = new MemoryStore(initial);
  store.onMiss = () => {
    store.current = {
      ...initial,
      phase: "CONFIRMED",
      finalizedSlot: 321,
      finalityObservedAt: new Date(),
    };
  };
  const result = await reconcileModelBPayment(
    initial.requestId,
    asStore(store),
    rpcFor(initial, { status: "processed" }).rpc
  );
  assert.equal(result.action, "ALREADY_TERMINAL");
  assert.equal(result.record.phase, "CONFIRMED");
});

test("low-level finality CAS rejects forged request/signature/slot before SQL", async () => {
  const initial = fixture();
  let calls = 0;
  const store = new PostgresModelBPaymentStore({
    async query() {
      calls++;
      return { rowCount: 0, rows: [] };
    },
  } as never);
  for (const o of [
    {
      status: "CONFIRMED" as const,
      requestId: "otherrequest001",
      signature: initial.signature!,
      finalizedSlot: 12,
    },
    {
      status: "FAILED" as const,
      requestId: initial.requestId,
      signature: "fakesignature",
      finalizedSlot: 12,
    },
    {
      status: "CONFIRMED" as const,
      requestId: initial.requestId,
      signature: initial.signature!,
      finalizedSlot: -1,
    },
    {
      status: "UNRESOLVED" as const,
      requestId: initial.requestId,
      signature: initial.signature!,
      finalizedSlot: 1,
    },
  ])
    await assert.rejects(store.applyInspectedStatus(initial, o));
  assert.equal(calls, 0);
});

test("low-level CAS compares whole signed payment/approval identity and never writes without matching phase", async () => {
  const initial = fixture();
  const queries: string[] = [];
  const store = new PostgresModelBPaymentStore({
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    },
  } as never);
  const result = await store.applyInspectedStatus(initial, {
    status: "CONFIRMED",
    requestId: initial.requestId,
    signature: initial.signature!,
    finalizedSlot: 321,
  });
  assert.equal(result, null);
  assert.match(queries[0], /signed_tx_bytes = \$10/);
  assert.match(queries[0], /workflow_digest = \$5/);
  assert.match(queries[0], /payment_digest = \$6/);
  assert.match(queries[0], /phase = 'SUBMISSION_RESERVED'/);
  assert.match(queries[0], /phase = 'UNRESOLVED'/);
  assert.match(queries[0], /finalized_slot = \$12/);
});

/** Optional integration: disposable LOCAL database only; does not touch Devnet. */
test("real PostgreSQL: finality is monotonic and one CAS wins across concurrent clients", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "Set AGENTVAULT_TEST_DATABASE_URL for dedicated localhost test database"
    );
    return;
  }
  const url = new URL(connectionString);
  if (
    !(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      /^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
    )
  ) {
    throw new Error("REFUSE: must use local agentvault_test* database");
  }
  const { Pool } = await import("pg");
  const schema = `av76c5_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let pool2: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString,
      max: 6,
      options: `-c search_path=${schema}`,
    });
    pool2 = new Pool({
      connectionString,
      max: 6,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      readFileSync(resolve("sql/20261110_model_b_payment_requests.sql"), "utf8")
    );
    await pool.query(
      readFileSync(resolve("sql/20261110_model_b_payment_finality.sql"), "utf8")
    );
    const store = new PostgresModelBPaymentStore(pool);
    const secondStore = new PostgresModelBPaymentStore(pool2);
    const originalVerified = makeModelBPostgresFixture(
      "modelb-7c5-database001"
    );
    const original = originalVerified.record;
    const claim: ClaimModelBPayment = originalVerified.claim;
    await store.claim(claim);
    await store.persistSignedPayment(originalVerified.payment);
    await store.reserveOneSubmission(claim.requestId);
    const rpc = rpcFor(original).rpc;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reconcileModelBPayment(
          claim.requestId,
          i % 2 === 0 ? store : secondStore,
          rpc
        )
      )
    );
    assert.equal(results.filter((r) => r.action === "UPDATED").length, 1);
    assert.equal(
      results.every((r) => r.record.phase === "CONFIRMED"),
      true
    );
    const persisted = await store.getForReconciliation(claim.requestId);
    assert.equal(persisted?.finalizedSlot, 321);
    assert.ok(persisted?.finalityObservedAt instanceof Date);
    assert.deepEqual(persisted?.signedTransaction, original.signedTransaction);
    assert.equal(persisted?.workflowDigest, original.workflowDigest);

    await assert.rejects(
      pool.query(
        `UPDATE agentvault_model_b_payment_requests SET phase = 'FAILED', finalized_slot = 322
       WHERE request_id = $1`,
        [claim.requestId]
      ),
      /forbidden|immutable|check constraint/
    );
    await assert.rejects(
      pool.query(
        `UPDATE agentvault_model_b_payment_requests SET finalized_slot = 322
       WHERE request_id = $1`,
        [claim.requestId]
      ),
      /immutable|forbidden/
    );
    await assert.rejects(
      store.recordChainStatus(claim.requestId, original.signature!, "FAILED")
    );
    await assert.rejects(store.reserveOneSubmission(claim.requestId));

    // A second request with no finalized evidence may only become UNRESOLVED.
    const nextVerified = makeModelBPostgresFixture("modelb-7c5-database002");
    const next = nextVerified.record;
    await store.claim(nextVerified.claim);
    await store.persistSignedPayment(nextVerified.payment);
    await store.reserveOneSubmission(next.requestId);
    assert.equal(
      (
        await reconcileModelBPayment(
          next.requestId,
          store,
          rpcFor(next, { status: "confirmed" }).rpc
        )
      ).record.phase,
      "UNRESOLVED"
    );
    assert.equal(
      (await store.getForReconciliation(next.requestId))?.finalizedSlot,
      null
    );
    assert.equal(
      (
        await reconcileModelBPayment(
          next.requestId,
          store,
          rpcFor(next, { err: { InstructionError: [0, "InvalidArgument"] } })
            .rpc
        )
      ).record.phase,
      "FAILED"
    );
    assert.equal(
      (await store.getForReconciliation(next.requestId))?.finalizedSlot,
      321
    );

    // The deprecated primitive cannot synthesize finalized evidence on the
    // upgraded schema: a fresh reserved request still lacks finalized slot.
    const thirdVerified = makeModelBPostgresFixture("modelb-7c5-database003");
    const third = thirdVerified.record;
    await store.claim(thirdVerified.claim);
    await store.persistSignedPayment(thirdVerified.payment);
    await store.reserveOneSubmission(third.requestId);
    await assert.rejects(
      store.recordChainStatus(third.requestId, third.signature!, "CONFIRMED"),
      /invalid finalized payment evidence/
    );
    assert.equal(
      (await store.getForReconciliation(third.requestId))?.phase,
      "SUBMISSION_RESERVED"
    );
  } finally {
    if (pool) await pool.end();
    if (pool2) await pool2.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
