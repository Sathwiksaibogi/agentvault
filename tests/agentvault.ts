import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
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

  it("rejects initialization with an invalid SPL token mint", async () => {
    const id = new BN(6);

    // Derive the correct Vault PDA.
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Verify the Vault does not already exist.
    const before = await provider.connection.getAccountInfo(vaultPda);
    assert.strictEqual(before, null);

    // The System Program is NOT a valid SPL Token mint.
    const invalidMint = SystemProgram.programId;

    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint: invalidMint,
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

        // Anchor error 3007: AccountOwnedByWrongProgram.
        assert.match(
          details,
          /AccountOwnedByWrongProgram|3007|0xbbf|owned by the wrong program/i
        );

        return true;
      }
    );

    // The failed transaction must not create a Vault.
    const after = await provider.connection.getAccountInfo(vaultPda);
    assert.strictEqual(after, null);
  });

  it("rejects initialization with a nonexistent token mint", async () => {
    const id = new BN(7);

    // Derive the correct Vault PDA.
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Generate a public key without creating an on-chain account.
    const nonexistentMint = Keypair.generate().publicKey;

    // Verify that the mint account does not exist.
    const mintBefore = await provider.connection.getAccountInfo(
      nonexistentMint
    );
    assert.strictEqual(mintBefore, null);

    // Verify the Vault does not exist.
    const vaultBefore = await provider.connection.getAccountInfo(vaultPda);
    assert.strictEqual(vaultBefore, null);

    // Attempt initialization with the nonexistent mint.
    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint: nonexistentMint,
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

        // Rejection may occur during transaction processing
        // or Anchor's account initialization validation.
        assert.match(
          details,
          /AccountNotInitialized|3012|0xbc4|missing|not found|does not exist|not initialized/i
        );

        return true;
      }
    );

    // The failed transaction must not initialize the Vault.
    const vaultAfter = await provider.connection.getAccountInfo(vaultPda);
    assert.strictEqual(vaultAfter, null);

    // The invalid mint must still not exist.
    const mintAfter = await provider.connection.getAccountInfo(nonexistentMint);
    assert.strictEqual(mintAfter, null);
  });

  it("rejects vault initialization without the owner's signature", async () => {
    const id = new BN(8);

    // Generate a new owner identity.
    const unsignedOwner = Keypair.generate();

    // Derive this owner's Vault PDA.
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        unsignedOwner.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Fund the owner so insufficient SOL cannot explain
    // the expected rejection.
    const airdropSignature = await provider.connection.requestAirdrop(
      unsignedOwner.publicKey,
      LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(airdropSignature, "confirmed");

    // Construct the instruction claiming this owner.
    const instruction = await program.methods
      .initializeVault(id)
      .accountsPartial({
        owner: unsignedOwner.publicKey,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Verify that the instruction requires the owner to sign.
    const ownerMeta = instruction.keys.find((account) =>
      account.pubkey.equals(unsignedOwner.publicKey)
    );

    assert.ok(ownerMeta, "Owner account must be present");
    assert.strictEqual(ownerMeta.isSigner, true);

    // Do NOT provide unsignedOwner in .signers().
    // The provider wallet is a different identity.
    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner: unsignedOwner.publicKey,
            vault: vaultPda,
            tokenMint,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const message = String(error?.message ?? error);

        assert.match(message, /signature|signer|not signed/i);

        return true;
      }
    );

    // Verify that the rejected attempt created no Vault.
    const vaultAccount = await provider.connection.getAccountInfo(vaultPda);

    assert.strictEqual(vaultAccount, null);
  });

  it("allows different owners to initialize vaults with the same ID", async () => {
    const secondOwner = Keypair.generate();

    // Both owners use Vault ID 1.
    const id = new BN(1);

    // Original owner's Vault PDA.
    const [originalVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Second owner's Vault PDA.
    const [secondVaultPda, secondBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        secondOwner.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // The addresses must be different.
    assert.ok(!originalVaultPda.equals(secondVaultPda));

    // Fund the second owner to cover Vault account rent.
    const airdropSignature = await provider.connection.requestAirdrop(
      secondOwner.publicKey,
      LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(airdropSignature, "confirmed");

    // Verify the second Vault has not yet been created.
    const before = await provider.connection.getAccountInfo(secondVaultPda);

    assert.strictEqual(before, null);

    // Initialize the second owner's Vault.
    // Unlike Test 8, this owner actually signs.
    await program.methods
      .initializeVault(id)
      .accountsPartial({
        owner: secondOwner.publicKey,
        vault: secondVaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([secondOwner])
      .rpc();

    // Verify the second Vault's state.
    const secondVault = await program.account.vault.fetch(secondVaultPda);

    assert.ok(secondVault.owner.equals(secondOwner.publicKey));
    assert.ok(secondVault.tokenMint.equals(tokenMint));
    assert.ok(secondVault.vaultId.eq(id));
    assert.ok(secondVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(secondVault.paused, false);
    assert.strictEqual(secondVault.bump, secondBump);

    // Confirm the original owner's Vault remains unchanged.
    const originalVault = await program.account.vault.fetch(originalVaultPda);

    assert.ok(originalVault.owner.equals(owner));
    assert.ok(originalVault.vaultId.eq(id));
  });
});
