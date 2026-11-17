import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { resolveModelBAiDecision } from "./model-b-ai-decision-cache";

import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";

import type { WorkflowApprovalV2 } from "./signed-workflow-v2";

import type { PaymentApprovalV2 } from "./payment-approval-v2";

import type { AiProposal } from "./workflow-policy";

type BindingContext = Omit<
  ModelBWorkflowBinding,
  "signedWorkflow" | "paymentApproval" | "signatureBase64"
>;

const KEY = randomBytes(32).toString("hex");

function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-model-b-ai-"));

  const owner = Keypair.generate();
  const authority = Keypair.generate();
  const key = () => Keypair.generate().publicKey;

  const programId = key();
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.publicKey.toBuffer()],
    programId
  );

  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(7));

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    programId
  );

  const nowUnix = 1_800_000_000;

  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-cache-001",
    genesisHash: genesisHash.toBase58(),
    programId: programId.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: authority.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 7200,
    description: "Approved infrastructure purchase",
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
    expiresAtUnix: String(nowUnix + 3600),
    requestId: workflow.requestId,
  };

  const context: BindingContext = {
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
    taskExpiresAtUnix: String(nowUnix + 8000),
    nowUnix,
  };

  function sign(w = workflow, p = payment, c = context): ModelBWorkflowBinding {
    const approval = signModelBOwnerApprovalPackage(w, p, owner, c);

    return {
      ...c,
      ...approval,
    };
  }

  const proposal: AiProposal = {
    decision: "PAY",
    amountBaseUnits: 1000,
    reason: "Purchase meets procurement policy",
  };

  const binding = sign();

  const cachePath = join(
    runtimeDir,
    "ai-decisions",
    `${workflow.requestId}.model-b.json`
  );

  async function resolve(
    selectedBinding: ModelBWorkflowBinding = binding,
    evaluate: () => Promise<AiProposal> = async () => proposal,
    secret = KEY
  ) {
    return resolveModelBAiDecision(
      runtimeDir,
      selectedBinding,
      secret,
      evaluate
    );
  }

  return {
    runtimeDir,
    workflow,
    payment,
    context,
    binding,
    proposal,
    cachePath,
    sign,
    resolve,
  };
}

async function withFixture(
  run: (f: ReturnType<typeof fixture>) => Promise<void>
): Promise<void> {
  const f = fixture();

  try {
    await run(f);
  } finally {
    rmSync(f.runtimeDir, {
      recursive: true,
      force: true,
    });
  }
}

test("evaluates once and reuses only the exact Model B receipt", async () => {
  await withFixture(async (f) => {
    let calls = 0;

    const first = await f.resolve(f.binding, async () => {
      calls++;
      return f.proposal;
    });

    const second = await f.resolve(f.binding, async () => {
      calls++;
      throw new Error("Gemini must not run twice");
    });

    assert.equal(first.source, "gemini");
    assert.equal(second.source, "cache");
    assert.equal(calls, 1);
    assert.deepEqual(second.proposal, f.proposal);
    assert.equal(existsSync(f.cachePath), true);

    assert.equal(
      existsSync(
        join(f.runtimeDir, "ai-decisions", `${f.workflow.requestId}.json`)
      ),
      false
    );
  });
});

test("rejects a separately signed different workflow", async () => {
  await withFixture(async (f) => {
    await f.resolve();

    const changed = {
      ...f.workflow,
      description: "Another owner-approved purchase",
    };

    const binding = f.sign(changed, f.payment, f.context);

    let calls = 0;

    await assert.rejects(
      f.resolve(binding, async () => {
        calls++;
        return f.proposal;
      }),
      /Model B AI workflow digest mismatch/
    );

    assert.equal(calls, 0);
  });
});

test("rejects a newly signed payment with a different nonce", async () => {
  await withFixture(async (f) => {
    await f.resolve();

    const changedPayment = {
      ...f.payment,
      nonce: "1",
    };

    const changedContext = {
      ...f.context,
      nextNonce: "1",
    };

    const binding = f.sign(f.workflow, changedPayment, changedContext);

    await assert.rejects(
      f.resolve(binding),
      /Model B AI payment digest mismatch/
    );
  });
});

test("detects a tampered AI receipt", async () => {
  await withFixture(async (f) => {
    await f.resolve();

    const receipt = JSON.parse(readFileSync(f.cachePath, "utf8"));

    receipt.proposal.reason = "Attacker-modified reason";

    writeFileSync(f.cachePath, JSON.stringify(receipt));

    await assert.rejects(f.resolve(), /Model B AI receipt MAC mismatch/);
  });
});

test("rejects expired AI receipts without invoking Gemini", async () => {
  await withFixture(async (f) => {
    await f.resolve();

    const later = {
      ...f.binding,
      nowUnix: f.context.nowUnix + 901,
    };

    let calls = 0;

    await assert.rejects(
      f.resolve(later, async () => {
        calls++;
        return f.proposal;
      }),
      /Model B AI receipt expired/
    );

    assert.equal(calls, 0);
  });
});

test("never caches a rejected Gemini proposal", async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      f.resolve(f.binding, async () => ({
        decision: "REJECT",
        amountBaseUnits: 0,
        reason: "Not justified",
      }))
    );

    assert.equal(existsSync(f.cachePath), false);
  });
});

test("Gemini failures never create an AI receipt", async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      f.resolve(f.binding, async () => {
        throw new Error("Gemini unavailable");
      }),
      /Gemini unavailable/
    );

    assert.equal(existsSync(f.cachePath), false);
  });
});

test("rejects a forged Model B owner signature", async () => {
  await withFixture(async (f) => {
    const forged = {
      ...f.binding,
      signatureBase64: Buffer.alloc(64, 3).toString("base64"),
    };

    let calls = 0;

    await assert.rejects(
      f.resolve(forged, async () => {
        calls++;
        return f.proposal;
      }),
      /Invalid Model B owner signature/
    );

    assert.equal(calls, 0);
    assert.equal(existsSync(f.cachePath), false);
  });
});

test("rejects an existing Model A receipt with the same request ID", async () => {
  await withFixture(async (f) => {
    const directory = join(f.runtimeDir, "ai-decisions");

    mkdirSync(directory, { recursive: true });

    writeFileSync(
      join(directory, `${f.workflow.requestId}.json`),
      '{"version":1}'
    );

    await assert.rejects(
      f.resolve(),
      /Model A AI receipt already uses this request ID/
    );

    assert.equal(existsSync(f.cachePath), false);
  });
});

test("rejects a previously claimed request", async () => {
  await withFixture(async (f) => {
    const directory = join(f.runtimeDir, "journal");

    mkdirSync(directory, { recursive: true });

    writeFileSync(
      join(directory, `${f.workflow.requestId}.json`),
      '{"status":"claimed"}'
    );

    await assert.rejects(f.resolve(), /Request already claimed/);

    assert.equal(existsSync(f.cachePath), false);
  });
});

test("rejects a different AI receipt authentication key", async () => {
  await withFixture(async (f) => {
    await f.resolve();

    await assert.rejects(
      f.resolve(
        f.binding,
        async () => f.proposal,
        randomBytes(32).toString("hex")
      ),
      /Model B AI receipt MAC mismatch/
    );
  });
});

test("rejects weak AI receipt authentication keys", async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      f.resolve(f.binding, async () => f.proposal, "1234"),
      /32 random bytes in hex/
    );

    assert.equal(existsSync(f.cachePath), false);
  });
});
