/**
 * 7.6D.9: TEST-ONLY SQL authentication boundary against a stolen finalizer login.
 * This uses synthetic witnesses/chain evidence; it does NOT prove Solana finality.
 * Creates and removes a disposable schema inside a local agentvault_test* DB.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  encodeModelBFinalityAttestation,
  signModelBFinalityAttestation,
  type AttestedPaymentIdentity,
} from "./model-b-finality-attestation-codec";

const sql = (name: string): string =>
  readFileSync(resolve("sql", name), "utf8");
const gate = sql("20261111_model_b_attested_finality_gate.sql");
const quarantine = sql("20261111_model_b_finality_quarantine.sql");
const guidance = readFileSync(
  resolve("docs/security/model-b-postgres-attested-finality.md"),
  "utf8"
);

function localTestUrl(raw: string, expectedUser?: string): URL {
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname) ||
    !url.password ||
    url.search ||
    url.hash ||
    (expectedUser !== undefined &&
      decodeURIComponent(url.username) !== expectedUser)
  ) {
    throw new Error(
      "REFUSE: only an isolated local AgentVault PostgreSQL test database is permitted"
    );
  }
  return url;
}

const identity: AttestedPaymentIdentity = {
  requestId: "attested-finality-001",
  genesisHash: "11111111111111111111111111111111",
  programId: "11111111111111111111111111111111",
  vault: "11111111111111111111111111111111",
  workflowDigest: "a".repeat(64),
  paymentDigest: "b".repeat(64),
  signedTransactionSha256: "c".repeat(64),
  signature: "TestSignatureOnly",
  lastValidBlockHeight: 9999,
};

test("attestation encoding binds full payment identity, ledger, status and slot", () => {
  const baseline = encodeModelBFinalityAttestation(identity, "CONFIRMED", 120);
  assert.match(
    baseline.toString("utf8"),
    /^AgentVault\/ModelB\/finality-attestation\/v1\|/
  );
  assert.notDeepEqual(
    baseline,
    encodeModelBFinalityAttestation(identity, "FAILED", 120)
  );
  assert.notDeepEqual(
    baseline,
    encodeModelBFinalityAttestation(identity, "CONFIRMED", 121)
  );
  for (const key of [
    "requestId",
    "genesisHash",
    "programId",
    "vault",
    "workflowDigest",
    "paymentDigest",
    "signedTransactionSha256",
    "signature",
    "lastValidBlockHeight",
  ] as const) {
    const modified = {
      ...identity,
      [key]: key === "lastValidBlockHeight" ? 10000 : "changed",
    };
    assert.notDeepEqual(
      baseline,
      encodeModelBFinalityAttestation(modified, "CONFIRMED", 120),
      key
    );
  }
  assert.throws(() =>
    encodeModelBFinalityAttestation(identity, "CONFIRMED", -1)
  );
  assert.throws(() =>
    encodeModelBFinalityAttestation(
      identity,
      "CONFIRMED",
      Number.MAX_SAFE_INTEGER + 1
    )
  );
});

test("distinct witness MACs are mandatory; keys never appear in code or migration", () => {
  const payload = encodeModelBFinalityAttestation(identity, "CONFIRMED", 120);
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  assert.notEqual(
    signModelBFinalityAttestation(a, payload),
    signModelBFinalityAttestation(b, payload)
  );
  assert.throws(() => signModelBFinalityAttestation(Buffer.alloc(12), payload));
  assert.match(gate, /secret_a = secret_b/);
  assert.match(gate, /agentvault_model_b_evidence_keys/);
  assert.match(gate, /pgcrypto\.hmac|pgcrypto\.hmac|\.hmac\(/i);
  assert.doesNotMatch(
    gate,
    /INSERT INTO[\s\S]*agentvault_model_b_evidence_keys/
  );
});

test("SQL installer requires quarantine, dedicated database and restricted finalizer-only function", () => {
  assert.match(gate, /current_database\(\) !~ '\^agentvault_test/);
  assert.match(gate, /D\.8 finality quarantine is not installed/);
  assert.match(gate, /CURRENT_USER::pg_catalog.regrole::oid/);
  assert.match(gate, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(gate, /GRANT EXECUTE ON FUNCTION[\s\S]*TO av_model_b_finalizer/);
  assert.match(gate, /REVOKE ALL ON TABLE[\s\S]*evidence_keys/);
  assert.match(gate, /phase IN \('SUBMISSION_RESERVED','UNRESOLVED'\)/);
  assert.match(gate, /signed_tx_sha256/);
  assert.doesNotMatch(gate, /\b(?:sendRawTransaction|signTransaction)\b/);
});

test("documentation preserves the unresolved Solana evidence and DBA trust assumptions", () => {
  assert.match(
    guidance,
    /not (a|an) (cryptographic )?proof of Solana finality/i
  );
  assert.match(guidance, /two independent/i);
  assert.match(guidance, /test-only/i);
  assert.match(guidance, /DBA/i);
  assert.match(guidance, /no live broadcast/i);
});

test("real PostgreSQL: finalizer cannot forge a terminal outcome without two distinct witness MACs", async (t) => {
  const rootUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;
  const finalizerUrl = process.env.AGENTVAULT_MODEL_B_TEST_FINALIZER_URL;
  if (!rootUrl && !finalizerUrl) {
    t.skip(
      "Configure both the owner and isolated finalizer URLs for the dedicated local test DB"
    );
    return;
  }
  if (!rootUrl || !finalizerUrl) {
    throw new Error(
      "REFUSE: both test owner and isolated finalizer URLs required"
    );
  }
  const root = localTestUrl(rootUrl);
  const finalizer = localTestUrl(finalizerUrl, "av76d6_finalizer_test");
  assert.equal(root.pathname, finalizer.pathname);

  const schema = `av76d9_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: rootUrl, max: 1 });
  let owner: Pool | undefined;
  let service: Pool | undefined;
  let created = false;
  try {
    assert.equal(
      (
        await admin.query<{ permitted: boolean }>(
          "SELECT has_database_privilege(current_user,current_database(),'CREATE') AS permitted"
        )
      ).rows[0]?.permitted,
      true
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    owner = new Pool({
      connectionString: rootUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    service = new Pool({
      connectionString: finalizerUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });

    const installed = await admin.query(
      "SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto'"
    );
    if (installed.rowCount === 0) {
      // Only if absent: install into this disposable test schema and DROP it
      // with the schema afterwards. Never modify the live/application schema.
      await admin.query(`CREATE EXTENSION pgcrypto WITH SCHEMA "${schema}"`);
    }
    for (const migration of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ])
      await owner.query(sql(migration));
    await owner.query(sql("20261111_model_b_privilege_audit.sql"));
    await owner.query(quarantine);
    await owner.query(gate);

    assert.equal(
      (
        await service.query<{ login: string }>(
          "SELECT current_user::text AS login"
        )
      ).rows[0]?.login,
      "av76d6_finalizer_test"
    );

    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const keys = `"${schema}".agentvault_model_b_evidence_keys`;
    await owner.query(
      `INSERT INTO ${keys}(witness_id,shared_secret) VALUES ($1,$2),($3,$4)`,
      ["observer_a", keyA, "observer_b", keyB]
    );
    await assert.rejects(
      service.query(`SELECT shared_secret FROM ${keys}`),
      (err: unknown) => (err as { code?: string }).code === "42501"
    );
    await assert.rejects(
      service.query(`UPDATE ${keys} SET shared_secret=$1`, [randomBytes(32)]),
      (err: unknown) => (err as { code?: string }).code === "42501"
    );

    const claimFn = `"${schema}".agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`;
    const prepareFn = `"${schema}".agentvault_model_b_prepare_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
    const reserveFn = `"${schema}".agentvault_model_b_reserve_guarded($1)`;
    const legacyFn = `"${schema}".agentvault_model_b_reconcile_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
    const gateFn = `"${schema}".agentvault_model_b_attested_finality_guarded($1,$2,$3,$4,$5)`;
    const idBase: AttestedPaymentIdentity = { ...identity };

    async function preparePayment(
      requestId: string,
      bytes: Buffer,
      signature: string
    ): Promise<AttestedPaymentIdentity> {
      const payment = {
        ...idBase,
        requestId,
        signedTransactionSha256: createHash("sha256")
          .update(bytes)
          .digest("hex"),
        signature,
      };
      const claim = [
        payment.requestId,
        payment.genesisHash,
        payment.programId,
        payment.vault,
        payment.workflowDigest,
        payment.paymentDigest,
      ];
      assert.equal(
        (await owner!.query(`SELECT phase FROM ${claimFn}`, claim)).rows[0]
          ?.phase,
        "CLAIMED"
      );
      assert.equal(
        (
          await owner!.query(`SELECT phase FROM ${prepareFn}`, [
            requestId,
            bytes,
            payment.signedTransactionSha256,
            signature,
            payment.lastValidBlockHeight,
            ...claim.slice(1),
          ])
        ).rows[0]?.phase,
        "PREPARED"
      );
      assert.equal(
        (await owner!.query(`SELECT phase FROM ${reserveFn}`, [requestId]))
          .rows[0]?.phase,
        "SUBMISSION_RESERVED"
      );
      return payment;
    }
    function attest(
      payment: AttestedPaymentIdentity,
      outcome: "CONFIRMED" | "FAILED",
      slot: number
    ): [string, string] {
      const payload = encodeModelBFinalityAttestation(payment, outcome, slot);
      return [
        signModelBFinalityAttestation(keyA, payload),
        signModelBFinalityAttestation(keyB, payload),
      ];
    }
    async function finalize(
      requestId: string,
      status: string,
      slot: number,
      a: string,
      b: string
    ): Promise<unknown[]> {
      return (
        await service!.query(`SELECT phase,finalized_slot FROM ${gateFn}`, [
          requestId,
          status,
          slot,
          a,
          b,
        ])
      ).rows;
    }

    const first = await preparePayment(
      "finality-witness-001",
      Buffer.from([1, 2, 3, 4]),
      "WitnessTestSignature1"
    );
    const [macA, macB] = attest(first, "CONFIRMED", 1234);
    assert.equal(
      (await finalize(first.requestId, "CONFIRMED", 1234, macA, "0".repeat(64)))
        .length,
      0
    );
    assert.equal(
      (await finalize(first.requestId, "FAILED", 1234, macA, macB)).length,
      0
    );
    assert.equal(
      (await finalize(first.requestId, "CONFIRMED", 1235, macA, macB)).length,
      0
    );
    assert.equal(
      (await finalize(first.requestId, "CONFIRMED", 1234, macB, macA)).length,
      0
    );
    assert.equal(
      (
        await finalize(
          first.requestId,
          "CONFIRMED",
          1234,
          attest({ ...first, vault: "AnotherVault" }, "CONFIRMED", 1234)[0],
          macB
        )
      ).length,
      0
    );

    const legacyClaim = [
      first.requestId,
      first.genesisHash,
      first.programId,
      first.vault,
      first.workflowDigest,
      first.paymentDigest,
      first.signedTransactionSha256,
      first.signature,
      first.lastValidBlockHeight,
      Buffer.from([1, 2, 3, 4]),
      "CONFIRMED",
      1234,
    ];
    assert.equal(
      (await service.query(`SELECT phase FROM ${legacyFn}`, legacyClaim))
        .rowCount,
      0,
      "D.8 quarantine must still block the unauthenticated finality function"
    );

    const settled = await finalize(
      first.requestId,
      "CONFIRMED",
      1234,
      macA,
      macB
    );
    assert.equal((settled[0] as { phase: string }).phase, "CONFIRMED");
    assert.equal(
      Number((settled[0] as { finalized_slot: string }).finalized_slot),
      1234
    );
    assert.equal(
      (await finalize(first.requestId, "CONFIRMED", 1234, macA, macB)).length,
      0,
      "Replayed attestations cannot mutate terminal payments"
    );
    assert.equal(
      (await finalize("unknown-request-000", "CONFIRMED", 1234, macA, macB))
        .length,
      0
    );

    const second = await preparePayment(
      "finality-witness-002",
      Buffer.from([7, 8, 9, 10]),
      "WitnessTestSignature2"
    );
    assert.equal(
      (await finalize(second.requestId, "CONFIRMED", 1234, macA, macB)).length,
      0,
      "Evidence for a different immutable payment identity must be rejected"
    );
    const secondClaim = [
      second.requestId,
      second.genesisHash,
      second.programId,
      second.vault,
      second.workflowDigest,
      second.paymentDigest,
      second.signedTransactionSha256,
      second.signature,
      second.lastValidBlockHeight,
      Buffer.from([7, 8, 9, 10]),
      "UNRESOLVED",
      null,
    ];
    assert.equal(
      (await service.query(`SELECT phase FROM ${legacyFn}`, secondClaim))
        .rows[0]?.phase,
      "UNRESOLVED"
    );
    const [secondA, secondB] = attest(second, "FAILED", 5678);
    assert.equal(
      (
        await finalize(second.requestId, "FAILED", 5678, secondA, secondB)
      )[0] !== undefined,
      true,
      "A two-witness terminal attestation must permit UNRESOLVED -> FAILED"
    );
    assert.equal(
      (await finalize(second.requestId, "CONFIRMED", 5678, secondA, secondB))
        .length,
      0
    );
  } finally {
    if (service) await service.end();
    if (owner) await owner.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
