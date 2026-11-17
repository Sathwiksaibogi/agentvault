import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  inspectModelBRecovery,
  type ModelBRecoveryRpc,
} from "./model-b-read-only-recovery";
import type { PaymentApprovalV2 } from "./payment-approval-v2";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";

function makeFixture() {
  const runtimeDir = mkdtempSync(
    join(tmpdir(), "agentvault-model-b-recovery-")
  );
  const pubkey = () => Keypair.generate().publicKey;
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const vault = pubkey();
  const mint = pubkey();
  const recipient = pubkey();
  const genesisHash = pubkey().toBase58();
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(7));
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-recover-001",
    genesisHash,
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
    description: "Owner-approved recovery verification",
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
  const scope = {
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };
  const binding = {
    ...signModelBOwnerApprovalPackage(workflow, payment, owner, {
      scope,
      agentPda,
      approvedTaskPda,
      nextNonce: "0",
      taskExpiresAtUnix: String(nowUnix + 7200),
      nowUnix,
    }),
    scope,
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };
  const prepared = prepareDurableModelBPayment(
    runtimeDir,
    binding,
    agentSigner,
    pubkey().toBase58(),
    150
  );
  const approvalsDir = join(runtimeDir, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const approvalPath = join(approvalsDir, `${workflow.requestId}.json`);
  writeFileSync(approvalPath, JSON.stringify(binding.signedWorkflow, null, 2));
  const claimPath = join(runtimeDir, "journal", `${workflow.requestId}.json`);
  const signedPath = join(
    runtimeDir,
    "journal",
    `${workflow.requestId}.signed.json`
  );

  const files = [approvalPath, claimPath, signedPath];
  const before = files.map((path) => readFileSync(path));
  const journalEntries = readdirSync(join(runtimeDir, "journal")).sort();

  function assertUnchanged() {
    files.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
    assert.deepEqual(
      readdirSync(join(runtimeDir, "journal")).sort(),
      journalEntries
    );
  }

  return {
    runtimeDir,
    workflow,
    scope,
    prepared,
    claimPath,
    signedPath,
    approvalPath,
    assertUnchanged,
  };
}

type Fixture = ReturnType<typeof makeFixture>;

async function usingFixture(
  run: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const fixture = makeFixture();
  try {
    await run(fixture);
    fixture.assertUnchanged();
  } finally {
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
}

function mockRpc(f: Fixture) {
  let genesis = f.scope.genesisHash;
  let nextGenesis: string | undefined;
  let height = 100;
  let status: unknown = {
    confirmationStatus: "confirmed",
    confirmations: 1,
    err: null,
    slot: 12,
    status: { Ok: null },
  };
  const calls = { genesis: 0, status: 0, height: 0 };
  let lastQuery: string[] = [];
  let searchHistory = false;
  const rpc = {
    async getGenesisHash() {
      calls.genesis++;
      return nextGenesis && calls.genesis > 1 ? nextGenesis : genesis;
    },
    async getSignatureStatuses(
      signatures: string[],
      options: { searchTransactionHistory?: boolean }
    ) {
      calls.status++;
      lastQuery = [...signatures];
      searchHistory = options.searchTransactionHistory === true;
      return { value: [status] };
    },
    async getBlockHeight() {
      calls.height++;
      return height;
    },
  } as unknown as ModelBRecoveryRpc;
  return {
    rpc,
    calls,
    setGenesis(value: string) {
      genesis = value;
    },
    switchGenesis(value: string) {
      nextGenesis = value;
    },
    setHeight(value: number) {
      height = value;
    },
    setStatus(value: unknown) {
      status = value;
    },
    get lastQuery() {
      return lastQuery;
    },
    get searchHistory() {
      return searchHistory;
    },
  };
}

test("recovers confirmed original Model B bytes and signature without any mutation", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    const result = await inspectModelBRecovery(
      f.runtimeDir,
      f.workflow.requestId,
      f.scope,
      mock.rpc
    );
    assert.equal(result.recoveryState, "CONFIRMED");
    assert.equal(result.signature, f.prepared.signature);
    assert.equal(result.savedBytes, f.prepared.rawTransaction.length);
    assert.equal(result.amountBaseUnits, 1000);
    assert.equal(result.nonce, "0");
    assert.equal(result.lastValidBlockHeight, 150);
    assert.deepEqual(mock.lastQuery, [f.prepared.signature]);
    assert.equal(mock.searchHistory, true);
    assert.deepEqual(mock.calls, { genesis: 2, status: 1, height: 1 });
  });
});

