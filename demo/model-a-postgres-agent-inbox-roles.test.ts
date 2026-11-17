import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Pool, type PoolClient } from "pg";
import { PaymentIntentConflict } from "./model-a-payment-intake";
import {
  RestrictedModelAInboxIntake,
  RestrictedModelAInboxReader,
} from "./model-a-postgres-agent-inbox-roles";

const databaseUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;

async function withRole<T>(
  pool: Pool,
  role: "av_model_a_intake" | "av_model_a_reader",
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const answer = await fn(client);
    await client.query("COMMIT");
    return answer;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function isDenied(error: unknown): boolean {
  return (error as { code?: string }).code === "42501";
}

/** This test NEVER touches a live app schema or payment. */
test(
  "77D3C2 PostgreSQL function grants isolate inbox intake and reader roles",
  { skip: databaseUrl ? false : "Set AGENTVAULT_TEST_DATABASE_URL" },
  async () => {
    assert.ok(databaseUrl);
    const url = new URL(databaseUrl);
    assert.ok(
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname),
      "Refusing remote PostgreSQL test target"
    );
    assert.match(
      decodeURIComponent(url.pathname),
      /^\/agentvault_test_[A-Za-z0-9_]+$/,
      "Refusing non-test database"
    );

    const schema = `av_modela_roles_${randomBytes(6).toString("hex")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    let created = false;
    try {
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await migrationClient.query(
          `SET search_path TO "${schema}", pg_catalog, pg_temp`
        );
        const baseline = readFileSync(
          resolve("sql/20261113_model_a_agent_inbox.sql"),
          "utf8"
        );
        const roles = readFileSync(
          resolve("sql/20261113_model_a_agent_inbox_roles.sql"),
          "utf8"
        );
        await migrationClient.query(baseline);
        await migrationClient.query(roles);
      } finally {
        await migrationClient.query("RESET search_path");
        migrationClient.release();
      }

      const nowUnix = 1_800_000_000;
      const vaultA = Keypair.generate().publicKey.toBase58();
      const vaultB = Keypair.generate().publicKey.toBase58();
      const agentA = Keypair.generate().publicKey.toBase58();
      const agentB = Keypair.generate().publicKey.toBase58();
      const recipient = Keypair.generate().publicKey.toBase58();
      const scope = (vault = vaultA, principalId = "developerA") => ({
        network: "devnet" as const,
        principalId,
        vault,
        nowUnix,
      });
      const request = (id: string, agentAuthority = agentA) => ({
        requestId: id,
        agentAuthority,
        taskId: "1",
        recipient,
        amountBaseUnits: "1",
        expiresAtUnix: String(nowUnix + 300),
      });
      const requestA = request("agentA_000001");
      const requestB = request("agentB_000001", agentB);

      // The writer can call submit and scoped read, but not the reader API.
      const first = await withRole(
        pool,
        "av_model_a_intake",
        async (client) => {
          const intake = new RestrictedModelAInboxIntake(client, schema);
          const result = await intake.receive({
            trustedScope: scope(),
            input: requestA,
          });
          assert.equal(result.duplicate, false);
          assert.equal(
            (
              await intake.read({
                trustedScope: scope(),
                requestId: requestA.requestId,
              })
            )?.request.requestId,
            requestA.requestId
          );
          return result;
        }
      );
      const duplicate = await withRole(
        pool,
        "av_model_a_intake",
        async (client) =>
          new RestrictedModelAInboxIntake(client, schema).receive({
            trustedScope: { ...scope(), nowUnix: nowUnix + 1 },
            input: requestA,
          })
      );
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(first.record, duplicate.record);

      await assert.rejects(
        withRole(pool, "av_model_a_intake", async (client) =>
          new RestrictedModelAInboxIntake(client, schema).receive({
            trustedScope: scope(),
            input: { ...requestA, amountBaseUnits: "2" },
          })
        ),
        PaymentIntentConflict
      );
      await assert.rejects(
        withRole(pool, "av_model_a_intake", async (client) =>
          new RestrictedModelAInboxIntake(client, schema).receive({
            trustedScope: scope(vaultA, "developerB"),
            input: requestA,
          })
        ),
        PaymentIntentConflict
      );

      // Two independent transactions race to insert the same identity.
      const concurrentRequest = request("agentA_000002");
      const concurrent = await Promise.all([
        withRole(pool, "av_model_a_intake", (client) =>
          new RestrictedModelAInboxIntake(client, schema).receive({
            trustedScope: scope(),
            input: concurrentRequest,
          })
        ),
        withRole(pool, "av_model_a_intake", (client) =>
          new RestrictedModelAInboxIntake(client, schema).receive({
            trustedScope: scope(),
            input: concurrentRequest,
          })
        ),
      ]);
      assert.deepEqual(concurrent.map((result) => result.duplicate).sort(), [
        false,
        true,
      ]);

      await withRole(pool, "av_model_a_intake", async (client) => {
        const intake = new RestrictedModelAInboxIntake(client, schema);
        await intake.receive({ trustedScope: scope(), input: requestB });
        await intake.receive({
          trustedScope: scope(vaultB),
          input: requestA,
        });
      });

      // The reader sees only the requested exact vault + agent scope.
      await withRole(pool, "av_model_a_reader", async (client) => {
        const reader = new RestrictedModelAInboxReader(client, schema);
        const a = await reader.discover({
          vault: vaultA,
          agentAuthority: agentA,
          nowUnix,
        });
        const b = await reader.discover({
          vault: vaultA,
          agentAuthority: agentB,
          nowUnix,
        });
        const differentVault = await reader.discover({
          vault: vaultB,
          agentAuthority: agentA,
          nowUnix,
        });
        assert.deepEqual(
          a.map((r) => r.request.requestId),
          [requestA.requestId, concurrentRequest.requestId]
        );
        assert.deepEqual(
          b.map((r) => r.request.requestId),
          [requestB.requestId]
        );
        assert.deepEqual(
          differentVault.map((r) => r.request.requestId),
          [requestA.requestId]
        );
        assert.deepEqual(
          await reader.discover({
            vault: vaultA,
            agentAuthority: agentA,
            nowUnix: nowUnix + 301,
          }),
          []
        );
      });

      // Negative permissions: forbidden SQL must actually fail with 42501.
      await assert.rejects(
        withRole(pool, "av_model_a_reader", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_agent_inbox`)
        ),
        isDenied
      );
      await assert.rejects(
        withRole(pool, "av_model_a_intake", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_agent_inbox`)
        ),
        isDenied
      );
      await assert.rejects(
        withRole(pool, "av_model_a_reader", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_inbox_submit('{}'::jsonb)`)
        ),
        isDenied
      );
      await assert.rejects(
        withRole(pool, "av_model_a_intake", (c) =>
          c.query(
            `SELECT * FROM "${schema}".model_a_inbox_discover($1,$2,$3)`,
            [vaultA, agentA, nowUnix]
          )
        ),
        isDenied
      );
      await assert.rejects(
        withRole(pool, "av_model_a_reader", (c) =>
          c.query(`CREATE TABLE "${schema}".forbidden (id int)`)
        ),
        isDenied
      );

      // Reconnect as the database owner, then drop to the reader role again.
      const newPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await withRole(newPool, "av_model_a_reader", async (client) => {
          const result = await new RestrictedModelAInboxReader(
            client,
            schema
          ).discover({ vault: vaultA, agentAuthority: agentA, nowUnix });
          assert.equal(result.length, 2);
          assert.equal(result[0].request.requestId, requestA.requestId);
        });
      } finally {
        await newPool.end();
      }
    } finally {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  }
);
