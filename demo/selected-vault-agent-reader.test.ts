import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { projectVerifiedVaultAgentsAndTasks } from "./selected-vault-agent-reader";
import type { VerifiedOwnerVault } from "./owner-vault-verifier";

const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const owner = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const otherVault = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const [agentPda, agentBump] = PublicKey.findProgramAddressSync([
  Buffer.from("agent"), vault.toBuffer(), authority.toBuffer(),
], PROGRAM);
const id = BigInt(3);
const idBytes = Buffer.alloc(8);
idBytes.writeBigUInt64LE(id);
const [taskPda, taskBump] = PublicKey.findProgramAddressSync([
  Buffer.from("task"), agentPda.toBuffer(), idBytes,
], PROGRAM);
const verified: VerifiedOwnerVault = {
  owner: owner.toBase58(), vault: vault.toBase58(), mint: Keypair.generate().publicKey.toBase58(),
  treasury: Keypair.generate().publicKey.toBase58(), vaultId: "8001", paused: false,
  totalReservedBaseUnits: "0", treasuryBalanceBaseUnits: "1000000",
};
function fixtures() {
  return {
    agentAccounts: [{ publicKey: agentPda, account: {
      vault, authority, bump: agentBump, active: true,
    } }],
    taskAccounts: [{ publicKey: taskPda, account: {
      agent: agentPda, taskId: id, bump: taskBump, recipient,
      budget: BigInt("9007199254740993"), spent: BigInt(123),
      nextNonce: BigInt(7), expiresAt: BigInt(1900000000), active: true,
    } }],
  };
}
function project(f: ReturnType<typeof fixtures>) {
  return projectVerifiedVaultAgentsAndTasks({ verified, ...f });
}

test("reads only canonical selected-vault agent and task; preserves u64 precision", () => {
  const f = fixtures();
  const result = project(f);
  assert.equal(result.vault, vault.toBase58());
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0];
  assert.equal(agent.agentPda, agentPda.toBase58());
  assert.equal(agent.authority, authority.toBase58());
  assert.equal(agent.tasks[0].taskId, "3");
  assert.equal(agent.tasks[0].budgetBaseUnits, "9007199254740993");
  assert.equal(agent.tasks[0].remainingBaseUnits, "9007199254740870");
});

test("foreign vault agents and unrelated tasks are not leaked", () => {
  const f = fixtures();
  const alien = { publicKey: Keypair.generate().publicKey, account: {
    vault: otherVault, authority, active: true, bump: 1,
  } };
  f.agentAccounts.push(alien);
  f.taskAccounts.push({ publicKey: Keypair.generate().publicKey, account: {
    agent: Keypair.generate().publicKey, taskId: BigInt(999), bump: 0,
    recipient, budget: BigInt(1), spent: BigInt(0), nextNonce: BigInt(0),
    expiresAt: BigInt(0), active: true,
  } });
  assert.equal(project(f).agents.length, 1);
  assert.equal(project(f).agents[0].tasks.length, 1);
});

test("rejects forged agent PDA or bump, and duplicate agent", () => {
  const f = fixtures();
  f.agentAccounts[0].publicKey = Keypair.generate().publicKey;
  assert.throws(() => project(f), /verification failed/);
  f.agentAccounts[0].publicKey = agentPda;
  f.agentAccounts[0].account.bump ^= 1;
  assert.throws(() => project(f), /verification failed/);
  f.agentAccounts[0].account.bump ^= 1;
  f.agentAccounts.push({ ...f.agentAccounts[0] });
  assert.throws(() => project(f), /verification failed/);
});

test("rejects forged task PDA, invalid bump or duplicate task", () => {
  const f = fixtures();
  f.taskAccounts[0].publicKey = Keypair.generate().publicKey;
  assert.throws(() => project(f), /verification failed/);
  f.taskAccounts[0].publicKey = taskPda;
  f.taskAccounts[0].account.bump ^= 1;
  assert.throws(() => project(f), /verification failed/);
  f.taskAccounts[0].account.bump ^= 1;
  f.taskAccounts.push({ ...f.taskAccounts[0] });
  assert.throws(() => project(f), /verification failed/);
});

test("rejects overspending, unsafe numeric fields, and wrong type", () => {
  const f = fixtures();
  f.taskAccounts[0].account.spent = BigInt("9007199254740994");
  assert.throws(() => project(f), /verification failed/);
  f.taskAccounts[0].account.spent = BigInt(100);
  (f.taskAccounts[0].account as { nextNonce: unknown }).nextNonce = Number.MAX_SAFE_INTEGER + 100;
  assert.throws(() => project(f), /verification failed/);
  f.taskAccounts[0].account.nextNonce = BigInt(0);
  f.agentAccounts[0].account.active = "yes" as unknown as boolean;
  assert.throws(() => project(f), /verification failed/);
});

test("zero agents and tasks returns empty vault-scoped response", () => {
  assert.deepEqual(projectVerifiedVaultAgentsAndTasks({
    verified, agentAccounts: [], taskAccounts: [],
  }), { network: "devnet", vault: verified.vault, owner: verified.owner, agents: [] });
});
