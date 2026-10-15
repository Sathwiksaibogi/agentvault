import test from "node:test";
import assert from "node:assert/strict";

import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  AGENTVAULT_PROGRAM_ID,
  assertExactAgentVaultPayment,
} from "./payment-transaction-guard";

const agent = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

const recipientAta = getAssociatedTokenAddressSync(
  mint,
  recipient,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);

// Mock payment instruction for offline structural testing.
// The real executor will create this using Anchor's IDL.
const payment = new TransactionInstruction({
  programId: AGENTVAULT_PROGRAM_ID,
  keys: [
    {
      pubkey: agent.publicKey,
      isSigner: true,
      isWritable: true,
    },
    {
      pubkey: mint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: recipient,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: recipientAta,
      isSigner: false,
      isWritable: true,
    },
  ],
  data: Buffer.from([1, 2, 3, 4]),
});

const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
  agent.publicKey,
  recipientAta,
  recipient,
  mint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);

function buildTransaction(
  instructions: TransactionInstruction[] = [ataInstruction, payment]
): Transaction {
  const transaction = new Transaction({
    feePayer: agent.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });

  transaction.add(...instructions);
  transaction.sign(agent);

  return transaction;
}

function validate(transaction: Transaction) {
  return assertExactAgentVaultPayment(transaction, {
    agentAuthority: agent.publicKey,
    recipient,
    mint,
    paymentInstruction: payment,
  });
}

test("accepts the exact signed payment structure", () => {
  assert.doesNotThrow(() => validate(buildTransaction()));
});

test("rejects additional SOL transfer instructions", () => {
  const extraTransfer = SystemProgram.transfer({
    fromPubkey: agent.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });

  assert.throws(
    () => validate(buildTransaction([ataInstruction, payment, extraTransfer])),
    /exactly two instructions/
  );
});

test("rejects changed payment instruction data", () => {
  const modified = new TransactionInstruction({
    programId: payment.programId,
    keys: payment.keys,
    data: Buffer.from([1, 2, 3, 9]),
  });

  assert.throws(
    () => validate(buildTransaction([ataInstruction, modified])),
    /instruction data mismatch/
  );
});

test("rejects changed payment account addresses", () => {
  const modified = new TransactionInstruction({
    programId: payment.programId,
    keys: payment.keys.map((key, index) =>
      index === 2
        ? {
            ...key,
            pubkey: Keypair.generate().publicKey,
          }
        : key
    ),
    data: payment.data,
  });

  assert.throws(
    () => validate(buildTransaction([ataInstruction, modified])),
    /address mismatch/
  );
});

test("rejects modified account permissions", () => {
  const modified = new TransactionInstruction({
    programId: payment.programId,
    keys: payment.keys.map((key, index) =>
      index === 2 ? { ...key, isWritable: true } : key
    ),
    data: payment.data,
  });

  assert.throws(
    () => validate(buildTransaction([ataInstruction, modified])),
    /writable flag mismatch/
  );
});

test("rejects reordered instructions", () => {
  assert.throws(() => validate(buildTransaction([payment, ataInstruction])));
});

test("rejects an unexpected fee payer", () => {
  const transaction = buildTransaction();

  transaction.feePayer = Keypair.generate().publicKey;

  assert.throws(() => validate(transaction), /Incorrect agent fee payer/);
});

test("rejects unsigned transactions", () => {
  const transaction = new Transaction({
    feePayer: agent.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });

  transaction.add(ataInstruction, payment);

  assert.throws(() => validate(transaction), /exactly one transaction signer/);
});
