import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  submitSignedModelBPayment,
  type ModelBSubmissionRpc,
} from "./model-b-signed-submission";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-model-b-submit-"));
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();
  const taskBytes = Buffer.alloc(8);
  taskBytes.writeBigUInt64LE(BigInt(7));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-submit-001",
    genesisHash: genesisHash.toBase58(),
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agentSigner.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Owner approved infrastructure purchase",
  };
  const payment: PaymentApprovalV2 = {
    version: 2,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: agentPda.toBase58(),
    agentAuthority: workflow.agentAuthority,
    task: approvedTaskPda.toBase58(),
    recipient: workflow.recipient,
    amountBaseUnits: "1000",
    nonce: "0",
    expiresAtUnix: String(nowUnix + 1200),
    requestId: workflow.requestId,
  };
  const context = {
    scope: {
      network: workflow.network,
      genesisHash: workflow.genesisHash,
      programId: workflow.programId,
      vault: workflow.vault,
      owner: workflow.owner,
      mint: workflow.mint,
    },
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };
  const signed = signModelBOwnerApprovalPackage(
    workflow,
    payment,
    owner,
    context
  );
  const binding: ModelBWorkflowBinding = { ...context, ...signed };
  const blockhash = key().toBase58();
  const prepared = prepareDurableModelBPayment(
    runtimeDir,
    binding,
    agentSigner,
    blockhash,
    150
  );
  const journalPath = join(runtimeDir, "journal", `${workflow.requestId}.json`);
  return {
    runtimeDir,
    binding,
    prepared,
    journalPath,
    genesisHash: genesisHash.toBase58(),
  };
}

async function withFixture(
  run: (f: ReturnType<typeof fixture>) => Promise<void>
): Promise<void> {
  const f = fixture();
  try {
    await run(f);
  } finally {
    rmSync(f.runtimeDir, { recursive: true, force: true });
  }
}

function mockRpc(f: ReturnType<typeof fixture>) {
  const calls = { simulate: 0, send: 0, confirm: 0 };
  let currentHeight = 100;
  let currentGenesis = f.genesisHash;
  let simulationErr: unknown = null;
  let confirmationErr: unknown = null;
  let returnedSignature = f.prepared.signature;
  let rawSent = Buffer.alloc(0);
  let sigVerify = false;
  const rpc = {
    async getGenesisHash() {
      return currentGenesis;
    },
    async getBlockHeight() {
      return currentHeight;
    },
    async simulateTransaction(
      _transaction: unknown,
      options: { sigVerify?: boolean }
    ) {
      calls.simulate++;
      sigVerify = options.sigVerify === true;
      return { value: { err: simulationErr, logs: [] } };
    },
    async sendRawTransaction(raw: Buffer) {
      calls.send++;
      rawSent = Buffer.from(raw);
      return returnedSignature;
    },
    async confirmTransaction() {
      calls.confirm++;
      return { value: { err: confirmationErr } };
    },
  } as unknown as ModelBSubmissionRpc;
  return {
    rpc,
    calls,
    get rawSent() {
      return rawSent;
    },
    get sigVerify() {
      return sigVerify;
    },
    setHeight(value: number) {
      currentHeight = value;
    },
    setGenesis(value: string) {
      currentGenesis = value;
    },
    setSimulationErr(value: unknown) {
      simulationErr = value;
    },
    setConfirmationErr(value: unknown) {
      confirmationErr = value;
    },
    setReturnedSignature(value: string) {
      returnedSignature = value;
    },
  };
}

test("sends only the original journal bytes after signed simulation", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    const result = await submitSignedModelBPayment(
      f.runtimeDir,
      f.binding,
      f.prepared,
      mock.rpc
    );
    assert.equal(result.signature, f.prepared.signature);
    assert.equal(result.status, "confirmed");
    assert.equal(mock.calls.simulate, 1);
    assert.equal(mock.calls.send, 1);
    assert.equal(mock.calls.confirm, 1);
    assert.equal(mock.sigVerify, true);
    assert.deepEqual(mock.rawSent, f.prepared.rawTransaction);
    assert.equal(existsSync(f.journalPath), true);
  });
});

test("rejects a different RPC ledger without broadcasting", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setGenesis(Keypair.generate().publicKey.toBase58());
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, f.prepared, mock.rpc),
      /Model B RPC ledger changed/
    );
    assert.equal(mock.calls.send, 0);
  });
});

test("rejects an expired saved blockhash without broadcasting", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setHeight(f.prepared.lastValidBlockHeight + 1);
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, f.prepared, mock.rpc),
      /Model B prepared blockhash expired/
    );
    assert.equal(mock.calls.send, 0);
  });
});

test("rejects a failed signature-verified simulation", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setSimulationErr({ InstructionError: [2, "Custom"] });
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, f.prepared, mock.rpc),
      /Saved Model B payment simulation failed/
    );
    assert.equal(mock.calls.simulate, 1);
    assert.equal(mock.calls.send, 0);
    assert.equal(existsSync(f.journalPath), true);
  });
});

test("rejects a mutated caller buffer before sending", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    const mutated = {
      ...f.prepared,
      rawTransaction: Buffer.from(f.prepared.rawTransaction),
    };
    mutated.rawTransaction[10] ^= 0x01;
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, mutated, mock.rpc),
      /Prepared Model B bytes differ from durable journal/
    );
    assert.equal(mock.calls.send, 0);
  });
});

test("rejects a mismatched RPC-returned signature and preserves the claim", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setReturnedSignature(Keypair.generate().publicKey.toBase58());
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, f.prepared, mock.rpc),
      /Model B RPC signature mismatch/
    );
    assert.equal(mock.calls.send, 1);
    assert.equal(mock.calls.confirm, 0);
    assert.equal(existsSync(f.journalPath), true);
  });
});

test("rejects a failed on-chain confirmation and preserves the claim", async () => {
  await withFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setConfirmationErr({ InstructionError: [2, "Custom"] });
    await assert.rejects(
      submitSignedModelBPayment(f.runtimeDir, f.binding, f.prepared, mock.rpc),
      /Model B transaction failed on-chain/
    );
    assert.equal(mock.calls.send, 1);
    assert.equal(mock.calls.confirm, 1);
    assert.equal(existsSync(f.journalPath), true);
  });
});
