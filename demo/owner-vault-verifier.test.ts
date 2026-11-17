import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  Keypair, PublicKey, type AccountInfo,
} from "@solana/web3.js";
import {
  verifyOwnerVaultOnChain, type ConfirmedAccountReader,
} from "./owner-vault-verifier";

const PROGRAM_ID = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function fixture() {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const id = BigInt(8001);
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(id);
  const [vault, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), idBytes], PROGRAM_ID
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM
  );
  const vaultData = Buffer.alloc(90);
  createHash("sha256").update("account:Vault").digest().copy(vaultData, 0, 0, 8);
  owner.toBuffer().copy(vaultData, 8);
  mint.toBuffer().copy(vaultData, 40);
  vaultData.writeBigUInt64LE(id, 72);
  vaultData.writeBigUInt64LE(BigInt(250_000), 80);
  vaultData[89] = bump;
  const treasuryData = Buffer.alloc(165);
  mint.toBuffer().copy(treasuryData, 0);
  vault.toBuffer().copy(treasuryData, 32);
  treasuryData.writeBigUInt64LE(BigInt(1_000_000), 64);
  treasuryData[108] = 1;
  const vaultAccount = {
    data: vaultData, owner: PROGRAM_ID, executable: false,
    lamports: 1_000_000, rentEpoch: 0,
  } satisfies AccountInfo<Buffer>;
  const treasuryAccount = {
    data: treasuryData, owner: TOKEN_PROGRAM, executable: false,
    lamports: 1_000_000, rentEpoch: 0,
  } satisfies AccountInfo<Buffer>;
  const rpc: ConfirmedAccountReader = {
    async getAccountInfo(address, commitment) {
      assert.equal(commitment, "confirmed");
      if (address.equals(vault)) return vaultAccount;
      if (address.equals(treasury)) return treasuryAccount;
      return null;
    },
  };
  const read = () => verifyOwnerVaultOnChain({
    rpc, ownerAddress: owner.toBase58(), vaultAddress: vault.toBase58(),
  });
  return { owner, mint, vault, treasury, vaultAccount, treasuryAccount, rpc, read };
}

test("valid owner and canonical treasury produce scoped data", async () => {
  const f = fixture();
  const value = await f.read();
  assert.equal(value.owner, f.owner.toBase58());
  assert.equal(value.vault, f.vault.toBase58());
  assert.equal(value.vaultId, "8001");
  assert.equal(value.treasury, f.treasury.toBase58());
  assert.equal(value.mint, f.mint.toBase58());
  assert.equal(value.treasuryBalanceBaseUnits, "1000000");
  assert.equal(value.totalReservedBaseUnits, "250000");
  assert.equal(value.paused, false);
});

test("rejects a different wallet even with a valid vault address", async () => {
  const f = fixture();
  await assert.rejects(() => verifyOwnerVaultOnChain({
    rpc: f.rpc, ownerAddress: Keypair.generate().publicKey.toBase58(),
    vaultAddress: f.vault.toBase58(),
  }), /not a verified owner-controlled/);
});

test("rejects an account controlled by a different program", async () => {
  const f = fixture();
  f.vaultAccount.owner = Keypair.generate().publicKey;
  await assert.rejects(f.read, /not a verified owner-controlled/);
});

test("rejects forged discriminator, wrong bump and noncanonical PDA", async () => {
  const f = fixture();
  f.vaultAccount.data[0] ^= 1;
  await assert.rejects(f.read, /not a verified owner-controlled/);
  f.vaultAccount.data[0] ^= 1;
  f.vaultAccount.data[89] ^= 1;
  await assert.rejects(f.read, /not a verified owner-controlled/);
  f.vaultAccount.data[89] ^= 1;
  const otherVault = Keypair.generate().publicKey;
  await assert.rejects(() => verifyOwnerVaultOnChain({
    rpc: { async getAccountInfo() { return f.vaultAccount; } },
    ownerAddress: f.owner.toBase58(), vaultAddress: otherVault.toBase58(),
  }), /not a verified owner-controlled/);
});

test("rejects a treasury with the wrong mint, vault authority or token-program owner", async () => {
  const f = fixture();
  f.treasuryAccount.data[0] ^= 1;
  await assert.rejects(f.read, /not a verified owner-controlled/);
  f.treasuryAccount.data[0] ^= 1;
  f.treasuryAccount.data[32] ^= 1;
  await assert.rejects(f.read, /not a verified owner-controlled/);
  f.treasuryAccount.data[32] ^= 1;
  f.treasuryAccount.owner = Keypair.generate().publicKey;
  await assert.rejects(f.read, /not a verified owner-controlled/);
});

test("rejects invalid token state or reserved amount exceeding treasury balance", async () => {
  const f = fixture();
  f.treasuryAccount.data[108] = 0;
  await assert.rejects(f.read, /not a verified owner-controlled/);
  f.treasuryAccount.data[108] = 1;
  f.vaultAccount.data.writeBigUInt64LE(BigInt(2_000_000), 80);
  await assert.rejects(f.read, /not a verified owner-controlled/);
});

test("rejects missing treasury and missing vault", async () => {
  const f = fixture();
  const missingTreasury: ConfirmedAccountReader = {
    async getAccountInfo(address) {
      return address.equals(f.vault) ? f.vaultAccount : null;
    },
  };
  await assert.rejects(() => verifyOwnerVaultOnChain({
    rpc: missingTreasury, ownerAddress: f.owner.toBase58(),
    vaultAddress: f.vault.toBase58(),
  }), /not a verified owner-controlled/);
  await assert.rejects(() => verifyOwnerVaultOnChain({
    rpc: { async getAccountInfo() { return null; } },
    ownerAddress: f.owner.toBase58(), vaultAddress: f.vault.toBase58(),
  }), /not a verified owner-controlled/);
});
