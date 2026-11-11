/** 7.6D.12B: fail-closed, test-only PostgreSQL Ed25519 gate acceptance checks. */
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  encodeModelBEd25519Evidence,
  modelBEd25519PublicKeyHex,
} from "./model-b-finality-ed25519";
import type { AttestedPaymentIdentity } from "./model-b-finality-attestation-codec";

const readSql = (name: string) => readFileSync(resolve("sql", name), "utf8");
const migration = readSql("20261111_model_b_ed25519_finality_gate.sql");
const doc = readFileSync(
  resolve("docs/security/model-b-postgres-ed25519-gate.md"),
  "utf8"
);

function safeLocalUrl(raw: string, user?: string): URL {
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname) ||
    !url.password ||
    url.search ||
    url.hash ||
    (user !== undefined && decodeURIComponent(url.username) !== user)
  ) {
    throw new Error(
      "REFUSE: only a local, dedicated AgentVault test database is allowed"
    );
  }
  return url;
}

const identity: AttestedPaymentIdentity = {
  requestId: "ed25519-gate-payment-001",
  genesisHash: "11111111111111111111111111111111",
  programId: "11111111111111111111111111111111",
  vault: "11111111111111111111111111111111",
  workflowDigest: "a".repeat(64),
  paymentDigest: "b".repeat(64),
  signedTransactionSha256: "c".repeat(64),
  signature: "Ed25519GateTestSignature",
  lastValidBlockHeight: 9999,
};

function freshWitness(
  witnessId: "observer_a" | "observer_b",
  generation: number
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    witnessId,
    keyId: `${witnessId}_${generation}_key`,
    generation,
    privateKey,
    publicKeyHex: modelBEd25519PublicKeyHex(publicKey),
    sign(
      payment: AttestedPaymentIdentity,
      status: "CONFIRMED" | "FAILED",
      slot: number
    ) {
      return edSign(
        null,
        encodeModelBEd25519Evidence(
          payment,
          status,
          slot,
          witnessId,
          `${witnessId}_${generation}_key`,
          generation
        ),
        privateKey
      ).toString("hex");
    },
  };
}

test("SQL requires extension-owned pgsodium Ed25519 verifier and disposable owner schema", () => {
  assert.match(migration, /current_database\(\) !~ '\^agentvault_test/);
  assert.match(migration, /CURRENT_USER::pg_catalog\.regrole::oid/);
  assert.match(migration, /e\.extname='pgsodium'/);
  assert.match(migration, /d\.objid=p\.oid/);
  assert.match(migration, /d\.refobjid=crypto_ext AND d\.deptype='e'/);
  assert.match(migration, /crypto_sign_verify_detached\(bytea,bytea,bytea\)/);
  assert.match(migration, /REFUSE: vetted installed pgsodium is required/);
  assert.doesNotMatch(migration, /CREATE EXTENSION|ALTER EXTENSION/);
});

test("SQL checks two detached signatures against immutable DB payment, not finalizer-supplied keys", () => {
  assert.match(migration, /agentvault_model_b_ed25519_payload/);
  assert.match(
    migration,
    /AgentVault\/ModelB\/finality-attestation\/ed25519\/v2\|/
  );
  assert.match(migration, /AgentVault\/ModelB\/finality-attestation\/v1\|/);
  assert.match(migration, /public_key INTO pub_a/);
  assert.match(migration, /public_key INTO pub_b/);
  assert.match(migration, /pub_a=pub_b/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /signed_tx_sha256=payment\.signed_tx_sha256/);
  assert.match(migration, /crypto_sign_verify_detached\(/);
  assert.match(migration, /IS DISTINCT FROM TRUE/);
  assert.doesNotMatch(
    migration,
    /signed_tx_bytes = p_|public_key = p_|private_key|shared_secret bytea/i
  );
});

test("new gate retires HMAC execution atomically and does not grant registry access", () => {
  assert.match(migration, /^BEGIN;\s*DO /m);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION[\s\S]*agentvault_model_b_attested_finality_guarded/
  );
  assert.match(
    migration,
    /REFUSE: old HMAC finality gate retains effective EXECUTE grants/
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*ed25519_finality_guarded[\s\S]*av_model_b_finalizer/
  );
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]*asymmetric_witness_keys/);
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]*asymmetric_policy/);
  assert.match(
    migration,
    /D\.8 unauthenticated terminal path is not quarantined/
  );
  assert.match(migration, /SECURITY DEFINER SET search_path=pg_catalog/);
  assert.match(migration, /COMMIT;\s*$/);
});

test("Ed25519 canonical encoding binds different witness and generation (local cryptography)", () => {
  const a = freshWitness("observer_a", 1);
  const b = freshWitness("observer_b", 1);
  const sa = a.sign(identity, "CONFIRMED", 1234);
  const sb = b.sign(identity, "CONFIRMED", 1234);
  assert.match(sa, /^[0-9a-f]{128}$/);
  assert.notEqual(sa, sb);
  assert.notDeepEqual(
    encodeModelBEd25519Evidence(
      identity,
      "CONFIRMED",
      1234,
      "observer_a",
      a.keyId,
      1
    ),
    encodeModelBEd25519Evidence(
      identity,
      "CONFIRMED",
      1234,
      "observer_a",
      a.keyId,
      2
    )
  );
});

