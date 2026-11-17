/**
 * Test-only subprocess: one real OS process races to claim a synthetic Model B
 * request. It never signs, prepares or broadcasts a transaction.
 *
 * Run only through model-b-journal-process-crash.test.ts. The worker accepts
 * temporary test-directory paths exclusively and no private key material.
 */
import assert from "node:assert/strict";
import { basename, join, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { PublicKey } from "@solana/web3.js";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { claimModelBWorkflow } from "./model-b-request-journal";

type WorkerPayload = {
  runtimeDir: string;
  signedWorkflow: ModelBWorkflowBinding["signedWorkflow"];
  paymentApproval: ModelBWorkflowBinding["paymentApproval"];
  signatureBase64: string;
  scope: ModelBWorkflowBinding["scope"];
  agentPda: string;
  approvedTaskPda: string;
  nextNonce: string;
  taskExpiresAtUnix: string;
  nowUnix: number;
};

function main() {
  assert.equal(process.argv.length, 3, "Expected a single fixture path");
  const fixturePath = realpathSync(process.argv[2]);
  const root = realpathSync(tmpdir());
  assert.ok(
    fixturePath.startsWith(root + sep),
    "Fixture must be in system temp"
  );
  const input = JSON.parse(readFileSync(fixturePath, "utf8")) as WorkerPayload;
  const runtimeDir = realpathSync(input.runtimeDir);
  assert.ok(
    runtimeDir.startsWith(root + sep),
    "Runtime must be in system temp"
  );
  assert.ok(
    basename(runtimeDir).startsWith("agentvault-76c1-"),
    "Refusing non-test runtime"
  );
  assert.equal(fixturePath, join(runtimeDir, "race-fixture.json"));
  assert.equal(input.scope.network, "devnet", "Synthetic Devnet fixture only");

  const binding: ModelBWorkflowBinding = {
    signedWorkflow: input.signedWorkflow,
    paymentApproval: input.paymentApproval,
    signatureBase64: input.signatureBase64,
    scope: input.scope,
    agentPda: new PublicKey(input.agentPda),
    approvedTaskPda: new PublicKey(input.approvedTaskPda),
    nextNonce: input.nextNonce,
    taskExpiresAtUnix: input.taskExpiresAtUnix,
    nowUnix: input.nowUnix,
  };

  try {
    const { record } = claimModelBWorkflow(runtimeDir, binding);
    assert.equal(record.version, 2);
    process.stdout.write("CLAIM_OK\n");
  } catch (error) {
    if (error instanceof Error && /already claimed/.test(error.message)) {
      process.stdout.write("CLAIM_EXISTS\n");
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main();
