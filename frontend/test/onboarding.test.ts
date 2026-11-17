import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Buffer } from "buffer";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildVaultCreationInstructions,
  decodeOwnedVault,
  deriveTreasury,
  deriveVault,
  encodeU64LE,
  isInitializedLegacyMint,
} from "../src/onboarding";

test("vault ID uses Anchor u64 little-endian and rejects overflow", () => {
  assert.deepEqual([...encodeU64LE(0x0102030405060708n)], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.throws(() => encodeU64LE(-1n), RangeError);
  assert.throws(() => encodeU64LE(1n << 64n), RangeError);
});

test("canonical owner-specific PDA and ATA match published seed formulas", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const id = 123456789n;
  const [vault] = deriveVault(owner, id);
  const [expectedVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), Buffer.from(encodeU64LE(id))],
    DEFAULT_PROGRAM_ID
  );
  assert.equal(vault.toBase58(), expectedVault.toBase58());
  assert.notEqual(deriveVault(Keypair.generate().publicKey, id)[0].toBase58(), vault.toBase58());
  assert.equal(
    deriveTreasury(vault, mint).toBase58(),
    PublicKey.findProgramAddressSync(
      [vault.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0].toBase58()
  );
});

test("two ordered Anchor instructions match IDL discriminators and account metas", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const id = 0x0102030405060708n;
  const { vault, treasury, instructions } = buildVaultCreationInstructions({ owner, mint, vaultId: id });
  assert.equal(instructions.length, 2);
  assert.deepEqual([...instructions[0].data], [48, 191, 163, 44, 71, 129, 63, 164, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...instructions[1].data], [124, 186, 211, 195, 85, 165, 129, 166]);
  assert.deepEqual(instructions[0].keys.map((k) => k.pubkey.toBase58()), [
    owner.toBase58(), vault.toBase58(), mint.toBase58(), SystemProgram.programId.toBase58(),
  ]);
  assert.deepEqual(instructions[1].keys.map((k) => k.pubkey.toBase58()), [
    owner.toBase58(), vault.toBase58(), mint.toBase58(), treasury.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(),
  ]);
  assert.deepEqual(instructions[1].keys.map((k) => [k.isSigner, k.isWritable]), [
    [true, true], [false, false], [false, false], [false, true], [false, false], [false, false], [false, false],
  ]);
});

test("vault discovery validates Anchor discriminator, owner, PDA, and bump", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const id = 55n;
  const [address, bump] = deriveVault(owner, id);
  const data = Buffer.alloc(90);
  createHash("sha256").update("account:Vault").digest().copy(data, 0, 0, 8);
  owner.toBuffer().copy(data, 8);
  mint.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(id, 72);
  data.writeBigUInt64LE(2000n, 80);
  data[88] = 1;
  data[89] = bump;
  const record = decodeOwnedVault(address, data, owner);
  assert.ok(record);
  assert.equal(record.vaultId, "55");
  assert.equal(record.tokenMint, mint.toBase58());
  assert.equal(record.totalReservedBaseUnits, "2000");
  assert.equal(record.paused, true);
  assert.equal(decodeOwnedVault(Keypair.generate().publicKey, data, owner), null);
  assert.equal(decodeOwnedVault(address, data, Keypair.generate().publicKey), null);
  data[89] ^= 1;
  assert.equal(decodeOwnedVault(address, data, owner), null);
  data[89] ^= 1;
  data[0] ^= 1;
  assert.equal(decodeOwnedVault(address, data, owner), null);
});

test("legacy mint validation rejects Token-2022 or uninitialized accounts", () => {
  const info = {
    owner: TOKEN_PROGRAM_ID,
    data: Buffer.alloc(82),
  } as Parameters<typeof isInitializedLegacyMint>[0];
  assert.equal(isInitializedLegacyMint(info), false);
  assert.ok(info);
  info.data[45] = 1;
  assert.equal(isInitializedLegacyMint(info), true);
  assert.equal(isInitializedLegacyMint({ ...info, owner: Keypair.generate().publicKey }), false);
  assert.equal(isInitializedLegacyMint(null), false);
});
