import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

import * as nacl from "tweetnacl";

import { claimApprovedWorkflow } from "./request-journal";

import {
  encodeWorkflow,
  type ApprovalScope,
  type WorkflowApproval,
} from "./signed-workflow";

import { loadPreparedPayment, prepareSignedPayment } from "./prepared-payment";

const owner = Keypair.generate();
const agent = Keypair.generate();
const task = Keypair.generate().publicKey;

const address = () => Keypair.generate().publicKey.toBase58();

const workflow: WorkflowApproval = {
  version: 1,
  network: "devnet",
  requestId: "procurement-003",
  genesisHash: address(),
  programId: address(),
  vault: address(),
  owner: owner.publicKey.toBase58(),
  mint: address(),
  assignedAgent: "agent-a",
  agentAuthority: agent.publicKey.toBase58(),
  kind: "procurement",
  taskId: 1,
  recipient: address(),
  amountBaseUnits: 10000,
  expiresAtUnix: 2000000000,
  description: "Purchase replacement equipment",
};

const scope: ApprovalScope = {
  network: workflow.network,
  genesisHash: workflow.genesisHash,
  programId: workflow.programId,
  vault: workflow.vault,
  owner: workflow.owner,
  mint: workflow.mint,
};

const testTime = 1900000000;

let dir: string;

function signedApproval() {
  const signature = nacl.sign.detached(
    encodeWorkflow(workflow),
    owner.secretKey
  );

  return {
    workflow,
    signature: Buffer.from(signature).toString("base64"),
  };
}

function makeSignedTransaction(signer = agent): Transaction {
  // This is a mock transaction, not an AgentVault payment.
  // Nothing in these tests is ever broadcast.
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: address(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })
  );

  transaction.sign(signer);

  return transaction;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentvault-payment-"));

  claimApprovedWorkflow(dir, signedApproval(), scope, testTime);
});

afterEach(() => {
  rmSync(dir, {
    recursive: true,
    force: true,
  });
});

function prepare(transaction = makeSignedTransaction()) {
  return prepareSignedPayment(
    dir,
    workflow.requestId,
    "agent-a",
    agent.publicKey,
    task,
    10000,
    "1",
    123456,
    transaction
  );
}

test("stores an already signed transaction", () => {
  const { path, record } = prepare();

  assert.equal(record.status, "prepared");
  assert.equal(record.requestId, "procurement-003");
  assert.equal(record.amountBaseUnits, 10000);
  assert.equal(record.transactionSha256.length, 64);

  const saved = JSON.parse(readFileSync(path, "utf8"));

  assert.deepEqual(saved, record);
});

test("restores and verifies the exact signed bytes", () => {
  const { record } = prepare();

  const restored = loadPreparedPayment(dir, workflow.requestId);

  assert.deepEqual(restored.record, record);
  assert.ok(restored.transaction.verifySignatures());

  assert.equal(restored.raw.toString("base64"), record.rawTransactionBase64);
});

test("rejects preparing a second transaction", () => {
  prepare();

  assert.throws(
    () => prepare(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
  );
});

test("rejects amounts different from the claimed workflow", () => {
  assert.throws(() =>
    prepareSignedPayment(
      dir,
      workflow.requestId,
      "agent-a",
      agent.publicKey,
      task,
      20000,
      "1",
      123456,
      makeSignedTransaction()
    )
  );
});

test("rejects an unexpected fee payer", () => {
  const attacker = Keypair.generate();

  assert.throws(
    () => prepare(makeSignedTransaction(attacker)),
    /Fee payer is not the approved agent/
  );
});

test("detects corruption of stored transaction bytes", () => {
  const { path } = prepare();

  const saved = JSON.parse(readFileSync(path, "utf8"));

  saved.rawTransactionBase64 = Buffer.from("tampered").toString("base64");

  writeFileSync(path, JSON.stringify(saved));

  assert.throws(() => loadPreparedPayment(dir, workflow.requestId));
});
