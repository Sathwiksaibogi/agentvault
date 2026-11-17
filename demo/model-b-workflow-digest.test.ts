import assert from "node:assert/strict";
import test from "node:test";
import * as nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";

import {
  encodeWorkflowV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";

import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";

function fixture() {
  const owner = Keypair.generate();
  const key = () => Keypair.generate().publicKey.toBase58();

  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-digest-001",
    genesisHash: key(),
    programId: key(),
    vault: key(),
    owner: owner.publicKey.toBase58(),
    mint: key(),
    assignedAgent: "agent-a",
    agentAuthority: key(),
    kind: "procurement",
    taskId: 7,
    recipient: key(),
    amountBaseUnits: 1000,
    expiresAtUnix: 1800003600,
    description: "Owner approved infrastructure purchase",
  };

  function sign(value: WorkflowApprovalV2) {
    return {
      workflow: value,
      signature: Buffer.from(
        nacl.sign.detached(encodeWorkflowV2(value), owner.secretKey)
      ).toString("base64"),
    };
  }

  return { workflow, owner, sign };
}

test("computes a deterministic Model B workflow digest", () => {
  const f = fixture();
  const signed = f.sign(f.workflow);

  const first = computeModelBWorkflowDigest(signed);
  const second = computeModelBWorkflowDigest(signed);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("rejects workflow data modified after signing", () => {
  const f = fixture();
  const signed = f.sign(f.workflow);

  assert.throws(
    () =>
      computeModelBWorkflowDigest({
        ...signed,
        workflow: {
          ...f.workflow,
          amountBaseUnits: 2000,
        },
      }),
    /Invalid Model B workflow signature/
  );
});

test("distinguishes separately signed workflow contents", () => {
  const f = fixture();

  const first = f.sign(f.workflow);
  const second = f.sign({
    ...f.workflow,
    description: "Separately approved purchase request",
  });

  assert.notEqual(
    computeModelBWorkflowDigest(first),
    computeModelBWorkflowDigest(second)
  );
});

test("rejects an attacker-signed workflow", () => {
  const f = fixture();
  const attacker = Keypair.generate();

  const forged = {
    workflow: f.workflow,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflowV2(f.workflow), attacker.secretKey)
    ).toString("base64"),
  };

  assert.throws(
    () => computeModelBWorkflowDigest(forged),
    /Invalid Model B workflow signature/
  );
});

test("rejects an old v1 workflow on the Model B digest path", () => {
  const f = fixture();

  assert.throws(() =>
    computeModelBWorkflowDigest({
      workflow: {
        ...f.workflow,
        version: 1,
      },
      signature: f.sign(f.workflow).signature,
    })
  );
});
