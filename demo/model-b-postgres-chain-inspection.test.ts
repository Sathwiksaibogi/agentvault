import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  inspectModelBFinality,
  type ModelBFinalityRpc,
} from "./model-b-postgres-chain-inspection";
import type { ModelBPaymentRecord } from "./model-b-postgres-payment-store";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encode58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > BigInt(0)) {
    out = B58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || "1";
}

function fixture(): ModelBPaymentRecord {
  const signer = Keypair.generate();
  const recipient = Keypair.generate();
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    })
  );
  tx.sign(signer);
  const signedTransaction = Buffer.from(tx.serialize());
  return {
    requestId: "modelb-finality-001",
    genesisHash: Keypair.generate().publicKey.toBase58(),
    programId: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    workflowDigest: "a".repeat(64),
    paymentDigest: "b".repeat(64),
    phase: "SUBMISSION_RESERVED",
    signedTransaction,
    signedTransactionSha256: createHash("sha256")
      .update(signedTransaction)
      .digest("hex"),
    signature: encode58(tx.signature!),
    lastValidBlockHeight: 9000,
  };
}

type Override = {
  genesis?: string;
  laterGenesis?: string;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
  statusAbsent?: boolean;
  statusErr?: unknown | null;
  receiptAbsent?: boolean;
  receiptErr?: unknown | null;
  receiptSignature?: string;
  receiptSlot?: number;
  statusSlot?: number;
};
function fakeRpc(record: ModelBPaymentRecord, o: Override = {}) {
  const calls: string[] = [];
  let genesisChecks = 0;
  const rpc: ModelBFinalityRpc = {
    async getGenesisHash() {
      calls.push("genesis");
      return ++genesisChecks === 1
        ? o.genesis ?? record.genesisHash
        : o.laterGenesis ?? record.genesisHash;
    },
    async getSignatureStatuses(signatures, config) {
      calls.push("status");
      assert.deepEqual(signatures, [record.signature]);
      assert.deepEqual(config, { searchTransactionHistory: true });
      return {
        value: [
          o.statusAbsent
            ? null
            : {
                confirmationStatus: o.confirmationStatus ?? "finalized",
                slot: o.statusSlot ?? 321,
                err: o.statusErr ?? null,
              },
        ],
      };
    },
    async getTransaction(signature, config) {
      calls.push("receipt");
      assert.equal(signature, record.signature);
      assert.deepEqual(config, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      return o.receiptAbsent
        ? null
        : {
            slot: o.receiptSlot ?? 321,
            meta: { err: o.receiptErr ?? null },
            transaction: {
              signatures: [o.receiptSignature ?? record.signature!],
            },
          };
    },
  };
  return { rpc, calls };
}

test("finalized success requires matching signature, slot, and both ledger checks", async () => {
  const record = fixture();
  const { rpc, calls } = fakeRpc(record);
  assert.deepEqual(await inspectModelBFinality(record, rpc), {
    status: "CONFIRMED",
    requestId: record.requestId,
    signature: record.signature,
    finalizedSlot: 321,
  });
  assert.deepEqual(calls, ["genesis", "status", "receipt", "genesis"]);
});

test("finalized on-chain error yields FAILED only when both RPC records agree", async () => {
  const record = fixture();
  const err = { InstructionError: [2, { Custom: 42 }] };
  const { rpc } = fakeRpc(record, { statusErr: err, receiptErr: err });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "FAILED");
});

test("processed and confirmed results remain unresolved", async () => {
  for (const confirmationStatus of ["processed", "confirmed"] as const) {
    const record = fixture();
    const { rpc, calls } = fakeRpc(record, { confirmationStatus });
    assert.equal(
      (await inspectModelBFinality(record, rpc)).status,
      "UNRESOLVED"
    );
    assert.deepEqual(calls, ["genesis", "status"]);
  }
});

test("missing signature history remains unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, { statusAbsent: true });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});

test("finalized status without a transaction receipt remains unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, { receiptAbsent: true });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});

test("another ledger is rejected before status reads", async () => {
  const record = fixture();
  const { rpc, calls } = fakeRpc(record, {
    genesis: Keypair.generate().publicKey.toBase58(),
  });
  await assert.rejects(inspectModelBFinality(record, rpc), /genesis differs/);
  assert.deepEqual(calls, ["genesis"]);
});

test("ledger switch after status and receipt is rejected", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, {
    laterGenesis: Keypair.generate().publicKey.toBase58(),
  });
  await assert.rejects(inspectModelBFinality(record, rpc), /genesis changed/);
});

test("receipt signature substitution remains unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, {
    receiptSignature: Keypair.generate().publicKey.toBase58(),
  });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});

test("receipt slot substitution remains unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, { receiptSlot: 322 });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});

test("contradictory finalized transaction errors remain unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record, {
    statusErr: { InstructionError: [0, "InvalidArgument"] },
  });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});

test("corrupted or altered saved bytes fail before any RPC calls", async () => {
  const record = fixture();
  const { rpc, calls } = fakeRpc(record);
  await assert.rejects(
    inspectModelBFinality(
      {
        ...record,
        signedTransactionSha256: "f".repeat(64),
      },
      rpc
    ),
    /digest mismatch/
  );
  assert.deepEqual(calls, []);
});

test("unsubmitted and terminal records cannot initiate fresh chain inspection", async () => {
  for (const phase of ["CLAIMED", "PREPARED", "CONFIRMED", "FAILED"] as const) {
    const record = { ...fixture(), phase };
    const { rpc, calls } = fakeRpc(record);
    await assert.rejects(
      inspectModelBFinality(record, rpc),
      /Only submitted or unresolved/
    );
    assert.deepEqual(calls, []);
  }
});

test("previously unresolved requests can be observed without resubmission", async () => {
  const record = { ...fixture(), phase: "UNRESOLVED" as const };
  const { rpc, calls } = fakeRpc(record);
  assert.equal((await inspectModelBFinality(record, rpc)).status, "CONFIRMED");
  assert.ok(!calls.includes("send"));
});

test("malformed finalized RPC responses lacking error metadata stay unresolved", async () => {
  const record = fixture();
  const { rpc } = fakeRpc(record);
  rpc.getSignatureStatuses = async () => ({
    value: [{ confirmationStatus: "finalized", slot: 321, err: undefined }],
  });
  rpc.getTransaction = async () => ({
    slot: 321,
    transaction: { signatures: [record.signature!] },
    meta: { err: undefined },
  });
  assert.equal((await inspectModelBFinality(record, rpc)).status, "UNRESOLVED");
});
