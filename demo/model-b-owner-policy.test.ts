import assert from "node:assert/strict";
import test from "node:test";

import {
  assertModelBOwnerPolicy,
  assertUnchangedModelBOwnerPolicy,
  type ModelBOwnerPolicyInput,
  type ModelBOwnerPolicySnapshot,
} from "./model-b-owner-policy";

function validInput(): ModelBOwnerPolicyInput {
  return {
    expected: {
      owner: "owner",
      vault: "vault",
      vaultId: "7",
      mint: "mint",
      agentPda: "agent-pda",
      agentAuthority: "agent-authority",
      taskId: "3",
      genesisHash: "genesis",
    },
    amountBaseUnits: 1000,
    chainTime: "1800000000",
    vault: {
      owner: "owner",
      tokenMint: "mint",
      vaultId: "7",
      paused: false,
      totalReserved: "1200",
    },
    agent: {
      vault: "vault",
      authority: "agent-authority",
      active: true,
    },
    approvedTask: {
      vault: "vault",
      agent: "agent-pda",
      taskId: "3",
      recipient: "approved-recipient",
      budget: "1500",
      spent: "200",
      expiresAt: "1800007200",
      nextNonce: "0",
      genesisHash: "genesis",
      active: true,
    },
    treasury: {
      owner: "vault",
      mint: "mint",
      amount: "1500",
    },
  };
}

test("accepts valid Model B on-chain spending policy", () => {
  const snapshot = assertModelBOwnerPolicy(validInput());

  assert.equal(snapshot.nextNonce, "0");
  assert.equal(snapshot.remaining, "1300");
  assert.equal(snapshot.recipient, "approved-recipient");
  assert.equal(snapshot.totalReserved, "1200");
  assert.equal(snapshot.nowUnix, 1800000000);
});

const invalidCases: {
  name: string;
  modify: (input: ModelBOwnerPolicyInput) => void;
  error: RegExp;
}[] = [
  {
    name: "paused Vault",
    modify: (f) => {
      f.vault.paused = true;
    },
    error: /Vault is paused/,
  },
  {
    name: "inactive agent",
    modify: (f) => {
      f.agent.active = false;
    },
    error: /Agent is inactive/,
  },
  {
    name: "inactive ApprovedTask",
    modify: (f) => {
      f.approvedTask.active = false;
    },
    error: /ApprovedTask is inactive/,
  },
  {
    name: "incorrect Vault owner",
    modify: (f) => {
      f.vault.owner = "attacker";
    },
    error: /Vault owner mismatch/,
  },
  {
    name: "incorrect agent authority",
    modify: (f) => {
      f.agent.authority = "attacker";
    },
    error: /Agent authority mismatch/,
  },
  {
    name: "incorrect ApprovedTask PDA relationship",
    modify: (f) => {
      f.approvedTask.agent = "wrong-agent";
    },
    error: /ApprovedTask agent mismatch/,
  },
  {
    name: "wrong ApprovedTask genesis hash",
    modify: (f) => {
      f.approvedTask.genesisHash = "other-chain";
    },
    error: /ApprovedTask belongs to another ledger/,
  },
  {
    name: "expired ApprovedTask",
    modify: (f) => {
      f.approvedTask.expiresAt = f.chainTime;
    },
    error: /ApprovedTask has expired/,
  },
  {
    name: "insufficient remaining task budget",
    modify: (f) => {
      f.approvedTask.budget = "1100";
    },
    error: /Insufficient ApprovedTask budget/,
  },
  {
    name: "overspent task accounting",
    modify: (f) => {
      f.approvedTask.spent = "1600";
    },
    error: /ApprovedTask accounting is inconsistent/,
  },
  {
    name: "insufficient reserved funds",
    modify: (f) => {
      f.vault.totalReserved = "999";
    },
    error: /Insufficient Vault reserved funds/,
  },
  {
    name: "undercollateralized treasury",
    modify: (f) => {
      f.treasury.amount = "1199";
    },
    error: /Vault reserved funds exceed treasury balance/,
  },
  {
    name: "wrong treasury owner",
    modify: (f) => {
      f.treasury.owner = "attacker";
    },
    error: /Treasury is not owned by the Vault PDA/,
  },
  {
    name: "noncanonical nonce",
    modify: (f) => {
      f.approvedTask.nextNonce = "01";
    },
    error: /Invalid ApprovedTask nonce/,
  },
  {
    name: "nonce exceeding u64",
    modify: (f) => {
      f.approvedTask.nextNonce = "18446744073709551616";
    },
    error: /Invalid ApprovedTask nonce/,
  },
  {
    name: "amount exceeding application cap",
    modify: (f) => {
      f.amountBaseUnits = 50001;
    },
    error: /Invalid Model B payment amount/,
  },
];

for (const scenario of invalidCases) {
  test(`rejects ${scenario.name}`, () => {
    const input = validInput();
    scenario.modify(input);

    assert.throws(() => assertModelBOwnerPolicy(input), scenario.error);
  });
}

test("accepts an unchanged policy with a later clock", () => {
  const before = assertModelBOwnerPolicy(validInput());
  const after = {
    ...before,
    nowUnix: before.nowUnix + 10,
  };

  assert.doesNotThrow(() => assertUnchangedModelBOwnerPolicy(before, after));
});

const changedFields: {
  field: Exclude<keyof ModelBOwnerPolicySnapshot, "nowUnix">;
  changedValue: string;
}[] = [
  { field: "recipient", changedValue: "new-recipient" },
  { field: "nextNonce", changedValue: "1" },
  { field: "taskExpiresAtUnix", changedValue: "1800009000" },
  { field: "budget", changedValue: "1501" },
  { field: "spent", changedValue: "201" },
  { field: "remaining", changedValue: "1299" },
  { field: "totalReserved", changedValue: "1199" },
  { field: "treasuryBalance", changedValue: "1501" },
];

for (const { field, changedValue } of changedFields) {
  test(`rejects ${field} changing during confirmation`, () => {
    const before = assertModelBOwnerPolicy(validInput());
    const after = {
      ...before,
      [field]: changedValue,
    };

    assert.throws(
      () => assertUnchangedModelBOwnerPolicy(before, after),
      /changed during confirmation/
    );
  });
}

test("rejects a clock rollback during confirmation", () => {
  const before = assertModelBOwnerPolicy(validInput());

  assert.throws(
    () =>
      assertUnchangedModelBOwnerPolicy(before, {
        ...before,
        nowUnix: before.nowUnix - 1,
      }),
    /Solana clock moved backward/
  );
});