test("unobserved unexpired transaction remains pending and journal stays locked", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setStatus(null);
    assert.equal(
      (
        await inspectModelBRecovery(
          f.runtimeDir,
          f.workflow.requestId,
          f.scope,
          mock.rpc
        )
      ).recoveryState,
      "PENDING"
    );
  });
});

test("unobserved expired transaction remains unresolved, never safely replaced", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setStatus(null);
    mock.setHeight(151);
    assert.equal(
      (
        await inspectModelBRecovery(
          f.runtimeDir,
          f.workflow.requestId,
          f.scope,
          mock.rpc
        )
      ).recoveryState,
      "EXPIRED_UNRESOLVED"
    );
  });
});

test("observed confirmed on-chain error is classified as failed", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setStatus({
      confirmationStatus: "confirmed",
      confirmations: 1,
      err: { InstructionError: [2, "Custom"] },
      slot: 12,
      status: { Err: { InstructionError: [2, "Custom"] } },
    });
    assert.equal(
      (
        await inspectModelBRecovery(
          f.runtimeDir,
          f.workflow.requestId,
          f.scope,
          mock.rpc
        )
      ).recoveryState,
      "FAILED_ON_CHAIN"
    );
  });
});

test("processed-only observation is not mistaken for confirmed", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setStatus({
      confirmationStatus: "processed",
      confirmations: 0,
      err: null,
      slot: 12,
      status: { Ok: null },
    });
    assert.equal(
      (
        await inspectModelBRecovery(
          f.runtimeDir,
          f.workflow.requestId,
          f.scope,
          mock.rpc
        )
      ).recoveryState,
      "OBSERVED_UNCONFIRMED"
    );
  });
});

test("rejects the wrong RPC genesis before asking for a transaction status", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setGenesis(Keypair.generate().publicKey.toBase58());
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /Model B recovery RPC ledger mismatch/
    );
    assert.equal(mock.calls.status, 0);
  });
});

test("rejects an RPC ledger switch after the status response", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.switchGenesis(Keypair.generate().publicKey.toBase58());
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /Model B recovery RPC ledger changed/
    );
    assert.equal(mock.calls.status, 1);
  });
});

test("rejects a mismatched expected mint before contacting RPC", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        { ...f.scope, mint: Keypair.generate().publicKey.toBase58() },
        mock.rpc
      ),
      /Model B recovery mint mismatch/
    );
    assert.equal(mock.calls.genesis, 0);
  });
});

test("rejects a substituted v2 owner workflow before contacting RPC", async () => {
  await usingFixture(async (f) => {
    const approval = JSON.parse(readFileSync(f.approvalPath, "utf8"));
    const original = readFileSync(f.approvalPath);
    approval.workflow.description = "Attacker-selected new description";
    writeFileSync(f.approvalPath, JSON.stringify(approval));
    const mock = mockRpc(f);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      )
    );
    assert.equal(mock.calls.genesis, 0);
    writeFileSync(f.approvalPath, original);
  });
});

test("rejects corrupted signed bytes before contacting RPC", async () => {
  await usingFixture(async (f) => {
    const signed = JSON.parse(readFileSync(f.signedPath, "utf8"));
    const original = readFileSync(f.signedPath);
    const bytes = Buffer.from(signed.rawTransactionBase64, "base64");
    bytes[bytes.length - 1] ^= 1;
    signed.rawTransactionBase64 = bytes.toString("base64");
    writeFileSync(f.signedPath, JSON.stringify(signed));
    const mock = mockRpc(f);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /Stored Model B transaction digest mismatch/
    );
    assert.equal(mock.calls.genesis, 0);
    writeFileSync(f.signedPath, original);
  });
});

test("rejects a claim with a different authorization model", async () => {
  await usingFixture(async (f) => {
    const claim = JSON.parse(readFileSync(f.claimPath, "utf8"));
    const original = readFileSync(f.claimPath);
    claim.authorizationModel = "model-a";
    writeFileSync(f.claimPath, JSON.stringify(claim));
    const mock = mockRpc(f);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      )
    );
    assert.equal(mock.calls.genesis, 0);
    writeFileSync(f.claimPath, original);
  });
});

test("rejects impossible RPC block heights", async () => {
  await usingFixture(async (f) => {
    const mock = mockRpc(f);
    mock.setHeight(-1);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /Invalid Model B recovery block height/
    );
  });
});
