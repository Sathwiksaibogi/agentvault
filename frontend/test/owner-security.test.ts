import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "buffer";
import {
  Keypair, PublicKey, Transaction, type Connection,
} from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID, deriveTreasury, deriveVault,
} from "../src/onboarding";
import {
  buildDeactivateAgentInstruction,
  buildRevokeTaskInstruction,
  buildSetVaultPausedInstruction,
  deactivateOwnerAgent, revokeOwnerTask, setOwnerVaultPaused,
} from "../src/owner-security";
import { deriveAgentPda, deriveTaskPda } from "../src/owner-management";

const agentDisc = Buffer.from([47, 166, 112, 147, 155, 197, 86, 7]);
const taskDisc = Buffer.from([79, 34, 229, 55, 88, 90, 55, 84]);
const vaultDisc = Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]);

function fixture() {
  const owner = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const vaultId = BigInt(8001);
  const [vault, vaultBump] = deriveVault(owner.publicKey, vaultId);
  const authority = Keypair.generate().publicKey;
  const agentPda = deriveAgentPda(vault, authority);
  const [, agentBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()], DEFAULT_PROGRAM_ID
  );
  const taskId = BigInt(1);
  const taskPda = deriveTaskPda(agentPda, taskId);
  const [, taskBump] = PublicKey.findProgramAddressSync([
    Buffer.from("task"), agentPda.toBuffer(), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])
  ], DEFAULT_PROGRAM_ID);
  const vaultData = Buffer.alloc(90);
  vaultDisc.copy(vaultData, 0);
  owner.publicKey.toBuffer().copy(vaultData, 8);
  mint.toBuffer().copy(vaultData, 40);
  new DataView(vaultData.buffer, vaultData.byteOffset, vaultData.byteLength).setBigUint64(72, vaultId, true);
  new DataView(vaultData.buffer, vaultData.byteOffset, vaultData.byteLength).setBigUint64(80, BigInt(10_000), true);
  vaultData[88] = 0; vaultData[89] = vaultBump;
  const agentData = Buffer.alloc(74);
  agentDisc.copy(agentData, 0);
  vault.toBuffer().copy(agentData, 8);
  authority.toBuffer().copy(agentData, 40);
  agentData[72] = 1; agentData[73] = agentBump;
  const taskData = Buffer.alloc(146);
  taskDisc.copy(taskData, 0);
  vault.toBuffer().copy(taskData, 8);
  agentPda.toBuffer().copy(taskData, 40);
  new DataView(taskData.buffer, taskData.byteOffset, taskData.byteLength).setBigUint64(72, taskId, true);
  Keypair.generate().publicKey.toBuffer().copy(taskData, 80);
  new DataView(taskData.buffer, taskData.byteOffset, taskData.byteLength).setBigUint64(112, BigInt(10_000), true);
  new DataView(taskData.buffer, taskData.byteOffset, taskData.byteLength).setBigUint64(120, BigInt(0), true);
  new DataView(taskData.buffer, taskData.byteOffset, taskData.byteLength).setBigInt64(128, BigInt(1_800_000_000), true);
  new DataView(taskData.buffer, taskData.byteOffset, taskData.byteLength).setBigUint64(136, BigInt(0), true);
  taskData[144] = 1; taskData[145] = taskBump;
  const snapshot = {
    network: "devnet" as const, owner: owner.publicKey.toBase58(),
    vault: vault.toBase58(), vaultId: "8001", tokenMint: mint.toBase58(),
    treasury: deriveTreasury(vault, mint).toBase58(), decimals: 6,
    paused: false, availableBaseUnits: "1000000",
  };
  const agent = { authority: authority.toBase58(), agentPda: agentPda.toBase58(),
    active: true, tasks: [{ taskPda: taskPda.toBase58(), taskId: "1", active: true }] };
  function info(data: Buffer, program = DEFAULT_PROGRAM_ID) {
    return { data, owner: program, executable: false, lamports: 1, rentEpoch: 0 };
  }
  let broadcasts = 0;
  let nextState: (() => void) | undefined;
  const connection = {
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEFAULT_PROGRAM_ID)) return { ...info(Buffer.alloc(0)), executable: true };
      if (address.equals(vault)) return info(vaultData);
      if (address.equals(agentPda)) return info(agentData);
      if (address.equals(taskPda)) return info(taskData);
      return null;
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      broadcasts++;
      const tx = Transaction.from(Buffer.from(raw));
      assert.ok(tx.verifySignatures());
      return "mock-confirmed-signature";
    },
    async confirmTransaction() { nextState?.(); return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [null] }; },
  } as unknown as Connection;
  const wallet = {
    publicKey: owner.publicKey,
    async connect() { return { publicKey: owner.publicKey }; },
    async signAndSendTransaction() { throw new Error("Phantom broadcast must never be used"); },
    async signTransaction(tx: Transaction) { tx.sign(owner); return tx; },
  };
  return {
    owner, vault, authority, mint, agentPda, taskPda, snapshot, agent, connection, wallet,
    vaultData, agentData, taskData,
    getBroadcasts: () => broadcasts,
    afterConfirm(callback: () => void) { nextState = callback; },
  };
}

