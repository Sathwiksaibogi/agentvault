import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  PostgresModelBPaymentStore,
  validatePaymentClaim,
  validateSignedPayment,
  type ClaimModelBPayment,
} from "./model-b-postgres-payment-store";

function claim(id = "modelb-durable-001"): ClaimModelBPayment {
  const key = () => Keypair.generate().publicKey.toBase58();
  return {
    requestId: id,
    genesisHash: key(),
    programId: key(),
    vault: key(),
    workflowDigest: "a".repeat(64),
    paymentDigest: "b".repeat(64),
  };
}

function signedPayment(requestId = "modelb-durable-001") {
  const signer = Keypair.generate();
  const recipient = Keypair.generate();
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    })
  );
  tx.sign(signer);
  // Derive the base58 signature using the already-present web3.js public-key
  // library's own transaction format instead of installing a new dependency.
  // The store validates that the declared signature equals the embedded bytes.
  const bytes = tx.serialize();
  return {
    requestId,
    signedTransaction: bytes,
    signatureBytes: tx.signature!,
    lastValidBlockHeight: 9000,
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encode58(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > BigInt(0)) {
    out = BASE58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const c of bytes) {
    if (c !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function payment() {
  const signed = signedPayment();
  return {
    requestId: signed.requestId,
    signedTransaction: signed.signedTransaction,
    signature: encode58(signed.signatureBytes),
    lastValidBlockHeight: signed.lastValidBlockHeight,
  };
}

test("validates canonical claim IDs, keys and SHA-256 digests", () => {
  const valid = claim();
  assert.doesNotThrow(() => validatePaymentClaim(valid));
  assert.throws(
    () => validatePaymentClaim({ ...valid, requestId: "../journal" }),
    /request ID/
  );
  assert.throws(
    () => validatePaymentClaim({ ...valid, vault: "not-pubkey" }),
    /vault/
  );
  assert.throws(
    () => validatePaymentClaim({ ...valid, workflowDigest: "A".repeat(64) }),
    /digest/
  );
  assert.throws(
    () => validatePaymentClaim({ ...valid, paymentDigest: "01" }),
    /digest/
  );
});

test("accepts only a fully signed legacy transaction matching its signature", () => {
  const p = payment();
  const result = validateSignedPayment(p);
  assert.deepEqual(result.bytes, p.signedTransaction);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => validateSignedPayment({ ...p, signature: "wrong" }),
    /signature/
  );
  assert.throws(
    () =>
      validateSignedPayment({
        ...p,
        signedTransaction: Buffer.from([1, 2, 3]),
      }),
    /serialized/
  );
  assert.throws(
    () => validateSignedPayment({ ...p, lastValidBlockHeight: -1 }),
    /block height/
  );
});

test("changing serialized transaction contents is rejected, not silently re-signed", () => {
  const p = payment();
  const bytes = Buffer.from(p.signedTransaction);
  bytes[bytes.length - 1] ^= 1;
  assert.throws(
    () => validateSignedPayment({ ...p, signedTransaction: bytes }),
    /signature|serialized/
  );
});

test("claims and submission reservations use atomic PostgreSQL conflict/CAS predicates", async () => {
  const queries: string[] = [];
  const fake = {
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    },
  };
  const store = new PostgresModelBPaymentStore(fake as never);
  await assert.rejects(store.claim(claim()), /already transitioned/);
  await assert.rejects(
    store.reserveOneSubmission("modelb-durable-001"),
    /already transitioned/
  );
  assert.match(queries[0], /ON CONFLICT \(request_id\) DO NOTHING/);
  assert.match(queries[1], /phase = 'PREPARED'/);
});

test("a missing signed-payment claim cannot produce a submission permit", async () => {
  const fake = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };
  const store = new PostgresModelBPaymentStore(fake as never);
  await assert.rejects(
    store.persistSignedPayment(payment()),
    /already transitioned/
  );
  await assert.rejects(
    store.reserveOneSubmission("modelb-durable-001"),
    /already transitioned/
  );
});

