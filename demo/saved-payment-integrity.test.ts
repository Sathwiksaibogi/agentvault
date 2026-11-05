import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as nacl from "tweetnacl";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";

import {
  encodeWorkflow,
  type WorkflowApproval,
} from "./signed-workflow";

import { claimApprovedWorkflow } from "./request-journal";
import { prepareSignedPayment } from "./prepared-payment";
import {
  verifySavedPaymentIntegrity,
  type SavedPaymentState,
} from "./saved-payment-integrity";

const owner = Keypair.generate();
const agent = Keypair.generate();
const recipient = Keypair.generate();
const vault = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;

const idl = JSON.parse(
  readFileSync(
    join(process.cwd(), "target/idl/agentvault.json"),
    "utf8"
  )
) as Agentvault;

const program = new anchor.Program<Agentvault>(idl, {
  connection: new Connection("http://127.0.0.1:8899"),
});

const state: SavedPaymentState = {
  network: "devnet",
  genesisHash: Keypair.generate().publicKey.toBase58(),
  programId: program.programId.toBase58(),
  vault: vault.toBase58(),
  owner: owner.publicKey.toBase58(),
  mint: mint.toBase58(),
  treasury: treasury.toBase58(),
};

const workflow: WorkflowApproval = {
  version: 1,
  network: "devnet",
  requestId: "integrity-test-001",
  genesisHash: state.genesisHash,
  programId: state.programId,
  vault: state.vault,
  owner: state.owner,
  mint: state.mint,
  assignedAgent: "agent-a",
  agentAuthority: agent.publicKey.toBase58(),
  kind: "procurement",
  taskId: 1,
  recipient: recipient.publicKey.toBase58(),
  amountBaseUnits: 10000,
  expiresAtUnix: 2000000000,
  description: "Purchase approved equipment",
};

function sign(data: WorkflowApproval = workflow) {
  return {
    workflow: data,
    signature: Buffer.from(
      nacl.sign.detached(
        encodeWorkflow(data),
        owner.secretKey
      )
    ).toString("base64"),
  };
}

let dir: string;

const approvalPath = () =>
  join(dir, "approvals", `${workflow.requestId}.json`);

const claimPath = () =>
  join(dir, "journal", `${workflow.requestId}.json`);

const preparedPath = () =>
  join(dir, "journal", `${workflow.requestId}.signed.json`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentvault-integrity-"));
  mkdirSync(join(dir, "approvals"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function createFixture() {
  const signed = sign();

  writeFileSync(approvalPath(), JSON.stringify(signed));

  claimApprovedWorkflow(
    dir,
    signed,
    state,
    Math.floor(Date.now() / 1000)
  );

  const [agentPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent"),
      vault.toBuffer(),
      agent.publicKey.toBuffer(),
    ],
    program.programId
  );

  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      new BN(workflow.taskId).toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient.publicKey
  );

  const paymentInstruction = await program.methods
    .executeTaskPayment(
      new BN(workflow.amountBaseUnits),
      new BN(1)
    )
    .accountsPartial({
      agentAuthority: agent.publicKey,
      vault,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient: recipient.publicKey,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const transaction = new Transaction({
    feePayer: agent.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      agent.publicKey,
      recipientAta,
      recipient.publicKey,
      mint
    ),
    paymentInstruction
  );

  transaction.sign(agent);

  prepareSignedPayment(
    dir,
    workflow.requestId,
    workflow.assignedAgent,
    agent.publicKey,
    taskPda,
    workflow.amountBaseUnits,
    "1",
    123456,
    transaction
  );
}

async function verify() {
  return verifySavedPaymentIntegrity(
    dir,
    workflow.requestId,
    state,
    program
  );
}

function modifyJson(
  path: string,
  update: (data: any) => void
) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  update(data);
  writeFileSync(path, JSON.stringify(data));
}

test("accepts the exact owner-approved saved payment", async () => {
  await createFixture();

  const result = await verify();

  assert.equal(result.requestId, workflow.requestId);
  assert.equal(result.recipient, workflow.recipient);
  assert.equal(result.amountBaseUnits, workflow.amountBaseUnits);
  assert.equal(result.nonce, "1");
  assert.ok(result.signature.length > 0);
});

test("rejects a substituted valid owner approval", async () => {
  await createFixture();

  const changed = sign({
    ...workflow,
    recipient: Keypair.generate().publicKey.toBase58(),
  });

  writeFileSync(approvalPath(), JSON.stringify(changed));

  await assert.rejects(
    verify(),
    /Approval digest mismatch/
  );
});

test("rejects a modified journal approval digest", async () => {
  await createFixture();

  modifyJson(claimPath(), (claim) => {
    claim.approvalDigest = "0".repeat(64);
  });

  await assert.rejects(verify());
});

test("rejects a mismatched prepared task PDA", async () => {
  await createFixture();

  modifyJson(preparedPath(), (record) => {
    record.taskPda = Keypair.generate().publicKey.toBase58();
  });

  await assert.rejects(
    verify(),
    /Prepared payment task PDA mismatch/
  );
});

test("rejects a mismatched prepared agent authority", async () => {
  await createFixture();

  modifyJson(preparedPath(), (record) => {
    record.agentAuthority =
      Keypair.generate().publicKey.toBase58();
  });

  await assert.rejects(verify());
});

test("rejects corrupted serialized transaction bytes", async () => {
  await createFixture();

  modifyJson(preparedPath(), (record) => {
    record.rawTransactionBase64 =
      Buffer.from("corrupted").toString("base64");
  });

  await assert.rejects(verify());
});

test("rejects a journal recipient inconsistent with approval", async () => {
  await createFixture();

  modifyJson(claimPath(), (claim) => {
    claim.recipient =
      Keypair.generate().publicKey.toBase58();
  });

  await assert.rejects(verify());
});