import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Pool } from "pg";
import { PaymentIntentConflict } from "./model-a-payment-intake";
import { PostgresModelAAgentInbox } from "./model-a-postgres-agent-inbox";

const databaseUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;

/** This test runs only on a dedicated local test database, never in production. */
test(
  "77D3C1 PostgreSQL intake is durable, idempotent and agent-scoped",
  { skip: databaseUrl ? false : "Set AGENTVAULT_TEST_DATABASE_URL" },
  async () => {
    assert.ok(databaseUrl);
    const target = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname),
      "Refusing nonlocal test database"
    );
    assert.match(
      decodeURIComponent(target.pathname),
      /^\/agentvault_test_[A-Za-z0-9_]+$/,
      "Refusing database without agentvault_test_ prefix"
    );

    const schema = `av_modela_test_${randomBytes(6).toString("hex")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let created = false;
    try {
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await migrationClient.query(
          `SET search_path TO "${schema}", pg_catalog`
        );
        const migration = readFileSync(
          resolve("sql/20261113_model_a_agent_inbox.sql"),
          "utf8"
        );
        await migrationClient.query(migration);
      } finally {
        try {
          await migrationClient.query("RESET search_path");
        } finally {
          migrationClient.release();
        }
      }

      const store = new PostgresModelAAgentInbox(pool, schema);
      const nowUnix = 1_800_000_000;
      const vaultA = Keypair.generate().publicKey.toBase58();
      const vaultB = Keypair.generate().publicKey.toBase58();
      const agentA = Keypair.generate().publicKey.toBase58();
      const agentB = Keypair.generate().publicKey.toBase58();
      const recipient = Keypair.generate().publicKey.toBase58();
      const scope = (vault: string, principalId = "developer-A") => ({
        network: "devnet" as const,
        principalId,
        vault,
        nowUnix,
      });
      const request = (
        requestId: string,
        agentAuthority: string,
        amountBaseUnits = "1"
      ) => ({
        requestId,
        agentAuthority,
        taskId: "1",
        recipient,
        amountBaseUnits,
        expiresAtUnix: String(nowUnix + 300),
      });

      const a = request("agentA_000001", agentA);
      const b = request("agentB_000001", agentB);

      // Concurrent identical inserts must create exactly one durable identity.
      const [first, second] = await Promise.all([
        store.receive({ trustedScope: scope(vaultA), input: a }),
        store.receive({ trustedScope: scope(vaultA), input: a }),
      ]);
      assert.deepEqual([first.duplicate, second.duplicate].sort(), [
        false,
        true,
      ]);
      assert.deepEqual(first.record, second.record);
      await store.receive({ trustedScope: scope(vaultA), input: b });

      await assert.rejects(
        store.receive({
          trustedScope: scope(vaultA),
          input: request(a.requestId, agentA, "2"),
        }),
        PaymentIntentConflict
      );
      await assert.rejects(
        store.receive({
          trustedScope: scope(vaultA, "developer-B"),
          input: a,
        }),
        PaymentIntentConflict
      );
      await assert.rejects(
        store.receive({
          trustedScope: scope(vaultA),
          input: request(a.requestId, agentB),
        }),
        PaymentIntentConflict
      );

      const itemB = await store.read({
        trustedScope: scope(vaultA),
        requestId: b.requestId,
      });
      assert.equal(itemB?.request.agentAuthority, agentB);
      assert.equal(
        await store.read({
          trustedScope: scope(vaultA, "developer-B"),
          requestId: b.requestId,
        }),
        null
      );

      // A request ID is unique per vault, not globally across unrelated vaults.
      await store.receive({ trustedScope: scope(vaultB), input: a });
      const [inboxA, inboxB, otherVault] = await Promise.all([
        store.discover({ vault: vaultA, agentAuthority: agentA, nowUnix }),
        store.discover({ vault: vaultA, agentAuthority: agentB, nowUnix }),
        store.discover({ vault: vaultB, agentAuthority: agentA, nowUnix }),
      ]);
      assert.deepEqual(
        inboxA.map((r) => r.request.requestId),
        [a.requestId]
      );
      assert.deepEqual(
        inboxB.map((r) => r.request.requestId),
        [b.requestId]
      );
      assert.deepEqual(
        otherVault.map((r) => r.request.requestId),
        [a.requestId]
      );
      assert.deepEqual(
        await store.discover({
          vault: vaultA,
          agentAuthority: agentA,
          nowUnix: nowUnix + 301,
        }),
        []
      );

      // Separate Pool instance proves records outlive the writer's connection.
      const laterPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const later = new PostgresModelAAgentInbox(laterPool, schema);
        assert.equal(
          (
            await later.read({
              trustedScope: scope(vaultA),
              requestId: a.requestId,
            })
          )?.request.requestId,
          a.requestId
        );
      } finally {
        await laterPool.end();
      }
    } finally {
      if (created) {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await pool.end();
    }
  }
);
