import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { strict as assert } from "assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Vault Initialization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(1);

  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  let tokenMint: PublicKey;

  before(async () => {
    tokenMint = await createMint(
      provider.connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
  });

  it("initializes a vault with correct state", async () => {
    const tx = await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Vault initialized:", tx);

    const vault = await program.account.vault.fetch(vaultPda);

    assert.ok(vault.owner.equals(owner));
    assert.ok(vault.tokenMint.equals(tokenMint));
    assert.ok(vault.vaultId.eq(vaultId));
    assert.ok(vault.totalReserved.eq(new BN(0)));
    assert.strictEqual(vault.paused, false);
    assert.strictEqual(vault.bump, vaultBump);
  });

  it("rejects duplicate initialization", async () => {
    await assert.rejects(async () => {
      await program.methods
        .initializeVault(vaultId)
        .accountsPartial({
          owner,
          vault: vaultPda,
          tokenMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });
  });

  it("allows the same owner to create multiple vaults", async () => {
    const secondVaultId = new BN(2);

    const [secondVaultPda, secondBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        secondVaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Different vault IDs should derive different PDAs.
    assert.ok(!secondVaultPda.equals(vaultPda));

    // Initialize the second vault.
    await program.methods
      .initializeVault(secondVaultId)
      .accountsPartial({
        owner,
        vault: secondVaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fetch the newly created vault.
    const secondVault = await program.account.vault.fetch(secondVaultPda);

    // Verify all important fields.
    assert.ok(secondVault.owner.equals(owner));
    assert.ok(secondVault.tokenMint.equals(tokenMint));
    assert.ok(secondVault.vaultId.eq(secondVaultId));
    assert.ok(secondVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(secondVault.paused, false);
    assert.strictEqual(secondVault.bump, secondBump);

    // Ensure the original vault remains unchanged.
    const originalVault = await program.account.vault.fetch(vaultPda);

    assert.ok(originalVault.vaultId.eq(vaultId));
    assert.ok(originalVault.owner.equals(owner));
  });

  it("rejects initialization with an incorrect Vault PDA", async () => {
    const id = new BN(3);
    const wrongId = new BN(4);

    // Correct PDA for Vault ID 3
    const [correctVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Incorrect PDA derived using Vault ID 4
    const [wrongVaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        wrongId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Confirm the addresses are different.
    assert.ok(!correctVaultPda.equals(wrongVaultPda));

    // Verify the intended Vault does not already exist.
    const before = await provider.connection.getAccountInfo(correctVaultPda);
    assert.strictEqual(before, null);

    // Try initializing ID 3 using the PDA for ID 4.
    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner,
            vault: wrongVaultPda,
            tokenMint,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
        ].join(" ");

        // Anchor error 2006: ConstraintSeeds
        assert.match(details, /ConstraintSeeds|2006|0x7d6|seeds constraint/i);

        return true;
      }
    );

    // A failed transaction must not create either Vault.
    const correctAccount = await provider.connection.getAccountInfo(
      correctVaultPda
    );

    const wrongAccount = await provider.connection.getAccountInfo(
      wrongVaultPda
    );

    assert.strictEqual(correctAccount, null);
    assert.strictEqual(wrongAccount, null);
  });

  it("rejects a Vault PDA derived with incorrect byte order", async () => {
    const id = new BN(5);

    // Correct PDA using little-endian bytes.
    const [correctVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Incorrect PDA using big-endian bytes.
    const [wrongEndianPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "be", 8)],
      program.programId
    );

    // Both encodings must produce different addresses.
    assert.ok(!correctVaultPda.equals(wrongEndianPda));

    const before = await provider.connection.getAccountInfo(correctVaultPda);
    assert.strictEqual(before, null);

    // Attempt initialization using the incorrect PDA.
    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner,
            vault: wrongEndianPda,
            tokenMint,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
        ].join(" ");

        assert.match(details, /ConstraintSeeds|2006|0x7d6|seeds constraint/i);

        return true;
      }
    );

    // Neither PDA should have been initialized.
    const correctAccount = await provider.connection.getAccountInfo(
      correctVaultPda
    );

    const wrongAccount = await provider.connection.getAccountInfo(
      wrongEndianPda
    );

    assert.strictEqual(correctAccount, null);
    assert.strictEqual(wrongAccount, null);
  });
});
