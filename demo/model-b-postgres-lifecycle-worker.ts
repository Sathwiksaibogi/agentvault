/** 7.6D.7 test-only worker. No live RPC, wallet keys, or CLI integration. */
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  openModelBReaderDatabase,
  openModelBCoordinatorDatabase,
  openModelBFinalizerDatabase,
} from "./model-b-postgres-runtime-databases";
import {
  createInactiveModelBCoordinatorRuntime,
  createInactiveModelBReaderRecoveryRuntime,
} from "./model-b-postgres-inactive-runtime";
import { createInactiveModelBFinalizerRuntime } from "./model-b-postgres-inactive-finalizer";
import { exerciseModelBPostgresBroadcastBoundary } from "./model-b-postgres-broadcast-boundary";
import type { AuthorizedSignedModelBPayment } from "./model-b-postgres-payment-store";

const urls = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
} as const;
type Role = keyof typeof urls;
type Envelope = {
  mode: string;
  requestId: string;
  genesisHash: string;
  programId: string;
  vault: string;
  signature: string;
  signedTransactionBase64: string;
  lastValidBlockHeight: number;
  binding: Record<string, unknown>;
};

async function readEnvelope(): Promise<Envelope> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 16384) throw Error("Oversized fixture");
  }
  return JSON.parse(input) as Envelope;
}

function preparePayment(input: Envelope): AuthorizedSignedModelBPayment {
  if (
    typeof input.binding.agentPda !== "string" ||
    typeof input.binding.approvedTaskPda !== "string"
  ) {
    throw Error("Invalid test payment binding");
  }
  return {
    requestId: input.requestId,
    signature: input.signature,
    signedTransaction: Buffer.from(input.signedTransactionBase64, "base64"),
    lastValidBlockHeight: input.lastValidBlockHeight,
    binding: {
      ...input.binding,
      agentPda: new PublicKey(input.binding.agentPda),
      approvedTaskPda: new PublicKey(input.binding.approvedTaskPda),
    } as AuthorizedSignedModelBPayment["binding"],
  };
}

