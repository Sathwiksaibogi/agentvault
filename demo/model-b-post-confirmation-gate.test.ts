import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  verifyModelBPostConfirmation,
  type ModelBEvaluatedContext,
} from "./model-b-post-confirmation-gate";
import type { ModelBOwnerPolicySnapshot } from "./model-b-owner-policy";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-post-confirm-"));
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const address = () => Keypair.generate().publicKey;
  const vault = address();
  const mint = address();
  const recipient = address();
  const genesisHash = address().toBase58();
  const nowUnix = 1_800_000_000;
  const requestId = "modelb-post-confirm-001";
  const taskId = 7;
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(taskId));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agent.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId,
    genesisHash,
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agent.publicKey.toBase58(),
    kind: "procurement",
    taskId,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Owner-approved infrastructure purchase",
  };
  const payment: PaymentApprovalV2 = {
    version: 2,
    genesisHash,
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
    requestId,
  };
  const scope = {
    network: workflow.network,
    genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };
  const contextForSignature = {
    scope,
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };
  const approvals = signModelBOwnerApprovalPackage(
    workflow,
    payment,
    owner,
    contextForSignature
  );
  const binding = { ...contextForSignature, ...approvals };
  const snapshot = {
    nowUnix,
    recipient: workflow.recipient,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    budget: "5000",
    spent: "0",
    remaining: "5000",
    totalReserved: "5000",
    treasuryBalance: "5000",
  } as ModelBOwnerPolicySnapshot;

  let nextSnapshot = { ...snapshot };
  let returnedGenesis = genesisHash;
  let height = 120;
  const blockhash = address().toBase58();
  const claimPath = join(runtimeDir, "journal", `${requestId}.json`);
  let onFetchBlockhash = () => {};
  const context = {
    workflow,
    binding,
    policySnapshot: snapshot,
    readLivePolicy: async () => nextSnapshot,
    connection: {
      getGenesisHash: async () => returnedGenesis,
      getLatestBlockhash: async () => {
        onFetchBlockhash();
        return { blockhash, lastValidBlockHeight: 150 };
      },
      getBlockHeight: async () => height,
    },
  } as unknown as ModelBEvaluatedContext;

  return {
    runtimeDir,
    requestId,
    workflow,
    binding,
    blockhash,
    claimPath,
    context,
    snapshot,
    setSnapshot: (changes: Partial<ModelBOwnerPolicySnapshot>) => {
      nextSnapshot = { ...snapshot, ...changes };
    },
    setGenesis: (value: string) => {
      returnedGenesis = value;
    },
    setHeight: (value: number) => {
      height = value;
    },
    setBlockhashHook: (fn: () => void) => {
      onFetchBlockhash = fn;
    },
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

test("rechecks an unchanged Model B policy after human confirmation", async () => {
  await withFixture(async (f) => {
    f.setSnapshot({ nowUnix: f.snapshot.nowUnix + 30 });
    const ready = await verifyModelBPostConfirmation(f.runtimeDir, f.context);
    assert.equal(ready.blockhash, f.blockhash);
    assert.equal(ready.lastValidBlockHeight, 150);
    assert.equal(ready.observedBlockHeight, 120);
    assert.equal(ready.binding.nowUnix, f.snapshot.nowUnix + 30);
    assert.equal(ready.binding.nextNonce, "0");
    assert.equal(existsSync(f.claimPath), false);
  });
});

test("rejects a recipient changed during human confirmation", async () => {
  await withFixture(async (f) => {
    f.setSnapshot({ recipient: Keypair.generate().publicKey.toBase58() });
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /recipient/
    );
  });
});

test("rejects a nonce spent during human confirmation", async () => {
  await withFixture(async (f) => {
    f.setSnapshot({ nextNonce: "1" });
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /nonce|nextNonce/i
    );
  });
});

test("rejects a budget or treasury change during human confirmation", async () => {
  await withFixture(async (f) => {
    f.setSnapshot({ treasuryBalance: "4999" });
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /treasury|balance|changed/i
    );
  });
});

test("rejects an owner payment approval expired during confirmation", async () => {
  await withFixture(async (f) => {
    f.setSnapshot({ nowUnix: f.snapshot.nowUnix + 1201 });
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /expired|expiry|time/i
    );
  });
});

test("rejects an RPC ledger switch", async () => {
  await withFixture(async (f) => {
    f.setGenesis(Keypair.generate().publicKey.toBase58());
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /RPC ledger changed/
    );
  });
});

test("rejects a blockhash already past its valid block height", async () => {
  await withFixture(async (f) => {
    f.setHeight(151);
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /blockhash already expired/
    );
  });
});

test("rejects a claimed request before any live reads", async () => {
  await withFixture(async (f) => {
    mkdirSync(join(f.runtimeDir, "journal"), { recursive: true });
    writeFileSync(f.claimPath, "claimed");
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /already claimed/
    );
  });
});

test("rejects a claim written during the RPC blockhash fetch", async () => {
  await withFixture(async (f) => {
    f.setBlockhashHook(() => {
      mkdirSync(join(f.runtimeDir, "journal"), { recursive: true });
      writeFileSync(f.claimPath, "claimed");
    });
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /claimed during post-confirmation/
    );
  });
});

test("rejects a forged owner payment signature after confirmation", async () => {
  await withFixture(async (f) => {
    f.context.binding.signatureBase64 = Buffer.alloc(64, 9).toString("base64");
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /Invalid Model B owner signature/
    );
    assert.equal(existsSync(f.claimPath), false);
  });
});

test("rejects an evaluator workflow that differs from the owner-signed workflow", async () => {
  await withFixture(async (f) => {
    f.context.workflow = {
      ...f.context.workflow,
      description: "Unsigned replacement purpose",
    };
    await assert.rejects(
      verifyModelBPostConfirmation(f.runtimeDir, f.context),
      /evaluator workflow differs/
    );
    assert.equal(existsSync(f.claimPath), false);
  });
});
