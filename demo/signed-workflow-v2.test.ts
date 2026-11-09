import assert from "node:assert/strict";
import test from "node:test";
import * as nacl from "tweetnacl";

import { Keypair } from "@solana/web3.js";

import {
  encodeWorkflow,
  workflowApprovalSchema,
  type ApprovalScope,
} from "./signed-workflow";

import {
  encodeWorkflowV2,
  verifyWorkflowApprovalV2,
  verifySignedWorkflowRoute,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";

function fixture() {
  const owner = Keypair.generate();
  const pubkey = () => Keypair.generate().publicKey.toBase58();

  const nowUnix = 1_800_000_000;

  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-routing-001",
    genesisHash: pubkey(),
    programId: pubkey(),
    vault: pubkey(),
    owner: owner.publicKey.toBase58(),
    mint: pubkey(),
    assignedAgent: "agent-a",
    agentAuthority: pubkey(),
    kind: "procurement",
    taskId: 7,
    recipient: pubkey(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Purchase approved infrastructure services",
  };

  const scope: ApprovalScope = {
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };

  function signV2(value: WorkflowApprovalV2, signer = owner) {
    return {
      workflow: value,
      signature: Buffer.from(
        nacl.sign.detached(encodeWorkflowV2(value), signer.secretKey)
      ).toString("base64"),
    };
  }

  return {
    owner,
    workflow,
    scope,
    nowUnix,
    signV2,
    signed: signV2(workflow),
  };
}

test("accepts an exact owner-signed Model B workflow", () => {
  const f = fixture();

  const verified = verifyWorkflowApprovalV2(f.signed, f.scope, f.nowUnix);

  assert.deepEqual(verified, f.workflow);
});

test("routes a valid v2 workflow exclusively to Model B", () => {
  const f = fixture();

  const result = verifySignedWorkflowRoute(f.signed, f.scope, f.nowUnix);

  assert.equal(result.authorizationModel, "model-b");
  assert.equal(result.workflow.requestId, f.workflow.requestId);
});

test("preserves valid historical v1 Model A approvals", () => {
  const f = fixture();

  const legacyData = {
    ...f.workflow,
  } as Record<string, unknown>;

  delete legacyData.authorizationModel;
  legacyData.version = 1;

  const legacy = workflowApprovalSchema.parse(legacyData);

  const signedV1 = {
    workflow: legacy,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflow(legacy), f.owner.secretKey)
    ).toString("base64"),
  };

  const result = verifySignedWorkflowRoute(signedV1, f.scope, f.nowUnix);

  assert.equal(result.authorizationModel, "model-a");
  assert.equal(result.workflow.version, 1);
});

test("rejects downgrading a signed v2 workflow to v1", () => {
  const f = fixture();

  const altered = {
    ...f.workflow,
  } as Record<string, unknown>;

  delete altered.authorizationModel;
  altered.version = 1;

  const downgraded = workflowApprovalSchema.parse(altered);

  assert.throws(
    () =>
      verifySignedWorkflowRoute(
        {
          workflow: downgraded,
          signature: f.signed.signature,
        },
        f.scope,
        f.nowUnix
      ),
    /Invalid owner signature/
  );
});

test("rejects changing the signed authorization model", () => {
  const f = fixture();

  assert.throws(() =>
    verifySignedWorkflowRoute(
      {
        ...f.signed,
        workflow: {
          ...f.workflow,
          authorizationModel: "model-a",
        },
      },
      f.scope,
      f.nowUnix
    )
  );
});

test("rejects a v2 workflow without explicit model selection", () => {
  const f = fixture();

  const changed = {
    ...f.workflow,
  } as Record<string, unknown>;

  delete changed.authorizationModel;

  assert.throws(() =>
    verifySignedWorkflowRoute(
      { ...f.signed, workflow: changed },
      f.scope,
      f.nowUnix
    )
  );
});

test("rejects altering the amount after owner signing", () => {
  const f = fixture();

  assert.throws(
    () =>
      verifyWorkflowApprovalV2(
        {
          ...f.signed,
          workflow: {
            ...f.workflow,
            amountBaseUnits: 2000,
          },
        },
        f.scope,
        f.nowUnix
      ),
    /Invalid workflow v2 owner signature/
  );
});

test("rejects another owner's valid signature", () => {
  const f = fixture();

  const attacker = Keypair.generate();

  assert.throws(
    () =>
      verifyWorkflowApprovalV2(
        f.signV2(f.workflow, attacker),
        f.scope,
        f.nowUnix
      ),
    /Invalid workflow v2 owner signature/
  );
});

test("rejects an approval for a different chain", () => {
  const f = fixture();

  assert.throws(
    () =>
      verifyWorkflowApprovalV2(
        f.signed,
        {
          ...f.scope,
          genesisHash: Keypair.generate().publicKey.toBase58(),
        },
        f.nowUnix
      ),
    /Workflow v2 scope mismatch: genesisHash/
  );
});

test("rejects expired owner-signed workflows", () => {
  const f = fixture();

  assert.throws(
    () => verifyWorkflowApprovalV2(f.signed, f.scope, f.workflow.expiresAtUnix),
    /Workflow v2 approval expired/
  );
});

test("rejects unknown workflow protocol versions", () => {
  const f = fixture();

  assert.throws(
    () =>
      verifySignedWorkflowRoute(
        {
          ...f.signed,
          workflow: {
            ...f.workflow,
            version: 3,
          },
        },
        f.scope,
        f.nowUnix
      ),
    /Unsupported owner-signed workflow version/
  );
});

test("uses a deterministic domain distinct from v1", () => {
  const f = fixture();

  const first = encodeWorkflowV2(f.workflow);
  const second = encodeWorkflowV2({ ...f.workflow });

  assert.deepEqual(first, second);

  assert.ok(
    first.includes(Buffer.from("agentvault:owner-approved-workflow:v2"))
  );

  assert.notEqual(
    Buffer.from(first).toString("hex"),
    Buffer.from("agentvault:owner-approved-workflow:v1").toString("hex")
  );
});