test("invalid request IDs fail before touching PostgreSQL", async () => {
  let calls = 0;
  const fake = {
    async query() {
      calls++;
      throw Error("DB must not be contacted");
    },
  };
  const store = new PostgresModelBPaymentStore(fake as never);
  await assert.rejects(store.get("../escape"), /request ID/);
  await assert.rejects(store.reserveOneSubmission("../escape"), /request ID/);
  assert.equal(calls, 0);
});

test("a chain status can only be recorded after an existing, signature-bound submission", async () => {
  const queries: string[] = [];
  const fake = {
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    },
  };
  const store = new PostgresModelBPaymentStore(fake as never);
  await assert.rejects(
    store.recordChainStatus("modelb-durable-001", "sig", "CONFIRMED"),
    /already transitioned/
  );
  assert.match(queries[0], /tx_signature = \$2/);
  assert.match(queries[0], /phase = 'SUBMISSION_RESERVED'/);
});

/**
 * Real-PostgreSQL tests are OPT-IN and must use a disposable localhost database
 * whose name starts with agentvault_test. The test creates/drops its own schema.
 * Without this opt-in the normal 570-test suite stays offline and unchanged.
 */
test("real PostgreSQL: one claim and one submission permit across concurrent clients", async (t) => {
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
    throw Error("REFUSE: must use a local database named agentvault_test*");
  }

  const { Pool } = await import("pg");
  const schema = `av76c2_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let createdSchema = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    pool = new Pool({
      connectionString,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const migration = readFileSync(
      resolve("sql/20261110_model_b_payment_requests.sql"),
      "utf8"
    );
    await pool.query(migration);
    const store = new PostgresModelBPaymentStore(pool);
    const input = claim();
    const claimResults = await Promise.allSettled(
      Array.from({ length: 12 }, () => store.claim(input))
    );
    assert.equal(
      claimResults.filter((r) => r.status === "fulfilled").length,
      1
    );
    assert.equal((await store.get(input.requestId))?.phase, "CLAIMED");

    const p = payment();
    const prepared = await store.persistSignedPayment(p);
    assert.equal(prepared.phase, "PREPARED");
    assert.deepEqual(prepared.signedTransaction, p.signedTransaction);
    await assert.rejects(store.persistSignedPayment(p), /already transitioned/);

    const reservationResults = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        store.reserveOneSubmission(input.requestId)
      )
    );
    assert.equal(
      reservationResults.filter((r) => r.status === "fulfilled").length,
      1
    );
    await assert.rejects(
      store.reserveOneSubmission(input.requestId),
      /already transitioned/
    );
    assert.equal(
      (await store.get(input.requestId))?.phase,
      "SUBMISSION_RESERVED"
    );

    // Even a direct DB query may not overwrite previously persisted signed bytes.
    await assert.rejects(
      pool.query(
        `UPDATE agentvault_model_b_payment_requests SET signed_tx_bytes = $2
         WHERE request_id = $1`,
        [input.requestId, Buffer.from([2, 3, 4])]
      ),
      /immutable/
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM agentvault_model_b_payment_requests WHERE request_id = $1`,
        [input.requestId]
      ),
      /cannot be deleted/
    );

    const unresolved = await store.recordChainStatus(
      input.requestId,
      p.signature,
      "UNRESOLVED"
    );
    assert.equal(unresolved.phase, "UNRESOLVED");
    await assert.rejects(
      store.reserveOneSubmission(input.requestId),
      /already transitioned/
    );
    const confirmed = await store.recordChainStatus(
      input.requestId,
      p.signature,
      "CONFIRMED"
    );
    assert.equal(confirmed.phase, "CONFIRMED");
    await assert.rejects(
      store.recordChainStatus(input.requestId, p.signature, "FAILED"),
      /already transitioned/
    );
    assert.deepEqual(
      (await store.get(input.requestId))?.signedTransaction,
      p.signedTransaction
    );
  } finally {
    if (pool) await pool.end();
    if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
