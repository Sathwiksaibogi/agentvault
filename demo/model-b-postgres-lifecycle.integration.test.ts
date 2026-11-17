/**
 * 7.6D.7: genuine multi-process, independent-LOGIN Model B lifecycle test.
 * The ONLY RPC in every worker is an in-memory fake. Nothing is broadcast
 * to Devnet or mainnet. Disposable local agentvault_test* schemas only.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";

const roles = ["reader", "coordinator", "finalizer"] as const;
type Role = (typeof roles)[number];
const envName: Record<Role, string> = {
  reader: "AGENTVAULT_MODEL_B_TEST_READER_URL",
  coordinator: "AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL",
  finalizer: "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL",
};
const runtimeName: Record<Role, string> = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
};
const expectedUser: Record<Role, string> = {
  reader: "av76d6_reader_test",
  coordinator: "av76d6_coordinator_test",
  finalizer: "av76d6_finalizer_test",
};

function localTestUrl(raw: string, login?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Error("REFUSE: invalid local PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname) ||
    !url.password ||
    url.hash ||
    url.search ||
    (login !== undefined && decodeURIComponent(url.username) !== login)
  ) {
    throw Error(
      "REFUSE: lifecycle integration requires a local agentvault_test* database and isolated logins"
    );
  }
  return url;
}

function envelope(
  fx: ReturnType<typeof makeModelBPostgresFixture>,
  mode: string
) {
  return {
    mode,
    requestId: fx.payment.requestId,
    genesisHash: fx.claim.genesisHash,
    programId: fx.claim.programId,
    vault: fx.claim.vault,
    signature: fx.payment.signature,
    signedTransactionBase64: Buffer.from(fx.payment.signedTransaction).toString(
      "base64"
    ),
    lastValidBlockHeight: fx.payment.lastValidBlockHeight,
    binding: {
      ...fx.binding,
      agentPda: fx.binding.agentPda.toBase58(),
      approvedTaskPda: fx.binding.approvedTaskPda.toBase58(),
    },
  };
}

/** Never pass all-roles URLs or sibling passwords to a spawned service. */
function runWorker(
  schema: string,
  isolatedUrls: Record<Role, string>,
  fx: ReturnType<typeof makeModelBPostgresFixture>,
  mode: string,
  expectFailure = false
): Promise<Record<string, unknown>> {
  const role: Role =
    mode === "inspect"
      ? "reader"
      : mode.startsWith("finalize-")
      ? "finalizer"
      : "coordinator";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTVAULT_MODEL_B_LIFECYCLE_TEST_ONLY: "1",
    AGENTVAULT_MODEL_B_LIFECYCLE_ROLE: role,
    AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: schema,
    [runtimeName[role]]: isolatedUrls[role],
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "demo/model-b-postgres-lifecycle-worker.ts"],
      {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16_384) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_384) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (expectFailure) {
        if (code === 1 && stderr.includes("MODEL_B_LIFECYCLE_WORKER_DENIED")) {
          resolveResult({ expectedDenial: "PROCESS_DENIED" });
        } else reject(Error(`Expected fail-closed ${mode} process`));
        return;
      }
      const prefix = "MODEL_B_LIFECYCLE_RESULT:";
      const match = stdout
        .split("\n")
        .filter((line) => line.startsWith(prefix));
      if (code !== 0 || match.length !== 1) {
        reject(
          Error(`Isolated ${mode} process failed without exposing credentials`)
        );
        return;
      }
      try {
        resolveResult(
          JSON.parse(match[0].slice(prefix.length)) as Record<string, unknown>
        );
      } catch {
        reject(Error(`Invalid isolated ${mode} result`));
      }
    });
    child.stdin.end(JSON.stringify(envelope(fx, mode)));
  });
}

const migrations = [
  "20261110_model_b_payment_requests.sql",
  "20261110_model_b_payment_finality.sql",
  "20261111_model_b_runtime_roles.sql",
  "20261111_model_b_guarded_writes.sql",
  "20261111_model_b_privilege_audit.sql",
];

