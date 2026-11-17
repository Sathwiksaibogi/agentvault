import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { verifyModelAPaymentIntentPolicy } from "./model-a-payment-policy";

const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NOW = 1794590000;
const GENESIS = "expected-devnet-genesis";

function fixture() {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const vaultId = Buffer.alloc(8);
  vaultId.writeBigUInt64LE(BigInt(8001), 0);
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), vaultId],
    PROGRAM
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()],
    ATA
  );
  const [agentPda, agentBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    PROGRAM
  );
  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(1), 0);
  const [taskPda, taskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agentPda.toBuffer(), taskId],
    PROGRAM
  );

  const vaultData = Buffer.alloc(90);
  createHash("sha256")
    .update("account:Vault")
    .digest()
    .copy(vaultData, 0, 0, 8);
  owner.toBuffer().copy(vaultData, 8);
  mint.toBuffer().copy(vaultData, 40);
  vaultId.copy(vaultData, 72);
  vaultData.writeBigUInt64LE(BigInt(300000), 80);
  vaultData[89] = vaultBump;
  const treasuryData = Buffer.alloc(165);
  mint.toBuffer().copy(treasuryData, 0);
  vault.toBuffer().copy(treasuryData, 32);
  treasuryData.writeBigUInt64LE(BigInt(400000), 64);
  treasuryData[108] = 1;
  const vaultAccount: AccountInfo<Buffer> = {
    data: vaultData,
    owner: PROGRAM,
    executable: false,
    lamports: 1000000,
    rentEpoch: 0,
  };
  const treasuryAccount: AccountInfo<Buffer> = {
    data: treasuryData,
    owner: TOKEN,
    executable: false,
    lamports: 1000000,
    rentEpoch: 0,
  };
  const agent: Record<string, unknown> = {
    vault,
    authority,
    active: true,
    bump: agentBump,
  };
  const task: Record<string, unknown> = {
    vault,
    agent: agentPda,
    taskId: BigInt(1),
    recipient,
    budget: BigInt(250000),
    spent: BigInt(10000),
    nextNonce: BigInt(0),
    expiresAt: BigInt(NOW + 7200),
    active: true,
    bump: taskBump,
  };
  const calls = { agent: 0, task: 0 };
  const args = {
    rpc: {
      getGenesisHash: async () => GENESIS,
      async getAccountInfo(address: PublicKey, commitment: "confirmed") {
        assert.equal(commitment, "confirmed");
        if (address.equals(vault)) return vaultAccount;
        if (address.equals(treasury)) return treasuryAccount;
        return null;
      },
    },
    accounts: {
      async fetchAgent(address: PublicKey): Promise<unknown> {
        calls.agent++;
        assert(address.equals(agentPda));
        return agent;
      },
      async fetchTask(address: PublicKey): Promise<unknown> {
        calls.task++;
        assert(address.equals(taskPda));
        return task;
      },
    },
    expectedDevnetGenesisHash: GENESIS,
    trustedScope: {
      network: "devnet" as const,
      vault: vault.toBase58(),
      principalId: "developer:invoice-service",
      nowUnix: NOW,
    },
    input: {
      requestId: "invoice_1042",
      agentAuthority: authority.toBase58(),
      taskId: "1",
      recipient: recipient.toBase58(),
      amountBaseUnits: "10000",
      expiresAtUnix: String(NOW + 3600),
    },
  };
  return {
    args,
    agent,
    task,
    vaultData,
    calls,
    owner,
    authority,
    recipient,
    vault,
    agentPda,
    taskPda,
  };
}

test("accepts only a verified unpaused vault with active agent and task", async () => {
  const f = fixture();
  const result = await verifyModelAPaymentIntentPolicy(f.args);
  assert.equal(result.vault.vault, f.vault.toBase58());
  assert.equal(result.vault.owner, f.owner.toBase58());
  assert.equal(result.agentPda, f.agentPda.toBase58());
  assert.equal(result.taskPda, f.taskPda.toBase58());
  assert.equal(result.remainingBaseUnits, "240000");
  assert.equal(result.nextNonce, "0");
  assert.deepEqual(f.calls, { agent: 1, task: 1 });
});

test("rejects untrusted chain, scope, and vault before agent lookup", async () => {
  const f = fixture();
  await assert.rejects(
    verifyModelAPaymentIntentPolicy({
      ...f.args,
      expectedDevnetGenesisHash: "wrong-network",
    })
  );
  await assert.rejects(
    verifyModelAPaymentIntentPolicy({
      ...f.args,
      trustedScope: {
        ...f.args.trustedScope,
        vault: Keypair.generate().publicKey.toBase58(),
      },
    })
  );
  await assert.rejects(
    verifyModelAPaymentIntentPolicy({
      ...f.args,
      trustedScope: { ...f.args.trustedScope, network: "localnet" as "devnet" },
    })
  );
  assert.deepEqual(f.calls, { agent: 0, task: 0 });
});

test("rejects a paused vault and an invalid treasury invariant", async () => {
  const f = fixture();
  f.vaultData[88] = 1;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.vaultData[88] = 0;
  f.vaultData.writeBigUInt64LE(BigInt(900000), 80);
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
});

test("rejects inactive or forged agent accounts", async () => {
  const f = fixture();
  f.agent.active = false;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.agent.active = true;
  f.agent.bump = -1;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.agent.bump = 256;
  f.agent.vault = Keypair.generate().publicKey;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
});

test("rejects wrong recipient, inactive task and forged task binding", async () => {
  const f = fixture();
  f.task.recipient = Keypair.generate().publicKey;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.task.recipient = f.recipient;
  f.task.active = false;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.task.active = true;
  f.task.agent = Keypair.generate().publicKey;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
});

test("rejects expired task, request beyond task expiry and insufficient remaining budget", async () => {
  const f = fixture();
  f.task.expiresAt = BigInt(NOW - 1);
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.task.expiresAt = BigInt(NOW + 100);
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.task.expiresAt = BigInt(NOW + 7200);
  f.task.spent = BigInt(249999);
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
  f.task.spent = BigInt(250001);
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
});

test("rejects invalid request values and unsafe numeric account values", async () => {
  const f = fixture();
  await assert.rejects(
    verifyModelAPaymentIntentPolicy({
      ...f.args,
      input: { ...f.args.input, amountBaseUnits: 10000 },
    })
  );
  f.task.nextNonce = Number.MAX_SAFE_INTEGER + 2;
  await assert.rejects(verifyModelAPaymentIntentPolicy(f.args));
});
