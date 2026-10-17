/**
 * Vault 2 execution boundary. No private key material is imported into the browser.
 * These paths are deliberately separate from demo/devnet/{journal,ai-decisions}.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { signedWorkflowSchema, type SignedWorkflow } from "./signed-workflow";
import { NETWORK, RUNTIME_DIR } from "./runtime-config";
import { webAgents } from "../frontend/src/webAgents";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export const WEB_AGENT_KEYS_DIR = join(
  homedir(),
  ".config",
  "agentvault",
  "devnet",
  "web-vault-8001"
);

// Kept outside the Git working tree: signed txs, replay claims, and AI receipts.
export const WEB_EXECUTION_DIR = join(WEB_AGENT_KEYS_DIR, "execution");

// 10.8A approvals are separate from the original CLI-owned vault's approvals.
export const WEB_APPROVAL_DIR = join(RUNTIME_DIR, "web-approvals");

export function assertWebDevnetConfig(): void {
  assert.equal(NETWORK, "devnet", "Vault 2 execution is Devnet only");
  assert.equal(webAgents.network, "devnet");
  assert.equal(webAgents.vaultId, "8001");
  assert.equal(
    webAgents.programId,
    "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
  );
  assert.equal(webAgents.owner, "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc");
  assert.equal(webAgents.vault, "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep");
  assert.equal(webAgents.mint, "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38");
  assert.equal(
    webAgents.treasury,
    "8yX2mqJcx5ECA2r4gDNkEvTUvAZp6VZvj1rs8t8X1jyp"
  );
}

/** The CLI demo's public state anchors the expected Devnet genesis hash. */
export function expectedWebGenesisHash(): string {
  assertWebDevnetConfig();
  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as { genesisHash: string; programId: string; mint: string };
  assert.equal(state.programId, webAgents.programId);
  assert.equal(state.mint, webAgents.mint);
  assert.ok(
    typeof state.genesisHash === "string" && state.genesisHash.length > 0
  );
  return state.genesisHash;
}

/**
 * The backend stores {signedWorkflow, verifiedAtUnix, ...}, not a bare approval.
 * Never trust the saved status string as proof of execution authorization.
 */
export function loadWebSignedApproval(requestId: string): SignedWorkflow {
  assertWebDevnetConfig();
  assert.match(requestId, REQUEST_ID_PATTERN, "Invalid request ID");
  const saved = JSON.parse(
    readFileSync(join(WEB_APPROVAL_DIR, `${requestId}.json`), "utf8")
  ) as unknown;
  assert.ok(saved && typeof saved === "object" && "signedWorkflow" in saved);
  const signed = signedWorkflowSchema.parse(saved.signedWorkflow);
  assert.equal(
    signed.workflow.requestId,
    requestId,
    "Approval request ID mismatch"
  );
  assert.equal(signed.workflow.vault, webAgents.vault, "Wrong vault approval");
  assert.equal(signed.workflow.owner, webAgents.owner, "Wrong owner approval");
  return signed;
}
