import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  coordinateModelBExecution,
  type ModelBExecutionServices,
} from "./model-b-execution-coordinator";
import type { ModelBEvaluatedContext } from "./model-b-post-confirmation-gate";
import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

function fixture() {
  const runtimeDir = mkdtempSync(
    join(tmpdir(), "agentvault-model-b-coordinator-")
  );
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(BigInt(7));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), idBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-coordinator-001",
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
    description: "Owner-approved infrastructure purchase",
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
  const signingContext = {
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
    signingContext
  );
  const binding: ModelBWorkflowBinding = { ...signingContext, ...signed };
  const context = {
    workflow,
    binding,
    connection: {},
  } as unknown as ModelBEvaluatedContext;
  const blockhash = key().toBase58();
  const height = 150;
  const trace: string[] = [];
  const journalPath = join(runtimeDir, "journal", `${workflow.requestId}.json`);
  const signedPath = join(
    runtimeDir,
    "journal",
    `${workflow.requestId}.signed.json`
  );
  const environment = { network: "devnet", interactive: true };
  const services: ModelBExecutionServices = {
    async askForConfirmation(expected) {
      trace.push("confirm");
      return expected;
    },
    async verifyAfterConfirmation(_runtimeDir, _context) {
      trace.push("revalidate");
      return {
        binding: { ...binding, nowUnix: binding.nowUnix + 1 },
        blockhash,
        lastValidBlockHeight: height,
        observedBlockHeight: 100,
      };
    },
    loadAgentSigner(agent) {
      trace.push("load-agent");
      assert.equal(agent, "agent-a");
      return agentSigner;
    },
    prepareDurablePayment(dir, fresh, signer, hash, lastValidBlockHeight) {
      trace.push("prepare");
      return prepareDurableModelBPayment(
        dir,
        fresh,
        signer,
        hash,
        lastValidBlockHeight
      );
    },
    async submitStoredPayment(dir, fresh, prepared, _rpc) {
      trace.push("submit");
      assert.equal(prepared.requestId, workflow.requestId);
      assert.ok(existsSync(journalPath));
      assert.ok(existsSync(signedPath));
      const restored = loadPreparedModelBPayment(
        dir,
        workflow.requestId,
        fresh.signedWorkflow,
        fresh.scope
      );
      assert.deepEqual(prepared.rawTransaction, restored.raw);
      return { signature: prepared.signature, status: "confirmed" };
    },
  };
  return {
    runtimeDir,
    workflow,
    binding,
    context,
    agentSigner,
    trace,
    journalPath,
    signedPath,
    environment,
    services,
  };
}

async function withFixture(
  fn: (f: ReturnType<typeof fixture>) => Promise<void>
): Promise<void> {
  const f = fixture();
  try {
    await fn(f);
  } finally {
    rmSync(f.runtimeDir, { recursive: true, force: true });
  }
}

async function run(f: ReturnType<typeof fixture>) {
  return coordinateModelBExecution(
    f.runtimeDir,
    f.context,
    f.environment,
    f.services
  );
}

test("coordinates confirmation, revalidation, agent signing and exact saved bytes in order", async () => {
  await withFixture(async (f) => {
    const result = await run(f);
    assert.equal(result.requestId, f.workflow.requestId);
    assert.equal(result.status, "confirmed");
    assert.ok(result.signature.length > 0);
    assert.deepEqual(f.trace, [
      "confirm",
      "revalidate",
      "load-agent",
      "prepare",
      "submit",
    ]);
    const claim = JSON.parse(readFileSync(f.journalPath, "utf8"));
    assert.equal(claim.authorizationModel, "model-b");
    assert.equal(claim.status, "claimed");
  });
});