test("revocation instruction matches Anchor discriminator, account ordering and flags", () => {
  const f = fixture();
  const ix = buildRevokeTaskInstruction({ owner: f.owner.publicKey, vault: f.vault,
    agent: f.agentPda, task: f.taskPda });
  assert.deepEqual([...ix.data], [188, 70, 249, 6, 56, 255, 109, 40]);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [
    f.owner.publicKey, f.vault, f.agentPda, f.taskPda,
  ].map((k) => k.toBase58()));
  assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [
    [true, false], [false, true], [false, false], [false, true],
  ]);
});

test("deactivation and pause/resume instructions retain exact on-chain account metas", () => {
  const f = fixture();
  const deact = buildDeactivateAgentInstruction({ owner: f.owner.publicKey,
    vault: f.vault, agent: f.agentPda });
  assert.deepEqual([...deact.data], [205, 171, 239, 225, 82, 126, 96, 166]);
  assert.deepEqual(deact.keys.map((k) => [k.isSigner, k.isWritable]), [
    [true, false], [false, false], [false, true],
  ]);
  for (const paused of [true, false]) {
    const ix = buildSetVaultPausedInstruction({ owner: f.owner.publicKey, vault: f.vault, paused });
    assert.deepEqual([...ix.data], [239, 131, 203, 69, 243, 11, 234, 153, Number(paused)]);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [
      [true, false], [false, true],
    ]);
  }
});

test("owner-signature checks reject another wallet before any RPC", async () => {
  const f = fixture();
  const wrongWallet = { ...f.wallet, publicKey: Keypair.generate().publicKey };
  await assert.rejects(() => revokeOwnerTask({ wallet: wrongWallet,
    snapshot: f.snapshot, sessionOwner: f.snapshot.owner,
    agent: f.agent, task: f.agent.tasks[0], connection: f.connection,
  }), /Connected wallet and authenticated owner do not match/);
  assert.equal(f.getBroadcasts(), 0);
});

test("canonical task revocation confirms inactive account without bypassing signed message", async () => {
  const f = fixture();
  f.afterConfirm(() => { f.taskData[144] = 0; new DataView(f.vaultData.buffer, f.vaultData.byteOffset, f.vaultData.byteLength).setBigUint64(80, BigInt(0), true); });
  const result = await revokeOwnerTask({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, agent: f.agent, task: f.agent.tasks[0], connection: f.connection });
  assert.equal(result.account, f.taskPda.toBase58());
  assert.equal(f.getBroadcasts(), 1);
});

test("rejects a stale task PDA or mismatched agent before broadcast", async () => {
  const f = fixture();
  const foreignTask = { ...f.agent.tasks[0], taskPda: Keypair.generate().publicKey.toBase58() };
  await assert.rejects(() => revokeOwnerTask({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, agent: f.agent, task: foreignTask, connection: f.connection }),
  /canonical/);
  assert.equal(f.getBroadcasts(), 0);
});

test("confirmed agent deactivation independently verifies inactive on-chain state", async () => {
  const f = fixture();
  f.afterConfirm(() => { f.agentData[72] = 0; });
  const result = await deactivateOwnerAgent({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, agent: f.agent, connection: f.connection });
  assert.equal(result.account, f.agentPda.toBase58());
  assert.equal(f.getBroadcasts(), 1);
});

test("pauses a verified owner vault and rejects stale pause state", async () => {
  const f = fixture();
  f.afterConfirm(() => { f.vaultData[88] = 1; });
  const result = await setOwnerVaultPaused({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, paused: true, connection: f.connection });
  assert.equal(result.account, f.vault.toBase58());
  assert.equal(f.getBroadcasts(), 1);
  await assert.rejects(() => setOwnerVaultPaused({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, paused: true, connection: f.connection }), /changed; refresh/);
  assert.equal(f.getBroadcasts(), 1);
});

test("does not report success if the account was not updated after confirmation", async () => {
  const f = fixture();
  await assert.rejects(() => deactivateOwnerAgent({ wallet: f.wallet, snapshot: f.snapshot,
    sessionOwner: f.snapshot.owner, agent: f.agent, connection: f.connection }),
  /confirmed, but state not verified/);
  assert.equal(f.getBroadcasts(), 1);
});
