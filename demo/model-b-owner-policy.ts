import assert from "node:assert/strict";

import { MAX_PAYMENT_AMOUNT } from "./workflow-policy";

const U64_MAX = BigInt("18446744073709551615");
const I64_MAX = BigInt("9223372036854775807");

export type ModelBOwnerPolicyInput = {
  expected: {
    owner: string;
    vault: string;
    vaultId: string;
    mint: string;
    agentPda: string;
    agentAuthority: string;
    taskId: string;
    genesisHash: string;
  };
  amountBaseUnits: number;
  chainTime: string;
  vault: {
    owner: string;
    tokenMint: string;
    vaultId: string;
    paused: boolean;
    totalReserved: string;
  };
  agent: {
    vault: string;
    authority: string;
    active: boolean;
  };
  approvedTask: {
    vault: string;
    agent: string;
    taskId: string;
    recipient: string;
    budget: string;
    spent: string;
    expiresAt: string;
    nextNonce: string;
    genesisHash: string;
    active: boolean;
  };
  treasury: {
    owner: string;
    mint: string;
    amount: string;
  };
};

export type ModelBOwnerPolicySnapshot = {
  nowUnix: number;
  recipient: string;
  nextNonce: string;
  taskExpiresAtUnix: string;
  budget: string;
  spent: string;
  remaining: string;
  totalReserved: string;
  treasuryBalance: string;
};

function parseU64(value: string, name: string): bigint {
  assert.ok(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    `Invalid ${name}`
  );

  const parsed = BigInt(value);

  assert.ok(parsed <= U64_MAX, `Invalid ${name}`);

  return parsed;
}

function parsePositiveI64(value: string, name: string): bigint {
  const parsed = parseU64(value, name);

  assert.ok(parsed > BigInt(0) && parsed <= I64_MAX, `Invalid ${name}`);

  return parsed;
}

/**
 * Pure validation of on-chain Model B policy data.
 *
 * The caller must fetch each account at its independently
 * derived PDA and verify the RPC genesis hash.
 *
 * This function never signs, persists, or broadcasts.
 */
export function assertModelBOwnerPolicy(
  input: ModelBOwnerPolicyInput
): ModelBOwnerPolicySnapshot {
  const { expected, vault, agent, approvedTask, treasury } = input;

  const now = parsePositiveI64(input.chainTime, "chain time");

  assert.ok(now <= BigInt(Number.MAX_SAFE_INTEGER), "Unsafe chain time");

  assert.ok(
    Number.isSafeInteger(input.amountBaseUnits) &&
      input.amountBaseUnits > 0 &&
      input.amountBaseUnits <= MAX_PAYMENT_AMOUNT,
    "Invalid Model B payment amount"
  );

  const amount = BigInt(input.amountBaseUnits);

  // Vault identity and activation.
  assert.equal(vault.owner, expected.owner, "Vault owner mismatch");
  assert.equal(vault.tokenMint, expected.mint, "Vault mint mismatch");
  assert.equal(vault.vaultId, expected.vaultId, "Vault ID mismatch");
  assert.equal(vault.paused, false, "Vault is paused");

  // Registered agent identity and activation.
  assert.equal(agent.vault, expected.vault, "Agent Vault mismatch");
  assert.equal(
    agent.authority,
    expected.agentAuthority,
    "Agent authority mismatch"
  );
  assert.equal(agent.active, true, "Agent is inactive");

  // Separately derived Model B ApprovedTask.
  assert.equal(
    approvedTask.vault,
    expected.vault,
    "ApprovedTask Vault mismatch"
  );
  assert.equal(
    approvedTask.agent,
    expected.agentPda,
    "ApprovedTask agent mismatch"
  );
  assert.equal(
    approvedTask.taskId,
    expected.taskId,
    "ApprovedTask ID mismatch"
  );
  assert.equal(
    approvedTask.genesisHash,
    expected.genesisHash,
    "ApprovedTask belongs to another ledger"
  );
  assert.equal(approvedTask.active, true, "ApprovedTask is inactive");

  assert.ok(
    approvedTask.recipient.length > 0,
    "Missing ApprovedTask recipient"
  );

  const expiry = parsePositiveI64(
    approvedTask.expiresAt,
    "ApprovedTask expiry"
  );

  assert.ok(expiry > now, "ApprovedTask has expired");

  assert.ok(
    expiry <= BigInt(Number.MAX_SAFE_INTEGER),
    "Unsafe ApprovedTask expiry"
  );

  const nonce = parseU64(approvedTask.nextNonce, "ApprovedTask nonce");

  const budget = parseU64(approvedTask.budget, "ApprovedTask budget");

  const spent = parseU64(approvedTask.spent, "ApprovedTask spent");

  assert.ok(spent <= budget, "ApprovedTask accounting is inconsistent");

  const remaining = budget - spent;

  assert.ok(amount <= remaining, "Insufficient ApprovedTask budget");

  // Reserved funds must be backed by the treasury.
  const reserved = parseU64(vault.totalReserved, "Vault reserved funds");

  assert.ok(amount <= reserved, "Insufficient Vault reserved funds");

  assert.equal(
    treasury.owner,
    expected.vault,
    "Treasury is not owned by the Vault PDA"
  );

  assert.equal(treasury.mint, expected.mint, "Treasury mint mismatch");

  const balance = parseU64(treasury.amount, "Treasury amount");

  assert.ok(
    reserved <= balance,
    "Vault reserved funds exceed treasury balance"
  );

  return {
    nowUnix: Number(now),
    recipient: approvedTask.recipient,
    nextNonce: nonce.toString(),
    taskExpiresAtUnix: expiry.toString(),
    budget: budget.toString(),
    spent: spent.toString(),
    remaining: remaining.toString(),
    totalReserved: reserved.toString(),
    treasuryBalance: balance.toString(),
  };
}

/**
 * Owner must sign the same payment intent that was
 * displayed before interactive confirmation.
 *
 * A later chain timestamp is allowed; changes to
 * the displayed spending policy are not.
 */
export function assertUnchangedModelBOwnerPolicy(
  before: ModelBOwnerPolicySnapshot,
  after: ModelBOwnerPolicySnapshot
): void {
  assert.ok(
    after.nowUnix >= before.nowUnix,
    "Solana clock moved backward during confirmation"
  );

  const fields = [
    "recipient",
    "nextNonce",
    "taskExpiresAtUnix",
    "budget",
    "spent",
    "remaining",
    "totalReserved",
    "treasuryBalance",
  ] as const;

  for (const field of fields) {
    assert.equal(
      after[field],
      before[field],
      `Model B ${field} changed during confirmation`
    );
  }
}
