import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "buffer";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, TOKEN_PROGRAM_ID, deriveTreasury } from "../src/onboarding";
import {
  buildCreateTaskInstruction,
  buildRegisterAgentInstruction,
  deriveAgentPda,
  deriveTaskPda,
  parseExpiryHours,
  parseTokenAmount,
  parseU64Id,
} from "../src/owner-management";

test("exact decimal token budgets preserve fractional base units without rounding", () => {
  assert.equal(parseTokenAmount("0.01", 6), BigInt(10_000));
  assert.equal(parseTokenAmount("1.000001", 6), BigInt(1_000_001));
  assert.equal(parseTokenAmount("9007199254.740993", 6), BigInt("9007199254740993"));
  assert.throws(() => parseTokenAmount("0.0000001", 6));
  assert.throws(() => parseTokenAmount("1e3", 6));
  assert.throws(() => parseTokenAmount("-1", 6));
  assert.throws(() => parseTokenAmount("0", 6));
  assert.throws(() => parseTokenAmount("01", 6));
});

test("registration instruction uses exact discriminator and owner/agent PDA", () => {
  const owner = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const { agent, instruction } = buildRegisterAgentInstruction({ owner, vault, authority });
  const expected = PublicKey.findProgramAddressSync([
    Buffer.from("agent"), vault.toBuffer(), authority.toBuffer(),
  ], DEFAULT_PROGRAM_ID)[0];
  assert.equal(agent.toBase58(), expected.toBase58());
  assert.equal(agent.toBase58(), deriveAgentPda(vault, authority).toBase58());
  assert.deepEqual([...instruction.data.subarray(0, 8)], [135, 157, 66, 195, 2, 113, 175, 30]);
  assert.equal(new PublicKey(instruction.data.subarray(8, 40)).toBase58(), authority.toBase58());
  assert.deepEqual(instruction.keys.map((entry) => entry.pubkey.toBase58()), [
    owner.toBase58(), vault.toBase58(), agent.toBase58(), SystemProgram.programId.toBase58(),
  ]);
  assert.deepEqual(instruction.keys.map((entry) => [entry.isSigner, entry.isWritable]), [
    [true, true], [false, true], [false, true], [false, false],
  ]);
});

test("task instruction matches deployed IDL order, seeds and exact borsh args", () => {
  const owner = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const agent = deriveAgentPda(vault, authority);
  const mint = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const taskId = BigInt(12345);
  const budget = BigInt(250001);
  const expiresAt = BigInt(1793437557);
  const { task, instruction } = buildCreateTaskInstruction({
    owner, vault, agent, mint, recipient, taskId, budget, expiresAt,
  });
  assert.equal(task.toBase58(), deriveTaskPda(agent, taskId).toBase58());
  assert.deepEqual([...instruction.data.subarray(0, 8)], [194, 80, 6, 180, 232, 127, 48, 171]);
  assert.equal(instruction.data.length, 64);
  assert.equal(instruction.data.readBigUInt64LE(8), taskId);
  assert.equal(instruction.data.readBigUInt64LE(16), budget);
  assert.equal(new PublicKey(instruction.data.subarray(24, 56)).toBase58(), recipient.toBase58());
  assert.equal(instruction.data.readBigInt64LE(56), expiresAt);
  assert.deepEqual(instruction.keys.map((entry) => entry.pubkey.toBase58()), [
    owner.toBase58(), vault.toBase58(), agent.toBase58(), mint.toBase58(),
    deriveTreasury(vault, mint).toBase58(), task.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(),
  ]);
  assert.deepEqual(instruction.keys.map((entry) => [entry.isSigner, entry.isWritable]), [
    [true, true], [false, true], [false, false], [false, false],
    [false, false], [false, true], [false, false], [false, false],
  ]);
});

test("u64 identifiers and task expiries reject invalid representations", () => {
  assert.equal(parseU64Id("18446744073709551615"), (BigInt(1) << BigInt(64)) - BigInt(1));
  assert.throws(() => parseU64Id("18446744073709551616"));
  assert.throws(() => parseU64Id("1.0"));
  assert.throws(() => parseU64Id("-1"));
  assert.equal(parseExpiryHours("24", 1_000_000), BigInt(86_400 + 1000));
  assert.throws(() => parseExpiryHours("0"));
  assert.throws(() => parseExpiryHours("-2"));
  assert.throws(() => parseExpiryHours("1.5"));
});

test("task budget and expiry bounds fail closed before transaction creation", () => {
  const owner = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const fixed = { owner, vault, agent, mint, recipient, taskId: BigInt(1), expiresAt: BigInt(1) };
  assert.throws(() => buildCreateTaskInstruction({ ...fixed, budget: BigInt(0) }));
  assert.throws(() => buildCreateTaskInstruction({ ...fixed, budget: BigInt(1) << BigInt(64) }));
  assert.throws(() => buildCreateTaskInstruction({ ...fixed, budget: BigInt(1), expiresAt: BigInt(0) }));
});

test("owner management refuses a mismatched wallet before any RPC call or transaction", async () => {
  const { registerOwnerAgent } = await import("../src/owner-management");
  const owner = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  let sent = false;
  const wallet = {
    publicKey: other,
    async connect() { return { publicKey: other }; },
    async signAndSendTransaction() { sent = true; return { signature: "not-expected" }; },
  };
  const snapshot = {
    network: "devnet" as const, owner: owner.toBase58(), vault: vault.toBase58(),
    vaultId: "8001", tokenMint: Keypair.generate().publicKey.toBase58(),
    treasury: Keypair.generate().publicKey.toBase58(), decimals: 6, paused: false,
    availableBaseUnits: "1000000",
  };
  await assert.rejects(() => registerOwnerAgent({
    wallet, snapshot, sessionOwner: snapshot.owner, authority: other.toBase58(),
  }), /Connected wallet and authenticated owner/);
  assert.equal(sent, false);
});


test("agent PDA cannot be registered as its own signing authority", async () => {
  const { registerOwnerAgent } = await import("../src/owner-management");
  const owner = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const offCurve = deriveAgentPda(vault, Keypair.generate().publicKey);
  assert.equal(PublicKey.isOnCurve(offCurve.toBytes()), false);
  assert.throws(
    () => buildRegisterAgentInstruction({ owner, vault, authority: offCurve }),
    /signing-wallet public key, not a PDA/
  );
  const wallet = {
    publicKey: owner,
    async connect() { return { publicKey: owner }; },
    async signAndSendTransaction() { throw new Error("Should not prompt Phantom"); },
  };
  const snapshot = {
    network: "devnet" as const, owner: owner.toBase58(), vault: vault.toBase58(),
    vaultId: "8001", tokenMint: Keypair.generate().publicKey.toBase58(),
    treasury: Keypair.generate().publicKey.toBase58(), decimals: 6, paused: false,
    availableBaseUnits: "1000000",
  };
  await assert.rejects(
    () => registerOwnerAgent({
      wallet, snapshot, sessionOwner: snapshot.owner, authority: offCurve.toBase58(),
    }),
    /signing-wallet public key, not a PDA/
  );
});