test("documentation keeps the optional DB verifier and live safety gate explicit", () => {
  assert.match(doc, /test-only/i);
  assert.match(doc, /pgsodium/i);
  assert.match(doc, /no live (payment|broadcast)/i);
  assert.match(doc, /independent RPC/i);
  assert.match(doc, /DBA/i);
  assert.match(doc, /quarantine/i);
});

test("real PostgreSQL: absent pgsodium refuses installation; installed pgsodium verifies both Ed25519 witnesses", async (t) => {
  const adminUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;
  const finalizerUrl = process.env.AGENTVAULT_MODEL_B_TEST_FINALIZER_URL;
  if (!adminUrl && !finalizerUrl) {
    t.skip("Set both existing isolated PostgreSQL test URLs");
    return;
  }
  if (!adminUrl || !finalizerUrl)
    throw new Error("REFUSE: both owner and finalizer test URLs required");
  assert.equal(
    safeLocalUrl(adminUrl).pathname,
    safeLocalUrl(finalizerUrl, "av76d6_finalizer_test").pathname
  );

  const schema = `av76d12b_${randomBytes(6).toString("hex")}`;
  const ownerAdmin = new Pool({ connectionString: adminUrl, max: 1 });
  let owner: Pool | undefined;
  let finalizer: Pool | undefined;
  let created = false;
  try {
    assert.equal(
      (
        await ownerAdmin.query<{ allowed: boolean }>(
          "SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed"
        )
      ).rows[0]?.allowed,
      true
    );
    await ownerAdmin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    owner = new Pool({
      connectionString: adminUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    finalizer = new Pool({
      connectionString: finalizerUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });

    const cryptoPresent = await ownerAdmin.query(
      "SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto'"
    );
    if (cryptoPresent.rowCount === 0) {
      await ownerAdmin.query(
        `CREATE EXTENSION pgcrypto WITH SCHEMA "${schema}"`
      );
    }
    for (const file of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await owner.query(readSql(file));
    }
    await owner.query(readSql("20261111_model_b_finality_quarantine.sql"));
    await owner.query(readSql("20261111_model_b_attested_finality_gate.sql"));

    const pgsodium = await ownerAdmin.query(
      "SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgsodium'"
    );
    if (pgsodium.rowCount === 0) {
      await assert.rejects(
        owner.query(migration),
        /REFUSE: vetted installed pgsodium/
      );
      await owner.query("ROLLBACK");
      assert.equal(
        (
          await owner.query("SELECT to_regclass($1)::text AS name", [
            `${schema}.agentvault_model_b_asymmetric_witness_keys`,
          ])
        ).rows[0]?.name,
        null,
        "a missing verifier must not create an alternative terminal gate"
      );
      assert.equal(
        (
          await owner.query<{ allowed: boolean }>(
            "SELECT has_function_privilege('av_model_b_finalizer', $1::regprocedure, 'EXECUTE') AS allowed",
            [
              `${schema}.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text)`,
            ]
          )
        ).rows[0]?.allowed,
        true,
        "a failed migration must roll back legacy ACL changes"
      );
      assert.equal(
        (
          await owner.query<{ source: string }>(
            "SELECT pg_get_functiondef($1::regprocedure) AS source",
            [
              `${schema}.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)`,
            ]
          )
        ).rows[0]?.source.includes("SET phase = 'UNRESOLVED'"),
        true
      );
      return;
    }

    // Only when the extension was preinstalled by the test database administrator.
    await owner.query(migration);
    const fn = `"${schema}".agentvault_model_b_ed25519_finality_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const oldFn = `${schema}.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text)`;
    const registry = `"${schema}".agentvault_model_b_asymmetric_witness_keys`;
    const policy = `"${schema}".agentvault_model_b_asymmetric_policy`;
    assert.equal(
      (
        await owner.query<{ allowed: boolean }>(
          "SELECT has_function_privilege('av_model_b_finalizer',$1::regprocedure,'EXECUTE') AS allowed",
          [oldFn]
        )
      ).rows[0]?.allowed,
      false
    );
    await assert.rejects(
      finalizer.query(`SELECT * FROM ${registry}`),
      (error: unknown) => (error as { code?: string }).code === "42501"
    );

    const keyA1 = freshWitness("observer_a", 1);
    const keyB1 = freshWitness("observer_b", 1);
    await owner.query(
      `INSERT INTO ${policy}(singleton,generation) VALUES(TRUE,1)`
    );
    async function insertKey(key: ReturnType<typeof freshWitness>) {
      await owner!.query(
        `INSERT INTO ${registry}(witness_id,key_id,generation,public_key,state) VALUES($1,$2,$3,$4,'ACTIVE')`,
        [
          key.witnessId,
          key.keyId,
          key.generation,
          Buffer.from(key.publicKeyHex, "hex"),
        ]
      );
    }
    await insertKey(keyA1);
    await insertKey(keyB1);
    async function prepare(
      requestId: string,
      signedBytes: Buffer
    ): Promise<AttestedPaymentIdentity> {
      const stored = {
        ...identity,
        requestId,
        signature: `Ed25519GateSignature_${requestId}`,
        signedTransactionSha256: createHash("sha256")
          .update(signedBytes)
          .digest("hex"),
      };
      const claim = [
        stored.requestId,
        stored.genesisHash,
        stored.programId,
        stored.vault,
        stored.workflowDigest,
        stored.paymentDigest,
      ];
      assert.equal(
        (
          await owner!.query(
            `SELECT phase FROM "${schema}".agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`,
            claim
          )
        ).rows[0]?.phase,
        "CLAIMED"
      );
      assert.equal(
        (
          await owner!.query(
            `SELECT phase FROM "${schema}".agentvault_model_b_prepare_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              requestId,
              signedBytes,
              stored.signedTransactionSha256,
              stored.signature,
              stored.lastValidBlockHeight,
              ...claim.slice(1),
            ]
          )
        ).rows[0]?.phase,
        "PREPARED"
      );
      assert.equal(
        (
          await owner!.query(
            `SELECT phase FROM "${schema}".agentvault_model_b_reserve_guarded($1)`,
            [requestId]
          )
        ).rows[0]?.phase,
        "SUBMISSION_RESERVED"
      );
      return stored;
    }
    async function submit(
      payment: AttestedPaymentIdentity,
      status: "CONFIRMED" | "FAILED",
      slot: number,
      a: ReturnType<typeof freshWitness>,
      b: ReturnType<typeof freshWitness>,
      requestId = payment.requestId
    ) {
      return (
        await finalizer!.query(`SELECT phase,finalized_slot FROM ${fn}`, [
          requestId,
          status,
          slot,
          a.keyId,
          a.generation,
          a.sign(payment, status, slot),
          b.keyId,
          b.generation,
          b.sign(payment, status, slot),
        ])
      ).rows;
    }
    const first = await prepare("ed25519-gate-001", Buffer.from([1, 2, 3, 4]));
    const payloadHex = (
      await owner.query<{ payload: string }>(
        `SELECT encode("${schema}".agentvault_model_b_ed25519_payload(p,$2,$3,$4,$5,$6),'hex') AS payload FROM "${schema}".agentvault_model_b_payment_requests p WHERE request_id=$1`,
        [first.requestId, "CONFIRMED", 1234, "observer_a", keyA1.keyId, 1]
      )
    ).rows[0]?.payload;
    assert.equal(
      payloadHex,
      encodeModelBEd25519Evidence(
        first,
        "CONFIRMED",
        1234,
        "observer_a",
        keyA1.keyId,
        1
      ).toString("hex")
    );
    assert.equal((await submit(first, "FAILED", 1234, keyA1, keyB1)).length, 1);
    assert.equal((await submit(first, "FAILED", 1234, keyA1, keyB1)).length, 0);
    const second = await prepare("ed25519-gate-002", Buffer.from([7, 8, 9]));
    assert.equal(
      (
        await finalizer.query(`SELECT phase FROM ${fn}`, [
          second.requestId,
          "CONFIRMED",
          1234,
          keyA1.keyId,
          1,
          keyA1.sign(first, "CONFIRMED", 1234),
          keyB1.keyId,
          1,
          keyB1.sign(first, "CONFIRMED", 1234),
        ])
      ).rows.length,
      0,
      "first payment's signatures cannot settle a different payment"
    );
    assert.equal(
      (
        await finalizer.query(`SELECT phase FROM ${fn}`, [
          second.requestId,
          "CONFIRMED",
          1234,
          keyA1.keyId,
          1,
          "0".repeat(128),
          keyB1.keyId,
          1,
          keyB1.sign(second, "CONFIRMED", 1234),
        ])
      ).rows.length,
      0,
      "stolen finalizer login cannot forge a witness signature"
    );

    const keyA2 = freshWitness("observer_a", 2);
    const keyB2 = freshWitness("observer_b", 2);
    await owner.query("BEGIN");
    try {
      await owner.query(
        `UPDATE ${registry} SET state='REVOKED' WHERE generation=1`
      );
      await insertKey(keyA2);
      await insertKey(keyB2);
      await owner.query(
        `UPDATE ${policy} SET generation=2 WHERE singleton=TRUE`
      );
      await owner.query("COMMIT");
    } catch (err) {
      await owner.query("ROLLBACK");
      throw err;
    }
    assert.equal(
      (await submit(second, "CONFIRMED", 5678, keyA1, keyB1)).length,
      0,
      "old generation invalid after rotation"
    );
    assert.equal(
      (await submit(second, "CONFIRMED", 5678, keyA2, keyB2))[0]?.phase,
      "CONFIRMED"
    );
    assert.equal(
      (await submit(second, "FAILED", 5678, keyA2, keyB2)).length,
      0,
      "terminal phase cannot change"
    );
  } finally {
    if (finalizer) await finalizer.end();
    if (owner) await owner.end();
    if (created) await ownerAdmin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await ownerAdmin.end();
  }
});
