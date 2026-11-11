/**
 * TEST-ONLY fake RPC worker. NEVER use this file to inspect a real payment.
 * Fixture input and synthetic finality are deliberately untrusted and must
 * NEVER be accepted by the production witness worker or live executor.
 */
import { inspectAndAttestModelBFinality } from "./model-b-finality-independent-witness";
import type { ModelBPaymentRecord } from "./model-b-postgres-payment-store";

async function main() {
  const serialized = process.env.AGENTVAULT_WITNESS_TEST_FIXTURE;
  const keyHex = process.env.AGENTVAULT_WITNESS_TEST_KEY_HEX;
  const witnessId = process.env.AGENTVAULT_WITNESS_TEST_ID;
  if (
    process.env.AGENTVAULT_TEST_DATABASE_URL ||
    process.env.AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL ||
    process.env.AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL ||
    !serialized ||
    !/^[0-9a-f]{64}$/.test(keyHex ?? "") ||
    !["observer_a", "observer_b"].includes(witnessId ?? "")
  ) {
    throw new Error("TEST_WITNESS_DENIED");
  }
  const raw = JSON.parse(Buffer.from(serialized, "base64").toString("utf8"));
  const record: ModelBPaymentRecord = {
    ...raw,
    signedTransaction: Buffer.from(raw.signedTransactionHex, "hex"),
  };
  const calls: string[] = [];
  const rpc = {
    getGenesisHash: async () => {
      calls.push("genesis");
      return record.genesisHash;
    },
    getSignatureStatuses: async () => {
      calls.push("status");
      return {
        value: [
          { confirmationStatus: "finalized" as const, slot: 271, err: null },
        ],
      };
    },
    getTransaction: async () => {
      calls.push("receipt");
      return {
        slot: 271,
        transaction: { signatures: [record.signature!] },
        meta: { err: null },
      };
    },
  };
  const key = Buffer.from(keyHex!, "hex");
  try {
    const decision = await inspectAndAttestModelBFinality(
      witnessId as "observer_a" | "observer_b",
      key,
      record,
      {
        genesisHash: record.genesisHash,
        programId: record.programId,
        vault: record.vault,
        rpc,
      }
    );
    process.stdout.write(
      `MODEL_B_TEST_WITNESS:${JSON.stringify({ decision, calls })}\n`
    );
  } finally {
    key.fill(0);
  }
}
main().catch(() => {
  process.stderr.write("MODEL_B_TEST_WITNESS_DENIED\n");
  process.exitCode = 1;
});
