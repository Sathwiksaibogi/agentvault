import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import {
  encodeWorkflow,
  type ApprovalScope,
  type WorkflowApproval,
} from "./signed-workflow";

import {
  saveAiDecisionReceipt,
  loadAiDecisionReceipt,
} from "./ai-decision-receipt";

const owner = Keypair.generate();
const address = () => Keypair.generate().publicKey.toBase58();

const workflow: WorkflowApproval = {
  version: 1,
  network: "devnet",
  requestId: "procurement-005",
  genesisHash: address(),
  programId: address(),
  vault: address(),
  owner: owner.publicKey.toBase58(),
  mint: address(),
  assignedAgent: "agent-a",
  agentAuthority: address(),
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

const proposal = {
  decision: "PAY" as const,
  amountBaseUnits: 10000,
  reason: "Valid procurement equipment purchase",
};

const NOW = 1900000000;
const key = randomBytes(32).toString("hex");

function sign(data: WorkflowApproval = workflow, signer = owner) {
  return {
    workflow: data,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflow(data), signer.secretKey)
    ).toString("base64"),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentvault-ai-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function save() {
  return saveAiDecisionReceipt(dir, sign(), scope, proposal, key, NOW);
}

function load(signed = sign(), secret = key, time = NOW) {
  return loadAiDecisionReceipt(dir, signed, scope, secret, time);
}

test("saves an authenticated decision receipt", () => {
  const { path, receipt } = save();

  assert.equal(receipt.requestId, "procurement-005");
  assert.equal(receipt.proposal.amountBaseUnits, 10000);
  assert.equal(receipt.macHex.length, 64);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("reuses an authenticated decision without Gemini", () => {
  save();

  assert.deepEqual(load(), proposal);
});

test("rejects tampered cached payment amounts", () => {
  const { path } = save();
  const receipt = JSON.parse(readFileSync(path, "utf8"));

  receipt.proposal.amountBaseUnits = 20000;
  writeFileSync(path, JSON.stringify(receipt));

  assert.throws(() => load(), /MAC mismatch/);
});

test("rejects reuse with a different signed approval", () => {
  save();

  const changed = {
    ...workflow,
    amountBaseUnits: 20000,
  };

  assert.throws(() => load(sign(changed)), /different owner approval/);
});

test("rejects receipts verified with another secret", () => {
  save();

  assert.throws(
    () => load(sign(), randomBytes(32).toString("hex")),
    /MAC mismatch/
  );
});

test("rejects expired AI decisions", () => {
  save();

  assert.throws(() => load(sign(), key, NOW + 3601), /expired/);
});

test("rejects duplicate receipt creation", () => {
  save();

  assert.throws(
    () => save(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
  );
});

test("does not cache AI rejection decisions", () => {
  assert.throws(() =>
    saveAiDecisionReceipt(
      dir,
      sign(),
      scope,
      {
        decision: "REJECT",
        amountBaseUnits: 0,
        reason: "Not approved",
      },
      key,
      NOW
    )
  );
});

test("rejects forged owner approvals", () => {
  assert.throws(() =>
    saveAiDecisionReceipt(
      dir,
      sign(workflow, Keypair.generate()),
      scope,
      proposal,
      key,
      NOW
    )
  );
});
