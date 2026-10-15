import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import { claimApprovedWorkflow } from "./request-journal";

import {
  encodeWorkflow,
  type ApprovalScope,
  type WorkflowApproval,
} from "./signed-workflow";

const owner = Keypair.generate();

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

const testTime = 1900000000;

function sign(data: WorkflowApproval = workflow) {
  const signature = nacl.sign.detached(encodeWorkflow(data), owner.secretKey);

  return {
    workflow: data,
    signature: Buffer.from(signature).toString("base64"),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentvault-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("claims a valid owner-approved request", () => {
  const { path, record } = claimApprovedWorkflow(dir, sign(), scope, testTime);

  assert.equal(record.status, "claimed");
  assert.equal(record.requestId, "procurement-003");
  assert.equal(record.amountBaseUnits, 10000);
  assert.equal(record.approvalDigest.length, 64);

  const saved = JSON.parse(readFileSync(path, "utf8"));

  assert.deepEqual(saved, record);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("rejects duplicate request claims", () => {
  claimApprovedWorkflow(dir, sign(), scope, testTime);

  assert.throws(
    () => claimApprovedWorkflow(dir, sign(), scope, testTime),
    /already claimed/
  );
});

test("rejects reuse of the request ID with another amount", () => {
  claimApprovedWorkflow(dir, sign(), scope, testTime);

  assert.throws(
    () =>
      claimApprovedWorkflow(
        dir,
        sign({
          ...workflow,
          amountBaseUnits: 20000,
        }),
        scope,
        testTime
      ),
    /already claimed/
  );
});

test("rejects forged approvals before claiming", () => {
  const forged = sign();

  forged.workflow = {
    ...workflow,
    amountBaseUnits: 20000,
  };

  assert.throws(
    () => claimApprovedWorkflow(dir, forged, scope, testTime),
    /Invalid owner signature/
  );
});

test("rejects expired approvals", () => {
  assert.throws(
    () => claimApprovedWorkflow(dir, sign(), scope, workflow.expiresAtUnix + 1),
    /expired/
  );
});

test("rejects another network's approval", () => {
  assert.throws(
    () =>
      claimApprovedWorkflow(
        dir,
        sign(),
        { ...scope, network: "localnet" },
        testTime
      ),
    /scope mismatch/
  );
});