async function main(): Promise<void> {
  assert.equal(process.env.AGENTVAULT_MODEL_B_LIFECYCLE_TEST_ONLY, "1");
  const input = await readEnvelope();
  assert.match(input.requestId, /^[A-Za-z0-9_-]{8,64}$/);
  const role: Role =
    input.mode === "inspect"
      ? "reader"
      : input.mode.startsWith("finalize-")
      ? "finalizer"
      : "coordinator";
  assert.equal(process.env.AGENTVAULT_MODEL_B_LIFECYCLE_ROLE, role);
  assert.equal(process.env.AGENTVAULT_TEST_DATABASE_URL, undefined);
  for (const key of [
    "AGENTVAULT_MODEL_B_TEST_READER_URL",
    "AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL",
    "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL",
  ])
    assert.equal(process.env[key], undefined);
  for (const other of Object.keys(urls) as Role[]) {
    if (other === role) assert.ok(process.env[urls[other]]);
    else
      assert.equal(
        process.env[urls[other]],
        undefined,
        "Sibling credential leaked to worker"
      );
  }
  const db =
    role === "reader"
      ? await openModelBReaderDatabase(process.env)
      : role === "coordinator"
      ? await openModelBCoordinatorDatabase(process.env)
      : await openModelBFinalizerDatabase(process.env);
  try {
    let result: Record<string, unknown>;
    if (role === "reader") {
      const runtime = createInactiveModelBReaderRecoveryRuntime(db.service);
      const snapshot = await runtime.inspect(input.requestId);
      result = {
        phase: snapshot.phase,
        nextAction: snapshot.nextAction,
        canBroadcast: snapshot.canBroadcast,
        finalizedSlot: snapshot.finalizedSlot,
      };
    } else if (role === "coordinator") {
      const service = (
        db as Awaited<ReturnType<typeof openModelBCoordinatorDatabase>>
      ).service;
      const payment = preparePayment(input);
      const trustedChecks = {
        trustedDevnetGenesisHash: input.genesisHash,
        getGenesisHash: async () => input.genesisHash,
        getBlockHeight: async (_commitment: "confirmed") => 100,
        assertFreshOnChainPolicy: async () => {}, // Fake chain policy: TEST ONLY.
      };
      if (input.mode.startsWith("prepare")) {
        const store =
          input.mode === "prepare-lost-claim-ack"
            ? {
                ...service,
                async claim(claim: Parameters<typeof service.claim>[0]) {
                  await service.claim(claim);
                  throw Error("TEST_LOST_CLAIM_ACK");
                },
              }
            : service;
        const runtime = createInactiveModelBCoordinatorRuntime(
          store,
          trustedChecks
        );
        if (input.mode === "prepare-lost-claim-ack") {
          await assert.rejects(runtime.prepare(payment), /TEST_LOST_CLAIM_ACK/);
          result = { expectedDenial: "LOST_CLAIM_ACK" };
        } else {
          result = { phase: (await runtime.prepare(payment)).phase };
        }
      } else {
        let calls = 0;
        const fakeRpc = {
          getGenesisHash: async () => input.genesisHash,
          getBlockHeight: async () => 100,
          simulateTransaction: async (
            _tx: unknown,
            config: { sigVerify: boolean; replaceRecentBlockhash: boolean }
          ) => {
            assert.equal(config.sigVerify, true);
            assert.equal(config.replaceRecentBlockhash, false);
            return {
              value: {
                err:
                  input.mode === "broadcast-simulation-denied"
                    ? { Custom: 1 }
                    : null,
              },
            };
          },
          sendRawTransaction: async (
            bytes: Uint8Array,
            config: { maxRetries: number }
          ) => {
            calls++;
            assert.equal(calls, 1);
            assert.equal(config.maxRetries, 0);
            assert.ok(
              Buffer.from(bytes).equals(Buffer.from(payment.signedTransaction))
            );
            if (input.mode === "broadcast-rpc-timeout")
              throw Error("TEST_RPC_TIMEOUT");
            return payment.signature;
          },
        };
        const perform = () =>
          exerciseModelBPostgresBroadcastBoundary(
            service,
            payment,
            fakeRpc as never,
            {
              mode: "test-harness",
              trustedDevnetGenesisHash: input.genesisHash,
              assertFreshOnChainPolicy: trustedChecks.assertFreshOnChainPolicy,
            }
          );
        if (input.mode === "broadcast-duplicate") {
          await assert.rejects(perform(), /SUBMISSION_LOCKED/);
          result = { expectedDenial: "SUBMISSION_LOCKED", sendCalls: calls };
        } else if (input.mode === "broadcast-rpc-timeout") {
          await assert.rejects(perform(), /TEST_RPC_TIMEOUT/);
          result = { expectedDenial: "RPC_TIMEOUT", sendCalls: calls };
        } else if (input.mode === "broadcast-simulation-denied") {
          await assert.rejects(perform(), /simulation failed/);
          result = { expectedDenial: "SIMULATION_DENIED", sendCalls: calls };
        } else {
          result = { status: (await perform()).status, sendCalls: calls };
        }
      }
    } else {
      const service = (
        db as Awaited<ReturnType<typeof openModelBFinalizerDatabase>>
      ).service;
      const mode = input.mode;
      const err =
        mode === "finalize-failed"
          ? { InstructionError: [1, { Custom: 7 }] }
          : null;
      const rpc = {
        getGenesisHash: async () =>
          mode === "finalize-wrong-ledger" ? "WRONG" : input.genesisHash,
        getSignatureStatuses: async (
          signatures: string[],
          config: { searchTransactionHistory: true }
        ) => {
          assert.deepEqual(signatures, [input.signature]);
          assert.equal(config.searchTransactionHistory, true);
          return {
            value: [
              {
                confirmationStatus:
                  mode === "finalize-confirmed-only"
                    ? ("confirmed" as const)
                    : ("finalized" as const),
                slot: 2401,
                err,
              },
            ],
          };
        },
        getTransaction: async (
          signature: string,
          config: { commitment: "finalized" }
        ) => {
          assert.equal(signature, input.signature);
          assert.equal(config.commitment, "finalized");
          return {
            slot: 2401,
            transaction: { signatures: [input.signature] },
            meta: { err },
          };
        },
      };
      const runtime = createInactiveModelBFinalizerRuntime(service, {
        genesisHash: input.genesisHash,
        programId: input.programId,
        vault: input.vault,
        rpc,
      });
      if (mode === "finalize-wrong-ledger") {
        await assert.rejects(
          runtime.reconcile(input.requestId),
          /RPC genesis differs/
        );
        result = { expectedDenial: "WRONG_LEDGER" };
      } else {
        const settled = await runtime.reconcile(input.requestId);
        result = {
          phase: settled.phase,
          action: settled.action,
          finalizedSlot: settled.finalizedSlot,
          canBroadcast: settled.canBroadcast,
        };
      }
    }
    process.stdout.write(
      `MODEL_B_LIFECYCLE_RESULT:${JSON.stringify(result)}\n`
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  // Do not print passwords, approval bytes, SQL errors, or transactions.
  process.stderr.write("MODEL_B_LIFECYCLE_WORKER_DENIED\n");
  process.exitCode = 1;
});