test("rejects localnet execution before confirmation and key loading", async () => {
  await withFixture(async (f) => {
    f.environment.network = "localnet";
    await assert.rejects(run(f), /Devnet-only/);
    assert.deepEqual(f.trace, []);
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects execution without interactive terminal before key loading", async () => {
  await withFixture(async (f) => {
    f.environment.interactive = false;
    await assert.rejects(run(f), /requires a terminal/);
    assert.deepEqual(f.trace, []);
  });
});

test("rejects a mismatched approval network before confirmation", async () => {
  await withFixture(async (f) => {
    f.context.binding.scope.network = "localnet";
    await assert.rejects(run(f), /owner scope must be Devnet/);
    assert.deepEqual(f.trace, []);
  });
});

test("rejects tampered evaluator workflow before confirmation", async () => {
  await withFixture(async (f) => {
    f.context.workflow.description = "Replacement for a different purchase";
    await assert.rejects(run(f), /evaluator workflow mismatch/);
    assert.deepEqual(f.trace, []);
  });
});

test("a denied confirmation never fetches policy or loads the agent key", async () => {
  await withFixture(async (f) => {
    f.services.askForConfirmation = async () => {
      f.trace.push("confirm");
      return "NO";
    };
    await assert.rejects(run(f), /execution cancelled/);
    assert.deepEqual(f.trace, ["confirm"]);
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("a failed post-confirmation policy check never loads agent key", async () => {
  await withFixture(async (f) => {
    f.services.verifyAfterConfirmation = async () => {
      f.trace.push("revalidate");
      throw new Error("Task nonce changed before signing");
    };
    await assert.rejects(run(f), /nonce changed/);
    assert.deepEqual(f.trace, ["confirm", "revalidate"]);
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects approval substitution in post-confirmation gate before key access", async () => {
  await withFixture(async (f) => {
    const original = f.services.verifyAfterConfirmation;
    f.services.verifyAfterConfirmation = async (dir, ctx) => {
      const fresh = await original(dir, ctx);
      return {
        ...fresh,
        binding: { ...fresh.binding, signatureBase64: "fake" },
      };
    };
    await assert.rejects(
      run(f),
      /strictEqual|Expected values to be strictly equal/
    );
    assert.deepEqual(f.trace, ["confirm", "revalidate"]);
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects an agent key that is not the owner-approved authority", async () => {
  await withFixture(async (f) => {
    f.services.loadAgentSigner = () => {
      f.trace.push("load-agent");
      return Keypair.generate();
    };
    await assert.rejects(run(f), /assigned agent key mismatch/);
    assert.deepEqual(f.trace, ["confirm", "revalidate", "load-agent"]);
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("a preparation error never invokes submission", async () => {
  await withFixture(async (f) => {
    f.services.prepareDurablePayment = () => {
      f.trace.push("prepare");
      throw new Error("Persistence failure");
    };
    await assert.rejects(run(f), /Persistence failure/);
    assert.deepEqual(f.trace, [
      "confirm",
      "revalidate",
      "load-agent",
      "prepare",
    ]);
  });
});

test("a submission error never retries signing or submission and keeps the claim", async () => {
  await withFixture(async (f) => {
    f.services.submitStoredPayment = async () => {
      f.trace.push("submit");
      throw new Error("Ambiguous RPC outcome");
    };
    await assert.rejects(run(f), /Ambiguous RPC outcome/);
    assert.deepEqual(f.trace, [
      "confirm",
      "revalidate",
      "load-agent",
      "prepare",
      "submit",
    ]);
    assert.equal(existsSync(f.journalPath), true);
    assert.equal(existsSync(f.signedPath), true);
  });
});

test("repeating a claimed request fails before confirmation and never replaces bytes", async () => {
  await withFixture(async (f) => {
    await run(f);
    const original = readFileSync(f.signedPath);
    f.trace.length = 0;
    await assert.rejects(run(f), /already claimed/);
    assert.deepEqual(f.trace, []);
    assert.deepEqual(readFileSync(f.signedPath), original);
  });
});

test("rejects backward-moving chain time before signer access", async () => {
  await withFixture(async (f) => {
    const original = f.services.verifyAfterConfirmation;
    f.services.verifyAfterConfirmation = async (dir, ctx) => {
      const fresh = await original(dir, ctx);
      return {
        ...fresh,
        binding: { ...fresh.binding, nowUnix: fresh.binding.nowUnix - 50 },
      };
    };
    await assert.rejects(run(f), /clock went backwards/);
    assert.deepEqual(f.trace, ["confirm", "revalidate"]);
    assert.equal(existsSync(f.journalPath), false);
  });
});
