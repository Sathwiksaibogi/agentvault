/**
 * 7.6D.11: TEST-ONLY real PostgreSQL witness-to-finality-gate integration.
 * Two isolated reader processes inspect synthetic Solana observations and
 * create distinct MACs; a third isolated finalizer process has no keys.
 * The database owner exists ONLY in this test harness to provision disposable
 * schema/fixtures; no transaction is sent or a live schema modified.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import { requireModelBDualWitnessAgreement } from "./model-b-finality-witness-agreement";
import type { WitnessDecision } from "./model-b-finality-independent-witness";

const code = (name: string) => readFileSync(resolve("sql", name), "utf8");
const workerPath = "demo/model-b-postgres-witness-gate-test-worker.ts";
const ownerEnv = "AGENTVAULT_TEST_DATABASE_URL";
const readerEnv = "AGENTVAULT_MODEL_B_TEST_READER_URL";
const finalizerEnv = "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL";
const marker = "MODEL_B_D11_RESULT:";

function localOnlyDb(raw: string, login?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw Error("REFUSE: bad local test URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(parsed.pathname) ||
    !parsed.username ||
    !parsed.password ||
    parsed.search ||
    parsed.hash ||
    (login && decodeURIComponent(parsed.username) !== login)
  ) {
    throw Error("REFUSE: only local dedicated AgentVault test login permitted");
  }
  return parsed;
}

type TestRole = "witness" | "finalizer";
type WorkerCall = Readonly<{
  role: TestRole;
  requestId: string;
  schema: string;
  url: string;
  witnessId?: "observer_a" | "observer_b";
  witnessKey?: Buffer;
  rpcMode?: string;
  evidence?: Record<string, unknown>;
  expectDenied?: boolean;
}>;

function runWorker(input: WorkerCall): Promise<Record<string, unknown>> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTVAULT_D11_TEST_ONLY: "1",
    AGENTVAULT_D11_TEST_ROLE: input.role,
    AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: input.schema,
    ...(input.role === "witness"
      ? {
          AGENTVAULT_MODEL_B_READER_DATABASE_URL: input.url,
          AGENTVAULT_D11_TEST_WITNESS_ID: input.witnessId,
          AGENTVAULT_D11_TEST_WITNESS_KEY_HEX:
            input.witnessKey?.toString("hex"),
          AGENTVAULT_D11_TEST_RPC_MODE: input.rpcMode,
        }
      : { AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL: input.url }),
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", workerPath, input.requestId], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4096) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 4096) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (input.expectDenied) {
        if (exitCode === 1 && stderr.includes("MODEL_B_D11_WORKER_DENIED")) {
          resolveResult({ denied: true });
        } else reject(Error("Isolated worker did not fail closed"));
        return;
      }
      const result = stdout
        .split("\n")
        .filter((line) => line.startsWith(marker));
      if (exitCode !== 0 || result.length !== 1) {
        reject(
          Error(
            "Isolated witness/finalizer worker failed (no credentials disclosed)"
          )
        );
        return;
      }
      try {
        resolveResult(
          JSON.parse(result[0].slice(marker.length)) as Record<string, unknown>
        );
      } catch {
        reject(Error("Unparseable isolated worker response"));
      }
    });
    child.stdin.end(JSON.stringify(input.evidence ?? {}));
  });
}

function terminal(
  id: "observer_a" | "observer_b",
  status: "CONFIRMED" | "FAILED",
  slot = 271
): WitnessDecision {
  return {
    witnessId: id,
    requestId: "modelb-test-123",
    signature: "ExpectedSignature",
    status,
    finalizedSlot: slot,
    mac: "a".repeat(64),
  };
}

test("agreement rejects duplicate identities, missing MACs, conflicting outcomes and slots", () => {
  const expected = {
    requestId: "modelb-test-123",
    signature: "ExpectedSignature",
  };
  const a = terminal("observer_a", "CONFIRMED");
  const b = terminal("observer_b", "CONFIRMED");
  assert.equal(
    requireModelBDualWitnessAgreement(expected, a, b).status,
    "CONFIRMED"
  );
  for (const altered of [
    { ...b, witnessId: "observer_a" },
    { ...b, status: "FAILED" },
    { ...b, finalizedSlot: 272 },
    { ...b, signature: "DifferentSignature" },
    { ...b, requestId: "other-payment" },
    { ...b, mac: "0" },
    { ...b, mac: "z".repeat(64) },
    { ...b, finalizedSlot: Number.MAX_SAFE_INTEGER + 1 },
    {
      witnessId: "observer_b",
      requestId: "modelb-test-123",
      status: "UNRESOLVED",
      mac: null,
      finalizedSlot: null,
    },
  ]) {
    assert.throws(
      () =>
        requireModelBDualWitnessAgreement(
          expected,
          a,
          altered as WitnessDecision
        ),
      /WITNESS_GATE_DENIED/
    );
  }
  assert.throws(
    () => requireModelBDualWitnessAgreement(expected, a, a),
    /WITNESS_GATE_DENIED/
  );
});

test("agreement is only preflight; MAC correctness remains guarded by PostgreSQL", () => {
  const agreed = requireModelBDualWitnessAgreement(
    { requestId: "modelb-test-123", signature: "ExpectedSignature" },
    terminal("observer_a", "FAILED"),
    terminal("observer_b", "FAILED")
  );
  assert.deepEqual(
    Object.keys(agreed).sort(),
    ["finalizedSlot", "macA", "macB", "requestId", "status"].sort()
  );
  assert.equal(agreed.finalizedSlot, 271);
  assert.ok(Object.isFrozen(agreed));
  // Identically formatted but forged MACs pass preflight and MUST still fail SQL.
  assert.equal(agreed.macA, "a".repeat(64));
});

test("synthetic integration worker cannot access live payment, real RPC or sibling keys", () => {
  const worker = readFileSync(resolve(workerPath), "utf8");
  assert.match(worker, /TEST-ONLY/);
  assert.match(worker, /openModelBReaderDatabase/);
  assert.match(worker, /verifyModelBRoleDatabase/);
  assert.match(worker, /AGENTVAULT_TEST_DATABASE_URL/);
  assert.match(worker, /AGENTVAULT_D11_TEST_WITNESS_KEY_HEX, undefined/);
  assert.doesNotMatch(
    worker,
    /(?:sendRawTransaction|sendTransaction|signTransaction|reserveOneSubmission)\s*\(/
  );
  assert.doesNotMatch(worker, /new Connection\(|execute-ai-workflow-model-b/);
});

test("integration harness requires disposable local database and per-role child environments", () => {
  const source = readFileSync(
    resolve("demo/model-b-postgres-witness-gate.integration.test.ts"),
    "utf8"
  );
  assert.match(source, /DROP SCHEMA/);
  assert.match(source, /agentvault_test/);
  assert.match(source, /AGENTVAULT_D11_TEST_ROLE/);
  assert.match(source, /AGENTVAULT_MODEL_B_TEST_READER_URL/);
  assert.match(source, /AGENTVAULT_MODEL_B_TEST_FINALIZER_URL/);
  assert.doesNotMatch(source, /new Connection\(|sendRawTransaction\s*\(/);
});

test(
  "real PostgreSQL: separately inspected witness evidence gates terminal writes",
  { timeout: 180_000 },
  async (t) => {
    const rawOwner = process.env[ownerEnv];
    const rawReader = process.env[readerEnv];
    const rawFinalizer = process.env[finalizerEnv];
    if (!rawOwner && !rawReader && !rawFinalizer) {
      t.skip(
        "Configure owner, reader and finalizer local test connection URLs"
      );
      return;
    }
    if (!rawOwner || !rawReader || !rawFinalizer) {
      throw Error(
        "REFUSE: all three independently authenticated test URLs required"
      );
    }
    const ownerParsed = localOnlyDb(rawOwner);
    const readerParsed = localOnlyDb(rawReader, "av76d6_reader_test");
    const finalizerParsed = localOnlyDb(rawFinalizer, "av76d6_finalizer_test");
    assert.equal(readerParsed.pathname, ownerParsed.pathname);
    assert.equal(finalizerParsed.pathname, ownerParsed.pathname);

    const schema = `av76d11_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({ connectionString: rawOwner, max: 1 });
    let owner: Pool | undefined;
    let created = false;
    try {
      const allowed = await admin.query<{ allowed: boolean }>(
        "SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed"
      );
      assert.equal(allowed.rows[0]?.allowed, true);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      owner = new Pool({
        connectionString: rawOwner,
        max: 1,
        options: `-c search_path=${schema}`,
      });
      const hasCrypto = await admin.query(
        "SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto'"
      );
      if (hasCrypto.rowCount === 0) {
        await admin.query(`CREATE EXTENSION pgcrypto WITH SCHEMA "${schema}"`);
      }
      for (const name of [
        "20261110_model_b_payment_requests.sql",
        "20261110_model_b_payment_finality.sql",
        "20261111_model_b_runtime_roles.sql",
        "20261111_model_b_guarded_writes.sql",
        "20261111_model_b_privilege_audit.sql",
        "20261111_model_b_finality_quarantine.sql",
        "20261111_model_b_attested_finality_gate.sql",
      ])
        await owner.query(code(name));

      const keyA = randomBytes(32);
      const keyB = randomBytes(32);
      await owner.query(
        `INSERT INTO "${schema}".agentvault_model_b_evidence_keys(witness_id,shared_secret) VALUES ($1,$2),($3,$4)`,
        ["observer_a", keyA, "observer_b", keyB]
      );
      const testFinalizer = new Pool({
        connectionString: rawFinalizer,
        max: 1,
      });
      try {
        await assert.rejects(
          testFinalizer.query(
            `SELECT shared_secret FROM "${schema}".agentvault_model_b_evidence_keys`
          ),
          (error: unknown) => (error as { code?: string }).code === "42501"
        );
      } finally {
        await testFinalizer.end();
      }

      async function prepare(
        fx: ReturnType<typeof makeModelBPostgresFixture>
      ): Promise<void> {
        const claim = fx.claim;
        const bytes = Buffer.from(fx.payment.signedTransaction);
        const args = [
          claim.requestId,
          claim.genesisHash,
          claim.programId,
          claim.vault,
          claim.workflowDigest,
          claim.paymentDigest,
        ];
        assert.equal(
          (
            await owner!.query(
              `SELECT phase FROM "${schema}".agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`,
              args
            )
          ).rows[0]?.phase,
          "CLAIMED"
        );
        assert.equal(
          (
            await owner!.query(
              `SELECT phase FROM "${schema}".agentvault_model_b_prepare_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                claim.requestId,
                bytes,
                fx.record.signedTransactionSha256,
                fx.payment.signature,
                fx.payment.lastValidBlockHeight,
                ...args.slice(1),
              ]
            )
          ).rows[0]?.phase,
          "PREPARED"
        );
        assert.equal(
          (
            await owner!.query(
              `SELECT phase FROM "${schema}".agentvault_model_b_reserve_guarded($1)`,
              [claim.requestId]
            )
          ).rows[0]?.phase,
          "SUBMISSION_RESERVED"
        );
      }
      async function phase(id: string): Promise<string> {
        return (
          (
            await owner!.query<{ phase: string }>(
              `SELECT phase FROM "${schema}".agentvault_model_b_payment_requests WHERE request_id=$1`,
              [id]
            )
          ).rows[0]?.phase ?? "NOT_FOUND"
        );
      }
      const witness = (
        requestId: string,
        witnessId: "observer_a" | "observer_b",
        key: Buffer,
        rpcMode: string,
        expectDenied = false
      ) =>
        runWorker({
          role: "witness",
          requestId,
          schema,
          url: rawReader,
          witnessId,
          witnessKey: key,
          rpcMode,
          expectDenied,
        });
      const settle = (
        requestId: string,
        a: unknown,
        b: unknown,
        expectDenied = false
      ) =>
        runWorker({
          role: "finalizer",
          requestId,
          schema,
          url: rawFinalizer,
          evidence: { a, b },
          expectDenied,
        });
      async function pair(requestId: string, modeA: string, modeB: string) {
        const [a, b] = await Promise.all([
          witness(requestId, "observer_a", keyA, modeA),
          witness(requestId, "observer_b", keyB, modeB),
        ]);
        return {
          a: a.decision as WitnessDecision,
          b: b.decision as WitnessDecision,
        };
      }

      const success = makeModelBPostgresFixture("modelb-d11-success-01");
      await prepare(success);
      const verified = await pair(
        success.claim.requestId,
        "success",
        "success"
      );
      assert.equal(verified.a.status, "CONFIRMED");
      assert.equal(verified.b.status, "CONFIRMED");
      assert.equal(
        (await settle(success.claim.requestId, verified.a, null, true)).denied,
        true,
        "One witness alone cannot satisfy the gate"
      );
      assert.equal(
        (
          await settle(success.claim.requestId, verified.a, {
            ...verified.b,
            mac: "0".repeat(64),
          })
        ).applied,
        false,
        "A fabricated but well-formed MAC must fail SQL verification"
      );
      assert.equal(await phase(success.claim.requestId), "SUBMISSION_RESERVED");
      assert.deepEqual(
        await settle(success.claim.requestId, verified.a, verified.b),
        { applied: true, phase: "CONFIRMED", finalizedSlot: 271 }
      );
      assert.equal(await phase(success.claim.requestId), "CONFIRMED");
      assert.equal(
        (await settle(success.claim.requestId, verified.a, verified.b, true))
          .denied,
        true,
        "Terminal row cannot be replayed"
      );

      const other = makeModelBPostgresFixture("modelb-d11-other-002");
      await prepare(other);
      const substitutedA = {
        ...verified.a,
        requestId: other.claim.requestId,
        signature: other.payment.signature,
      };
      const substitutedB = {
        ...verified.b,
        requestId: other.claim.requestId,
        signature: other.payment.signature,
      };
      assert.equal(
        (await settle(other.claim.requestId, substitutedA, substitutedB))
          .applied,
        false,
        "SQL MAC binding must reject evidence from another payment"
      );
      assert.equal(
        (await settle(other.claim.requestId, verified.a, verified.b, true))
          .denied,
        true,
        "The finalizer must reject a mismatched request before SQL"
      );
      const disagreement = await pair(
        other.claim.requestId,
        "success",
        "failed"
      );
      assert.equal(
        (
          await settle(
            other.claim.requestId,
            disagreement.a,
            disagreement.b,
            true
          )
        ).denied,
        true,
        "Contradictory independent observations cannot settle"
      );
      const pending = await pair(other.claim.requestId, "confirmed", "success");
      assert.equal(pending.a.status, "UNRESOLVED");
      assert.equal(
        (await settle(other.claim.requestId, pending.a, pending.b, true))
          .denied,
        true,
        "Unfinalized observation cannot settle"
      );
      assert.equal(
        (
          await witness(
            other.claim.requestId,
            "observer_a",
            keyA,
            "wrong-ledger",
            true
          )
        ).denied,
        true
      );
      assert.equal(await phase(other.claim.requestId), "SUBMISSION_RESERVED");

      const identicalFailure = await pair(
        other.claim.requestId,
        "failed",
        "failed"
      );
      assert.deepEqual(
        await settle(
          other.claim.requestId,
          identicalFailure.a,
          identicalFailure.b
        ),
        { applied: true, phase: "FAILED", finalizedSlot: 271 }
      );
      assert.equal(await phase(other.claim.requestId), "FAILED");
      const stored = await owner.query<{
        phase: string;
        finalized_slot: string;
      }>(
        `SELECT phase,finalized_slot FROM "${schema}".agentvault_model_b_payment_requests WHERE request_id=$1`,
        [other.claim.requestId]
      );
      assert.equal(stored.rows[0].phase, "FAILED");
      assert.equal(Number(stored.rows[0].finalized_slot), 271);
    } finally {
      if (owner) await owner.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }
);