test("lifecycle worker never imports live payment CLI, keys, or real Solana transport", () => {
  const worker = readFileSync(
    resolve("demo/model-b-postgres-lifecycle-worker.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    worker,
    /(?:execute-ai-workflow-model-b|loadAgentSigner|fromSecretKey|clusterApiUrl|new Connection|fetch\()/
  );
  assert.match(worker, /TEST_ONLY/);
  assert.match(worker, /test-harness/);
  assert.match(worker, /maxRetries/);
});

test("lifecycle worker explicitly denies shared owner and sibling database credentials", () => {
  const worker = readFileSync(
    resolve("demo/model-b-postgres-lifecycle-worker.ts"),
    "utf8"
  );
  assert.match(worker, /AGENTVAULT_TEST_DATABASE_URL/);
  assert.match(worker, /Sibling credential leaked/);
  assert.match(worker, /MODEL_B_LIFECYCLE_WORKER_DENIED/);
});

test("lifecycle integration uses isolated child environments and only disposable local schemas", () => {
  const file = readFileSync(
    resolve("demo/model-b-postgres-lifecycle.integration.test.ts"),
    "utf8"
  );
  assert.match(file, /agentvault_test/);
  assert.match(file, /DROP SCHEMA/);
  assert.match(file, /process\.env\.PATH/);
  assert.match(file, /\[runtimeName\[role\]\]: isolatedUrls\[role\]/);
});

test(
  "real PostgreSQL: isolated Model B prepare, single fake send, finality and crash recovery",
  { timeout: 180_000 },
  async (t) => {
    const root = process.env.AGENTVAULT_TEST_DATABASE_URL;
    const configured = roles.filter((role) =>
      Boolean(process.env[envName[role]])
    );
    if (!root && configured.length === 0) {
      t.skip("Set AGENTVAULT_TEST_DATABASE_URL and three isolated role URLs");
      return;
    }
    if (!root) throw Error("Missing dedicated local test owner URL");
    if (configured.length === 0) {
      t.skip("Configure all three independent 7.6D.6 LOGIN URLs");
      return;
    }
    if (configured.length !== 3)
      throw Error("REFUSE: partial independent LOGIN configuration");
    const rootParsed = localTestUrl(root);
    const isolatedUrls = {} as Record<Role, string>;
    for (const role of roles) {
      const raw = process.env[envName[role]];
      if (!raw) throw Error(`Missing ${envName[role]}`);
      const parsed = localTestUrl(raw, expectedUser[role]);
      if (parsed.pathname !== rootParsed.pathname)
        throw Error("REFUSE: database mismatch");
      isolatedUrls[role] = raw;
    }

    const schema = `av76d7_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({ connectionString: root, max: 1 });
    let migration: Pool | undefined;
    let schemaCreated = false;
    try {
      const privilege = await admin.query<{ allowed: boolean }>(
        "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed"
      );
      assert.equal(privilege.rows[0]?.allowed, true);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      migration = new Pool({
        connectionString: root,
        max: 1,
        options: `-c search_path=${schema}`,
      });
      for (const file of migrations) {
        await migration.query(readFileSync(resolve("sql", file), "utf8"));
      }
      const run = (
        fx: ReturnType<typeof makeModelBPostgresFixture>,
        mode: string,
        expectFailure = false
      ) => runWorker(schema, isolatedUrls, fx, mode, expectFailure);

      // Happy path: all stages are in independent, ephemeral processes.
      const success = makeModelBPostgresFixture("modelb-lifecycle-success-01");
      assert.equal((await run(success, "inspect")).phase, "NOT_FOUND");
      assert.equal((await run(success, "prepare")).phase, "PREPARED");
      assert.equal((await run(success, "inspect")).nextAction, "MANUAL_REVIEW");
      assert.deepEqual(await run(success, "broadcast"), {
        status: "rpc_accepted_not_finalized",
        sendCalls: 1,
      });
      assert.deepEqual(await run(success, "broadcast-duplicate"), {
        expectedDenial: "SUBMISSION_LOCKED",
        sendCalls: 0,
      });
      assert.equal(
        (await run(success, "inspect")).phase,
        "SUBMISSION_RESERVED"
      );
      assert.deepEqual(await run(success, "finalize-success"), {
        phase: "CONFIRMED",
        action: "UPDATED",
        finalizedSlot: 2401,
        canBroadcast: false,
      });
      assert.equal((await run(success, "inspect")).phase, "CONFIRMED");
      assert.equal(
        (await run(success, "finalize-success")).action,
        "ALREADY_TERMINAL"
      );

      // A pre-CAS simulation error cannot burn the submission permit.
      const simulation = makeModelBPostgresFixture(
        "modelb-lifecycle-simulation-02"
      );
      await run(simulation, "prepare");
      assert.deepEqual(await run(simulation, "broadcast-simulation-denied"), {
        expectedDenial: "SIMULATION_DENIED",
        sendCalls: 0,
      });
      assert.equal((await run(simulation, "inspect")).phase, "PREPARED");

      // SQL claim acknowledgment can be lost AFTER commit. Never claim again.
      const claimLost = makeModelBPostgresFixture(
        "modelb-lifecycle-lost-claim-03"
      );
      assert.deepEqual(await run(claimLost, "prepare-lost-claim-ack"), {
        expectedDenial: "LOST_CLAIM_ACK",
      });
      assert.equal((await run(claimLost, "inspect")).phase, "CLAIMED");
      assert.equal(
        (await run(claimLost, "prepare", true)).expectedDenial,
        "PROCESS_DENIED"
      );
      assert.equal(
        (await run(claimLost, "inspect")).nextAction,
        "MANUAL_REVIEW"
      );

      // Lost RPC response occurs after the one-use permit commits.
      const uncertain = makeModelBPostgresFixture(
        "modelb-lifecycle-uncertain-04"
      );
      await run(uncertain, "prepare");
      assert.deepEqual(await run(uncertain, "broadcast-rpc-timeout"), {
        expectedDenial: "RPC_TIMEOUT",
        sendCalls: 1,
      });
      assert.equal(
        (await run(uncertain, "inspect")).phase,
        "SUBMISSION_RESERVED"
      );
      assert.equal((await run(uncertain, "broadcast-duplicate")).sendCalls, 0);
      assert.equal(
        (await run(uncertain, "finalize-confirmed-only")).phase,
        "UNRESOLVED"
      );
      assert.equal(
        (await run(uncertain, "inspect")).nextAction,
        "INSPECT_FINALITY"
      );
      assert.equal(
        (await run(uncertain, "finalize-success")).phase,
        "CONFIRMED"
      );

      // Ledger mismatch cannot cause a finality SQL write.
      const failed = makeModelBPostgresFixture("modelb-lifecycle-failed-05");
      await run(failed, "prepare");
      await run(failed, "broadcast");
      assert.equal(
        (await run(failed, "finalize-wrong-ledger")).expectedDenial,
        "WRONG_LEDGER"
      );
      assert.equal((await run(failed, "inspect")).phase, "SUBMISSION_RESERVED");
      assert.equal((await run(failed, "finalize-failed")).phase, "FAILED");
      assert.equal((await run(failed, "inspect")).nextAction, "TERMINAL");

      // Two independent coordinators compete for the exact same durable permit.
      const race = makeModelBPostgresFixture("modelb-lifecycle-race-006");
      await run(race, "prepare");
      const results = await Promise.allSettled([
        run(race, "broadcast"),
        run(race, "broadcast"),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1
      );
      assert.equal((await run(race, "inspect")).phase, "SUBMISSION_RESERVED");
    } finally {
      if (migration) await migration.end();
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }
);
