import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import {
  encodeWorkflow,
  type WorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

import { resolveAiDecision } from "./ai-decision-cache";
import type { AiProposal } from "./workflow-policy";

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
  description: "Replacement equipment purchase",
};

const scope: ApprovalScope = {
  network: workflow.network,
  genesisHash: workflow.genesisHash,
  programId: workflow.programId,
  vault: workflow.vault,
  owner: workflow.owner,
  mint: workflow.mint,
};

const signature = nacl.sign.detached(encodeWorkflow(workflow), owner.secretKey);

const signedApproval = {
  workflow,
  signature: Buffer.from(signature).toString("base64"),
};

const approved: AiProposal = {
  decision: "PAY",
  amountBaseUnits: 10000,
  reason: "Valid procurement purchase",
};

const KEY = randomBytes(32).toString("hex");
const NOW = 1900000000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentvault-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function resolve(evaluate: () => Promise<AiProposal>, nowUnix = NOW) {
  return resolveAiDecision(dir, signedApproval, scope, KEY, nowUnix, evaluate);
}

test("evaluates once and reuses a saved AI decision", async () => {
  let calls = 0;

  const first = await resolve(async () => {
    calls++;
    return approved;
  });

  const second = await resolve(async () => {
    calls++;
    throw new Error("Gemini must not be called again");
  });

  assert.equal(first.source, "gemini");
  assert.equal(second.source, "cache");
  assert.deepEqual(second.proposal, approved);
  assert.equal(calls, 1);
});

test("rejects tampered receipts without calling Gemini", async () => {
  await resolve(async () => approved);

  const path = join(dir, "ai-decisions", "procurement-005.json");

  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.proposal.amountBaseUnits = 20000;
  writeFileSync(path, JSON.stringify(saved));

  let called = false;

  await assert.rejects(
    resolve(async () => {
      called = true;
      return approved;
    }),
    /MAC mismatch/
  );

  assert.equal(called, false);
});

test("fails closed when an existing receipt expires", async () => {
  await resolve(async () => approved);

  await assert.rejects(
    resolve(async () => {
      throw new Error("Gemini must not be called");
    }, NOW + 3601),
    /expired/
  );
});

test("Gemini errors never create a receipt", async () => {
  await assert.rejects(
    resolve(async () => {
      throw new Error("Gemini quota exhausted");
    }),
    /quota exhausted/
  );

  assert.equal(
    existsSync(join(dir, "ai-decisions", "procurement-005.json")),
    false
  );
});

test("rejected AI proposals are never cached", async () => {
  await assert.rejects(
    resolve(async () => ({
      decision: "REJECT",
      amountBaseUnits: 0,
      reason: "Outside procurement scope",
    }))
  );

  assert.equal(
    existsSync(join(dir, "ai-decisions", "procurement-005.json")),
    false
  );
});
