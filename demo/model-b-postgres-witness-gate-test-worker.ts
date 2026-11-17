/**
 * 7.6D.11 TEST-ONLY multi-process witness-to-SQL integration.
 * WITNESS role: one READ-ONLY PostgreSQL login + one synthetic RPC fixture +
 * one ephemeral HMAC secret, never a finalizer credential.
 * FINALIZER role: one finalizer PostgreSQL login + both witness decisions;
 * NO witness keys, signer secrets, live RPC, or transaction broadcast.
 * This file is NEVER imported by a live executor or the real witness worker.
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import {
  openModelBReaderDatabase,
  parseModelBRoleDatabaseConfiguration,
  verifyModelBRoleDatabase,
} from "./model-b-postgres-runtime-databases";
import {
  inspectAndAttestModelBFinality,
  type WitnessDecision,
  type WitnessId,
} from "./model-b-finality-independent-witness";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import { requireModelBDualWitnessAgreement } from "./model-b-finality-witness-agreement";

const MARKER = "MODEL_B_D11_RESULT:";
const DENIED = "MODEL_B_D11_WORKER_DENIED";
const requestId = process.argv[2];
const role = process.env.AGENTVAULT_D11_TEST_ROLE;
const schema = process.env.AGENTVAULT_MODEL_B_PRIVATE_SCHEMA;

async function stdinJSON(maxBytes = 2048): Promise<unknown> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("Oversized witness envelope");
  }
  return JSON.parse(text) as unknown;
}

function fakeWitnessRpc(
  genesisHash: string,
  signature: string,
  mode: string
): ModelBFinalityRpc {
  if (
    ![
      "success",
      "failed",
      "confirmed",
      "contradictory",
      "wrong-ledger",
    ].includes(mode)
  ) {
    throw new Error("Unknown isolated synthetic RPC scenario");
  }
  const failure = { InstructionError: [1, { Custom: 19 }] };
  return {
    async getGenesisHash() {
      return mode === "wrong-ledger"
        ? "11111111111111111111111111111111"
        : genesisHash;
    },
    async getSignatureStatuses(signatures, config) {
      assert.deepEqual(signatures, [signature]);
      assert.equal(config.searchTransactionHistory, true);
      return {
        value: [
          {
            confirmationStatus:
              mode === "confirmed"
                ? ("confirmed" as const)
                : ("finalized" as const),
            slot: 271,
            err: mode === "failed" || mode === "contradictory" ? failure : null,
          },
        ],
      };
    },
    async getTransaction(requestedSignature, config) {
      assert.equal(requestedSignature, signature);
      assert.equal(config.commitment, "finalized");
      assert.equal(config.maxSupportedTransactionVersion, 0);
      return {
        slot: 271,
        transaction: { signatures: [signature] },
        meta: { err: mode === "failed" ? failure : null },
      };
    },
  };
}

async function runWitness(): Promise<Record<string, unknown>> {
  assert.equal(
    process.env.AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL,
    undefined
  );
  assert.equal(
    process.env.AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL,
    undefined
  );
  const witnessId = process.env.AGENTVAULT_D11_TEST_WITNESS_ID;
  assert.ok(witnessId === "observer_a" || witnessId === "observer_b");
  const keyHex = process.env.AGENTVAULT_D11_TEST_WITNESS_KEY_HEX;
  assert.match(keyHex ?? "", /^[0-9a-f]{64}$/);
  const key = Buffer.from(keyHex!, "hex");
  assert.ok(new Set(key).size >= 8);
  const db = await openModelBReaderDatabase(process.env);
  try {
    const record = await db.service.getForReconciliation(requestId);
    if (!record || !record.signature)
      throw new Error("Unrecognized stored payment");
    const rpc = fakeWitnessRpc(
      record.genesisHash,
      record.signature,
      process.env.AGENTVAULT_D11_TEST_RPC_MODE ?? ""
    );
    const decision = await inspectAndAttestModelBFinality(
      witnessId as WitnessId,
      key,
      record,
      {
        genesisHash: record.genesisHash,
        programId: record.programId,
        vault: record.vault,
        rpc,
      }
    );
    return { decision };
  } finally {
    key.fill(0);
    await db.close();
  }
}

async function runFinalizer(): Promise<Record<string, unknown>> {
  assert.equal(process.env.AGENTVAULT_MODEL_B_READER_DATABASE_URL, undefined);
  assert.equal(
    process.env.AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL,
    undefined
  );
  assert.equal(process.env.AGENTVAULT_D11_TEST_WITNESS_KEY_HEX, undefined);
  assert.equal(process.env.AGENTVAULT_D11_TEST_WITNESS_ID, undefined);
  assert.equal(process.env.AGENTVAULT_D11_TEST_RPC_MODE, undefined);
  const config = parseModelBRoleDatabaseConfiguration("finalizer", process.env);
  // Pin the SAME authenticated DB session for preflight, read and mutation.
  // Pool.query() could open a fresh unverified connection after preflight.
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await verifyModelBRoleDatabase(
      client,
      "finalizer",
      config.privateSchema,
      config.loginName
    );
    const existing = await client.query<{
      request_id: string;
      tx_signature: string | null;
      phase: string;
    }>(
      `SELECT request_id,tx_signature,phase FROM "${config.privateSchema}".agentvault_model_b_payment_requests WHERE request_id=$1`,
      [requestId]
    );
    if (
      existing.rows.length !== 1 ||
      !existing.rows[0]?.tx_signature ||
      !["SUBMISSION_RESERVED", "UNRESOLVED"].includes(existing.rows[0].phase)
    ) {
      throw new Error("Payment not eligible for terminal reconciliation");
    }
    const input = (await stdinJSON()) as {
      a?: WitnessDecision;
      b?: WitnessDecision;
    };
    const agreed = requireModelBDualWitnessAgreement(
      { requestId, signature: existing.rows[0].tx_signature },
      input?.a as WitnessDecision,
      input?.b as WitnessDecision
    );
    const settled = await client.query<{
      phase: string;
      finalized_slot: string;
    }>(
      `SELECT phase,finalized_slot FROM "${config.privateSchema}".agentvault_model_b_attested_finality_guarded($1,$2,$3,$4,$5)`,
      [
        agreed.requestId,
        agreed.status,
        agreed.finalizedSlot,
        agreed.macA,
        agreed.macB,
      ]
    );
    return {
      applied: settled.rows.length === 1,
      phase: settled.rows[0]?.phase ?? null,
      finalizedSlot: settled.rows[0]
        ? Number(settled.rows[0].finalized_slot)
        : null,
    };
  } finally {
    client?.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  assert.equal(process.env.AGENTVAULT_D11_TEST_ONLY, "1");
  assert.match(requestId ?? "", /^[A-Za-z0-9_-]{8,64}$/);
  assert.match(schema ?? "", /^[a-z][a-z0-9_]{2,62}$/);
  assert.equal(process.env.AGENTVAULT_TEST_DATABASE_URL, undefined);
  for (const testName of [
    "AGENTVAULT_MODEL_B_TEST_READER_URL",
    "AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL",
    "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL",
  ])
    assert.equal(process.env[testName], undefined);
  if (role !== "witness" && role !== "finalizer")
    throw new Error("Unknown test role");
  const result = role === "witness" ? await runWitness() : await runFinalizer();
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
}

main().catch(() => {
  // Never log HMACs, RPC replies, database URLs, SQL errors or sensitive input.
  process.stderr.write(`${DENIED}\n`);
  process.exitCode = 1;
});
