import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { PublicKey, Transaction } from "@solana/web3.js";

import type { AgentId } from "./workflow-policy";
import type { RequestJournalRecord } from "./request-journal";

export type PreparedPaymentRecord = {
  version: 1;
  status: "prepared";
  requestId: string;
  network: string;
  approvalDigest: string;
  agent: AgentId;
  agentAuthority: string;
  taskPda: string;
  amountBaseUnits: number;
  nonce: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  signatureBase64: string;
  rawTransactionBase64: string;
  transactionSha256: string;
};

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readClaim(
  runtimeDir: string,
  requestId: string
): RequestJournalRecord {
  assert.match(requestId, /^[a-zA-Z0-9_-]{8,64}$/, "Invalid request ID");

  const claimPath = join(runtimeDir, "journal", `${requestId}.json`);

  const claim = JSON.parse(
    readFileSync(claimPath, "utf8")
  ) as RequestJournalRecord;

  assert.equal(claim.status, "claimed");
  assert.equal(claim.requestId, requestId);

  return claim;
}

export function prepareSignedPayment(
  runtimeDir: string,
  requestId: string,
  agent: AgentId,
  agentAuthority: PublicKey,
  taskPda: PublicKey,
  amountBaseUnits: number,
  nonce: string,
  lastValidBlockHeight: number,
  transaction: Transaction
): {
  path: string;
  record: PreparedPaymentRecord;
} {
  // 1. The workflow must already have been claimed.
  const claim = readClaim(runtimeDir, requestId);

  assert.equal(claim.agent, agent);
  assert.equal(claim.amountBaseUnits, amountBaseUnits);

  assert.ok(
    Number.isSafeInteger(amountBaseUnits) && amountBaseUnits > 0,
    "Invalid amount"
  );

  assert.match(nonce, /^(0|[1-9][0-9]*)$/);

  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0,
    "Invalid blockhash validity height"
  );

  // 2. Require an already-signed, agent-funded transaction.
  assert.ok(
    transaction.feePayer?.equals(agentAuthority),
    "Fee payer is not the approved agent"
  );

  assert.equal(
    transaction.signatures.length,
    1,
    "Expected exactly one agent signature"
  );

  assert.ok(
    transaction.signatures[0].publicKey.equals(agentAuthority),
    "Unexpected transaction signer"
  );

  assert.ok(transaction.verifySignatures(), "Transaction signature is invalid");

  assert.ok(transaction.signature, "Missing transaction signature");

  assert.ok(transaction.recentBlockhash, "Missing recent blockhash");

  // 3. Serialize exactly the transaction to be broadcast.
  const raw = transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: true,
  });

  const record: PreparedPaymentRecord = {
    version: 1,
    status: "prepared",
    requestId,
    network: claim.network,
    approvalDigest: claim.approvalDigest,
    agent,
    agentAuthority: agentAuthority.toBase58(),
    taskPda: taskPda.toBase58(),
    amountBaseUnits,
    nonce,
    recentBlockhash: transaction.recentBlockhash,
    lastValidBlockHeight,
    signatureBase64: Buffer.from(transaction.signature).toString("base64"),
    rawTransactionBase64: raw.toString("base64"),
    transactionSha256: sha256(raw),
  };

  const journalDir = join(runtimeDir, "journal");

  const path = join(journalDir, `${requestId}.signed.json`);

  // 4. Exclusive creation prevents replacing a previously
  // prepared transaction with another signed transaction.
  const fd = openSync(path, "wx", 0o600);

  try {
    writeFileSync(fd, JSON.stringify(record, null, 2));

    // Flush the transaction data before proceeding.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Flush the directory entry too, on Linux.
  const directoryFd = openSync(journalDir, "r");

  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }

  return { path, record };
}

export function loadPreparedPayment(
  runtimeDir: string,
  requestId: string
): {
  record: PreparedPaymentRecord;
  transaction: Transaction;
  raw: Buffer;
} {
  const claim = readClaim(runtimeDir, requestId);

  const path = join(runtimeDir, "journal", `${requestId}.signed.json`);

  const record = JSON.parse(
    readFileSync(path, "utf8")
  ) as PreparedPaymentRecord;

  // 1. Reject a malformed or mismatched journal entry.
  assert.equal(record.version, 1);
  assert.equal(record.status, "prepared");
  assert.equal(record.requestId, requestId);
  assert.equal(record.network, claim.network);

  assert.equal(record.approvalDigest, claim.approvalDigest);

  assert.equal(record.agent, claim.agent);
  assert.equal(record.amountBaseUnits, claim.amountBaseUnits);

  // 2. Restore the exact serialized transaction.
  const raw = Buffer.from(record.rawTransactionBase64, "base64");

  assert.equal(
    raw.toString("base64"),
    record.rawTransactionBase64,
    "Malformed transaction encoding"
  );

  assert.equal(
    sha256(raw),
    record.transactionSha256,
    "Stored transaction digest mismatch"
  );

  const transaction = Transaction.from(raw);

  // 3. Verify the cryptographic transaction signature.
  assert.ok(
    transaction.verifySignatures(),
    "Stored transaction signature is invalid"
  );

  assert.equal(transaction.signatures.length, 1);

  const authority = new PublicKey(record.agentAuthority);

  assert.ok(
    transaction.feePayer?.equals(authority),
    "Stored transaction fee payer mismatch"
  );

  assert.ok(
    transaction.signatures[0].publicKey.equals(authority),
    "Stored signer mismatch"
  );

  assert.equal(transaction.recentBlockhash, record.recentBlockhash);

  assert.equal(
    Buffer.from(transaction.signature!).toString("base64"),
    record.signatureBase64
  );

  return { record, transaction, raw };
}
