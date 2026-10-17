/** Offline test: browser signMessage bytes == existing CLI owner approval bytes. */
import { strict as assert } from "node:assert";
import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import { webAgents } from "../frontend/src/webAgents";
import {
  encodeWebWorkflow,
  toBaseUnits,
  type WorkflowApproval,
} from "../frontend/src/webWorkflowApproval";
import {
  encodeWorkflow,
  verifyWorkflowApproval,
  workflowApprovalSchema,
} from "./signed-workflow";

function main() {
  const temporaryOwner = Keypair.generate(); // Test only, never used on-chain.
  const now = Math.floor(Date.now() / 1000);

  const approval = workflowApprovalSchema.parse({
    version: 1,
    network: "devnet",
    requestId: "test-web-approval-0001",
    genesisHash: Keypair.generate().publicKey.toBase58(),
    programId: webAgents.programId,
    vault: webAgents.vault,
    owner: temporaryOwner.publicKey.toBase58(),
    mint: webAgents.mint,
    assignedAgent: "agent-a",
    agentAuthority: webAgents.agents[0].authority,
    kind: "procurement",
    taskId: 1,
    recipient: webAgents.agents[0].recipient,
    amountBaseUnits: 10_000,
    expiresAtUnix: now + 900,
    description: "Pay an approved supplier invoice",
  });

  const expected = encodeWorkflow(approval);
  const actual = encodeWebWorkflow(approval as WorkflowApproval);
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected));

  const signature = nacl.sign.detached(actual, temporaryOwner.secretKey);
  const signed = {
    workflow: approval,
    signature: Buffer.from(signature).toString("base64"),
  };
  const scope = {
    network: approval.network,
    genesisHash: approval.genesisHash,
    programId: approval.programId,
    vault: approval.vault,
    owner: approval.owner,
    mint: approval.mint,
  };
  assert.equal(
    verifyWorkflowApproval(signed, scope, now).requestId,
    approval.requestId
  );
  assert.throws(() =>
    verifyWorkflowApproval(
      { ...signed, workflow: { ...approval, amountBaseUnits: 10_001 } },
      scope,
      now
    )
  );
  assert.equal(toBaseUnits("0.01", 6), 10_000);
  assert.throws(() => toBaseUnits("0.0000001", 6));
  console.log("PASS: browser and CLI owner-approval bytes match");
  console.log("PASS: signature verification and tampering rejection");
  console.log("PASS: exact amount conversion");
  console.log("No Devnet transaction submitted.");
}

main();
