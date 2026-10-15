import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  encodeWorkflow,
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

export type RequestJournalRecord = {
  version: 1;
  requestId: string;
  network: string;
  genesisHash: string;
  vault: string;
  owner: string;
  agent: string;
  recipient: string;
  amountBaseUnits: number;
  approvalDigest: string;
  status: "claimed";
  claimedAt: string;
};

export function claimApprovedWorkflow(
  runtimeDir: string,
  signedInput: unknown,
  scope: ApprovalScope,
  nowUnix = Math.floor(Date.now() / 1000)
): {
  path: string;
  record: RequestJournalRecord;
} {
  // Never claim an unauthenticated workflow.
  const workflow = verifyWorkflowApproval(signedInput, scope, nowUnix);

  const signed = signedWorkflowSchema.parse(signedInput);

  // Bind the journal entry to this exact signed approval.
  const approvalDigest = createHash("sha256")
    .update(encodeWorkflow(workflow))
    .update(Buffer.from(signed.signature, "base64"))
    .digest("hex");

  const record: RequestJournalRecord = {
    version: 1,
    requestId: workflow.requestId,
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    vault: workflow.vault,
    owner: workflow.owner,
    agent: workflow.assignedAgent,
    recipient: workflow.recipient,
    amountBaseUnits: workflow.amountBaseUnits,
    approvalDigest,
    status: "claimed",
    claimedAt: new Date(nowUnix * 1000).toISOString(),
  };

  const journalDir = join(runtimeDir, "journal");

  mkdirSync(journalDir, {
    recursive: true,
    mode: 0o700,
  });

  const path = join(journalDir, `${workflow.requestId}.json`);

  // "wx" means exclusive creation:
  // an existing request journal cannot be overwritten.
  let fd: number;

  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Request ${workflow.requestId} already claimed. ` +
          "Inspect the journal; do not submit another payment."
      );
    }

    throw error;
  }

  try {
    writeFileSync(fd, JSON.stringify(record, null, 2));

    // Flush the file before allowing execution to proceed.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Flush the directory entry as well as file contents.
  // This improves crash durability on Linux filesystems.
  const directoryFd = openSync(journalDir, "r");

  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }

  return { path, record };
}
