import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { RPC_URL } from "./runtime-config";
import { webAgents } from "../frontend/src/webAgents";

function u64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(offset, true);
}

function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigInt64(offset, true);
}

function readPubkey(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function verifyDiscriminator(data: Uint8Array, accountName: string) {
  const expected = createHash("sha256")
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8);

  assert.deepEqual(
    Buffer.from(data.subarray(0, 8)),
    expected,
    `${accountName} discriminator mismatch`
  );
}

async function main() {
  assert.equal(
    process.env.AGENTVAULT_NETWORK,
    "devnet",
    "Use AGENTVAULT_NETWORK=devnet"
  );

  const connection = new Connection(RPC_URL, "confirmed");

  const program = new PublicKey(webAgents.programId);
  const owner = new PublicKey(webAgents.owner);
  const vault = new PublicKey(webAgents.vault);
  const mint = new PublicKey(webAgents.mint);
  const treasury = new PublicKey(webAgents.treasury);

  console.log("=== VAULT 2 ON-CHAIN VERIFICATION ===");
  console.log("RPC:", RPC_URL);
  console.log("Owner:", owner.toBase58());
  console.log("Vault:", vault.toBase58());

  const [derivedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      Buffer.from(u64LE(BigInt(webAgents.vaultId))),
    ],
    program
  );

  assert.ok(derivedVault.equals(vault));

  const vaultInfo = await connection.getAccountInfo(vault);

  assert.ok(vaultInfo, "Vault does not exist");
  assert.ok(vaultInfo.owner.equals(program));
  assert.equal(vaultInfo.data.length, 90);

  verifyDiscriminator(vaultInfo.data, "Vault");

  assert.ok(readPubkey(vaultInfo.data, 8).equals(owner));
  assert.ok(readPubkey(vaultInfo.data, 40).equals(mint));
  assert.equal(readU64(vaultInfo.data, 72), BigInt(webAgents.vaultId));
  assert.equal(vaultInfo.data[88], 0, "Vault is paused");

  const derivedTreasury = getAssociatedTokenAddressSync(mint, vault, true);

  assert.ok(derivedTreasury.equals(treasury));

  const treasuryAccount = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(treasuryAccount.owner.equals(vault));
  assert.ok(treasuryAccount.mint.equals(mint));

  let expectedReserved = BigInt(0);

  for (const config of webAgents.agents) {
    const authority = new PublicKey(config.authority);
    const recipient = new PublicKey(config.recipient);

    const taskId = BigInt(config.taskId);
    const budget = BigInt(config.budgetBaseUnits);

    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
      program
    );

    const [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), agentPda.toBuffer(), Buffer.from(u64LE(taskId))],
      program
    );

    const agentInfo = await connection.getAccountInfo(agentPda);
    assert.ok(agentInfo, `${config.name} agent missing`);
    assert.ok(agentInfo.owner.equals(program));
    assert.equal(agentInfo.data.length, 74);

    verifyDiscriminator(agentInfo.data, "Agent");

    assert.ok(readPubkey(agentInfo.data, 8).equals(vault));
    assert.ok(readPubkey(agentInfo.data, 40).equals(authority));
    assert.equal(agentInfo.data[72], 1, "Agent inactive");

    const taskInfo = await connection.getAccountInfo(taskPda);
    assert.ok(taskInfo, `${config.name} task missing`);
    assert.ok(taskInfo.owner.equals(program));
    assert.equal(taskInfo.data.length, 146);

    verifyDiscriminator(taskInfo.data, "Task");

    assert.ok(readPubkey(taskInfo.data, 8).equals(vault));
    assert.ok(readPubkey(taskInfo.data, 40).equals(agentPda));
    assert.equal(readU64(taskInfo.data, 72), taskId);
    assert.ok(readPubkey(taskInfo.data, 80).equals(recipient));
    assert.equal(readU64(taskInfo.data, 112), budget);
    assert.equal(taskInfo.data[144], 1, "Task inactive");

    const spent = readU64(taskInfo.data, 120);
    const expiresAt = readI64(taskInfo.data, 128);
    const nextNonce = readU64(taskInfo.data, 136);

    assert.ok(
      expiresAt > BigInt(Math.floor(Date.now() / 1000)),
      `${config.name} task has expired`
    );

    expectedReserved += budget - spent;

    console.log(`\n--- ${config.name} ---`);
    console.log("Agent PDA:", agentPda.toBase58());
    console.log("Task PDA:", taskPda.toBase58());
    console.log("Authority:", authority.toBase58());
    console.log("Recipient:", recipient.toBase58());
    console.log("Budget:", budget.toString());
    console.log("Spent:", spent.toString());
    console.log("Next nonce:", nextNonce.toString());
    console.log("Expires:", new Date(Number(expiresAt) * 1000).toISOString());
    console.log("Active: true");
  }

  const reserved = readU64(vaultInfo.data, 80);

  assert.equal(
    reserved,
    expectedReserved,
    "Vault reservation does not match remaining task budgets"
  );

  assert.ok(
    reserved <= treasuryAccount.amount,
    "Reservations exceed treasury balance"
  );

  console.log("\n=== VERIFIED VAULT 2 ===");
  console.log("Treasury balance:", treasuryAccount.amount.toString());
  console.log("Reserved:", reserved.toString());
  console.log("Unreserved:", (treasuryAccount.amount - reserved).toString());
  console.log("Verified agents:", webAgents.agents.length);
  console.log("No transaction submitted.");
}

main().catch((error: unknown) => {
  console.error(
    "Verification failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
