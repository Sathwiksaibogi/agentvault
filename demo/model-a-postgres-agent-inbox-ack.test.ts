import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Pool, type PoolClient } from "pg";
import {
  RestrictedModelAInboxIntake,
  RestrictedModelAInboxReader,
} from "./model-a-postgres-agent-inbox-roles";
import { RestrictedModelAInboxAcknowledger } from "./model-a-postgres-agent-inbox-ack";

const databaseUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;
type Role = "av_model_a_intake" | "av_model_a_reader" | "av_model_a_ack";

async function asRole<T>(
  pool: Pool,
  role: Role,
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    (error as { code?: string }).code === code;
}

/** All mutations are scoped to a new disposable localhost TEST schema. */
test(
  "77D3C3 durable read-only delivery acknowledgments are isolated and idempotent",
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

    const schema = `av_modela_ack_${randomBytes(6).toString("hex")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    let created = false;
    try {
      const owner = await pool.connect();
      try {
        await owner.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await owner.query(
          `SET search_path TO "${schema}", pg_catalog, pg_temp`
        );
        for (const filename of [
          "20261113_model_a_agent_inbox.sql",
          "20261113_model_a_agent_inbox_roles.sql",
          "20261113_model_a_inbox_ack.sql",
        ]) {
          await owner.query(readFileSync(resolve("sql", filename), "utf8"));
        }
      } finally {
        await owner.query("RESET search_path");
        owner.release();
      }

      const nowUnix = 1_800_000_000;
      const vaultA = Keypair.generate().publicKey.toBase58();
      const vaultB = Keypair.generate().publicKey.toBase58();
      const agentA = Keypair.generate().publicKey.toBase58();
      const agentB = Keypair.generate().publicKey.toBase58();
      const recipient = Keypair.generate().publicKey.toBase58();
      const scope = (vault: string) => ({
        network: "devnet" as const,
        principalId: "developerA",
        vault,
        nowUnix,
      });
      const request = (requestId: string, agentAuthority = agentA) => ({
        requestId,
        agentAuthority,
        taskId: "1",
        recipient,
        amountBaseUnits: "1",
        expiresAtUnix: String(nowUnix + 300),
      });
      const reqA = request("ack_agent_A0001");
      const reqB = request("ack_agent_B0001", agentB);
      const reqConcurrent = request("ack_agent_A0002");
      const reqRollback = request("ack_agent_A0003");
      const reqVaultB = request("ack_vault_B0001");
      const reqExpired = {
        ...request("ack_expired_0001"),
        expiresAtUnix: String(nowUnix + 1),
      };

      await asRole(pool, "av_model_a_intake", async (c) => {
        const intake = new RestrictedModelAInboxIntake(c, schema);
        for (const input of [
          reqA,
          reqB,
          reqConcurrent,
          reqRollback,
          reqExpired,
        ]) {
          assert.equal(
            (await intake.receive({ trustedScope: scope(vaultA), input }))
              .duplicate,
            false
          );
        }
        await intake.receive({ trustedScope: scope(vaultB), input: reqVaultB });
      });

      const inboxBefore = await asRole(pool, "av_model_a_reader", async (c) =>
        new RestrictedModelAInboxReader(c, schema).discover({
          vault: vaultA,
          agentAuthority: agentA,
          nowUnix,
        })
      );
      assert.equal(inboxBefore.length, 4); // includes about-to-expire item

      const ackA = (client: PoolClient) =>
        new RestrictedModelAInboxAcknowledger(client, schema);
      const first = await asRole(pool, "av_model_a_ack", (c) =>
        ackA(c).acknowledge({
          vault: vaultA,
          agentAuthority: agentA,
          requestId: reqA.requestId,
          nowUnix,
        })
      );
      assert.deepEqual(first, {
        acknowledgedAtUnix: nowUnix,
        duplicate: false,
      });
      const repeated = await asRole(pool, "av_model_a_ack", (c) =>
        ackA(c).acknowledge({
          vault: vaultA,
          agentAuthority: agentA,
          requestId: reqA.requestId,
          nowUnix: nowUnix + 10,
        })
      );
      assert.deepEqual(repeated, {
        acknowledgedAtUnix: nowUnix,
        duplicate: true,
      });

      // Agent B and other vaults cannot acknowledge agent A's request.
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentB,
            requestId: reqA.requestId,
            nowUnix,
          })
        ),
        hasCode("P0002")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultB,
            agentAuthority: agentA,
            requestId: reqA.requestId,
            nowUnix,
          })
        ),
        hasCode("P0002")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: "missing_0000001",
            nowUnix,
          })
        ),
        hasCode("P0002")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqExpired.requestId,
            nowUnix: nowUnix + 1,
          })
        ),
        hasCode("P0002")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqA.requestId,
            nowUnix: nowUnix + 301,
          })
        ),
        hasCode("P0002")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqA.requestId,
            nowUnix: nowUnix - 1,
          })
        ),
        hasCode("P0002")
      );

      // Two independent transactions racing to ack produce one durable receipt.
      const concurrent = await Promise.all([
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqConcurrent.requestId,
            nowUnix,
          })
        ),
        asRole(pool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqConcurrent.requestId,
            nowUnix,
          })
        ),
      ]);
      assert.deepEqual(concurrent.map((v) => v.duplicate).sort(), [
        false,
        true,
      ]);

      // A committed SQL receipt survives reconnect. A rolled-back ack does not.
      await assert.rejects(
        asRole(pool, "av_model_a_ack", async (c) => {
          await ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqRollback.requestId,
            nowUnix,
          });
          throw new Error("simulated process crash before commit");
        }),
        /simulated process crash/
      );
      const afterRollback = await asRole(pool, "av_model_a_ack", (c) =>
        ackA(c).acknowledge({
          vault: vaultA,
          agentAuthority: agentA,
          requestId: reqRollback.requestId,
          nowUnix: nowUnix + 2,
        })
      );
      assert.equal(afterRollback.duplicate, false);
      assert.equal(afterRollback.acknowledgedAtUnix, nowUnix + 2);
      const restartedPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const survived = await asRole(restartedPool, "av_model_a_ack", (c) =>
          ackA(c).acknowledge({
            vault: vaultA,
            agentAuthority: agentA,
            requestId: reqRollback.requestId,
            nowUnix: nowUnix + 3,
          })
        );
        assert.deepEqual(survived, {
          acknowledgedAtUnix: nowUnix + 2,
          duplicate: true,
        });
      } finally {
        await restartedPool.end();
      }

      // Role grants: ack role cannot modify inbox or call submission/discovery.
      await assert.rejects(
        asRole(pool, "av_model_a_reader", (c) =>
          c.query(
            `SELECT * FROM "${schema}".model_a_inbox_acknowledge($1,$2,$3,$4)`,
            [vaultA, agentA, reqA.requestId, nowUnix]
          )
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_intake", (c) =>
          c.query(
            `SELECT * FROM "${schema}".model_a_inbox_acknowledge($1,$2,$3,$4)`,
            [vaultA, agentA, reqA.requestId, nowUnix]
          )
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_agent_inbox`)
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_inbox_acks`)
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          c.query(
            `SELECT * FROM "${schema}".model_a_inbox_discover($1,$2,$3)`,
            [vaultA, agentA, nowUnix]
          )
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          c.query(`SELECT * FROM "${schema}".model_a_inbox_submit('{}'::jsonb)`)
        ),
        hasCode("42501")
      );
      await assert.rejects(
        asRole(pool, "av_model_a_ack", (c) =>
          c.query(`DELETE FROM "${schema}".model_a_inbox_acks`)
        ),
        hasCode("42501")
      );

      const inboxAfter = await asRole(pool, "av_model_a_reader", async (c) =>
        new RestrictedModelAInboxReader(c, schema).discover({
          vault: vaultA,
          agentAuthority: agentA,
          nowUnix,
        })
      );
      // Ack changes receipt metadata only; the payment intent stays readable.
      assert.deepEqual(inboxAfter, inboxBefore);
      const record = await asRole(pool, "av_model_a_intake", (c) =>
        new RestrictedModelAInboxIntake(c, schema).read({
          trustedScope: scope(vaultA),
          requestId: reqA.requestId,
        })
      );
      assert.equal(record?.status, "received");
    } finally {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  }
);
