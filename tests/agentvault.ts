import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
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

  it("rejects cross-owner Vault PDA substitution", async () => {
    const id = new BN(10);

    // Generate a victim identity.
    const victim = Keypair.generate();

    // The victim's legitimate Vault PDA.
    const [victimVaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        victim.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // The attacker's legitimate Vault PDA.
    // The provider wallet acts as the attacker.
    const [attackerVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // The two owners must have different PDA addresses.
    assert.ok(!victimVaultPda.equals(attackerVaultPda));

    // Neither Vault should exist before the attack.
    const victimBefore = await provider.connection.getAccountInfo(
      victimVaultPda
    );

    const attackerBefore = await provider.connection.getAccountInfo(
      attackerVaultPda
    );

    assert.strictEqual(victimBefore, null);
    assert.strictEqual(attackerBefore, null);

    // Attack: Bob signs as himself but supplies Alice's PDA.
    await assert.rejects(
      async () => {
        await program.methods
          .initializeVault(id)
          .accountsPartial({
            owner, // Attacker signs using provider wallet
            vault: victimVaultPda, // Victim's PDA
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

        // Anchor ConstraintSeeds error: 2006.
        assert.match(details, /ConstraintSeeds|2006|0x7d6|seeds constraint/i);

        return true;
      }
    );

    // Verify the failed attack created neither Vault.
    const victimAfter = await provider.connection.getAccountInfo(
      victimVaultPda
    );

    const attackerAfter = await provider.connection.getAccountInfo(
      attackerVaultPda
    );

    assert.strictEqual(victimAfter, null);
    assert.strictEqual(attackerAfter, null);
  });

  it("initializes a vault with ID zero", async () => {
    const zeroVaultId = new BN(0);

    // Derive the PDA for Vault ID 0.
    const [zeroVaultPda, zeroBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        zeroVaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Vault ID 0 and Vault ID 1 must have different PDAs.
    assert.ok(!zeroVaultPda.equals(vaultPda));

    // Verify the zero-ID Vault does not exist.
    const before = await provider.connection.getAccountInfo(zeroVaultPda);

    assert.strictEqual(before, null);

    // Initialize Vault ID 0.
    await program.methods
      .initializeVault(zeroVaultId)
      .accountsPartial({
        owner,
        vault: zeroVaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fetch and verify the initialized Vault.
    const zeroVault = await program.account.vault.fetch(zeroVaultPda);

    assert.ok(zeroVault.owner.equals(owner));
    assert.ok(zeroVault.tokenMint.equals(tokenMint));
    assert.ok(zeroVault.vaultId.eq(zeroVaultId));
    assert.ok(zeroVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(zeroVault.paused, false);
    assert.strictEqual(zeroVault.bump, zeroBump);

    // Confirm the original Vault ID 1 is unaffected.
    const originalVault = await program.account.vault.fetch(vaultPda);

    assert.ok(originalVault.vaultId.eq(vaultId));
    assert.ok(originalVault.owner.equals(owner));
  });

  it("initializes a vault with maximum u64 ID", async () => {
    // Maximum unsigned 64-bit integer.
    const maxVaultId = new BN("18446744073709551615");

    // Encode the vault ID as 8-byte little-endian.
    const vaultIdBytes = maxVaultId.toArrayLike(Buffer, "le", 8);

    // Maximum u64 should produce eight 0xff bytes.
    assert.strictEqual(vaultIdBytes.toString("hex"), "ffffffffffffffff");

    // Derive the correct Vault PDA.
    const [maxVaultPda, maxBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), vaultIdBytes],
      program.programId
    );

    // Ensure it differs from the original Vault ID 1.
    assert.ok(!maxVaultPda.equals(vaultPda));

    // The Vault should not exist before initialization.
    const before = await provider.connection.getAccountInfo(maxVaultPda);

    assert.strictEqual(before, null);

    // Initialize with maximum u64 ID.
    await program.methods
      .initializeVault(maxVaultId)
      .accountsPartial({
        owner,
        vault: maxVaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fetch the initialized Vault.
    const maxVault = await program.account.vault.fetch(maxVaultPda);

    // Verify all stored fields.
    assert.ok(maxVault.owner.equals(owner));
    assert.ok(maxVault.tokenMint.equals(tokenMint));
    assert.ok(maxVault.vaultId.eq(maxVaultId));
    assert.ok(maxVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(maxVault.paused, false);
    assert.strictEqual(maxVault.bump, maxBump);

    // Verify the original Vault is unaffected.
    const originalVault = await program.account.vault.fetch(vaultPda);

    assert.ok(originalVault.vaultId.eq(vaultId));
    assert.ok(originalVault.owner.equals(owner));
  });

  it("initializes a treasury controlled by the Vault PDA", async () => {
    // STEP 1: Fetch the existing Vault.
    const vault = await program.account.vault.fetch(vaultPda);

    assert.ok(vault.owner.equals(owner));
    assert.ok(vault.tokenMint.equals(tokenMint));

    // STEP 2: Derive the treasury Associated Token Account.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true, // Vault PDA is an off-curve authority.
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("Vault PDA:", vaultPda.toBase58());
    console.log("Treasury ATA:", treasuryAta.toBase58());
    console.log("RPC endpoint:", provider.connection.rpcEndpoint);

    // STEP 3: Verify the treasury does not already exist.
    const before = await provider.connection.getAccountInfo(
      treasuryAta,
      "processed"
    );

    assert.strictEqual(
      before,
      null,
      "Treasury must not exist before initialization"
    );

    // STEP 4: Execute treasury initialization.
    // Use default RPC settings while investigating the
    // previous blockhash and confirmation errors.
    const tx = await program.methods
      .initializeTreasury()
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Treasury transaction:", tx);

    // STEP 5: Inspect the transaction status.
    const statuses = await provider.connection.getSignatureStatuses([tx], {
      searchTransactionHistory: true,
    });

    const status = statuses.value[0];

    console.log("Transaction status:", status);

    // STEP 6: Check treasury visibility at both commitments.
    const processedInfo = await provider.connection.getAccountInfo(
      treasuryAta,
      "processed"
    );

    const confirmedInfo = await provider.connection.getAccountInfo(
      treasuryAta,
      "confirmed"
    );

    console.log("Treasury exists at processed:", processedInfo !== null);

    console.log("Treasury exists at confirmed:", confirmedInfo !== null);

    if (processedInfo) {
      console.log("Treasury program owner:", processedInfo.owner.toBase58());

      console.log("Treasury data length:", processedInfo.data.length);
    }

    // STEP 7: Verify transaction execution.
    assert.ok(status, "Treasury transaction status was not found");

    assert.strictEqual(
      status.err,
      null,
      "Treasury initialization transaction failed"
    );

    assert.ok(
      processedInfo,
      "Treasury ATA was not created at processed commitment"
    );

    // STEP 8: Decode the treasury SPL token account.
    const treasury = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 9: Verify token authority.
    assert.ok(
      treasury.owner.equals(vaultPda),
      "Treasury authority must be the Vault PDA"
    );

    // STEP 10: Verify token mint.
    assert.ok(
      treasury.mint.equals(tokenMint),
      "Treasury mint must match the Vault mint"
    );

    // STEP 11: Verify initial balance.
    assert.strictEqual(
      treasury.amount.toString(),
      "0",
      "New treasury balance must be zero"
    );

    // STEP 12: Verify token account initialization.
    assert.strictEqual(treasury.isInitialized, true);

    // STEP 13: Verify the account is owned by SPL Token.
    assert.ok(
      processedInfo.owner.equals(TOKEN_PROGRAM_ID),
      "Treasury account must be owned by the SPL Token Program"
    );

    // Classic SPL Token accounts occupy 165 bytes.
    assert.strictEqual(processedInfo.data.length, 165);

    // STEP 14: Ensure Vault accounting remains unchanged.
    const updatedVault = await program.account.vault.fetch(vaultPda);

    assert.ok(updatedVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(updatedVault.paused, false);

    console.log("Treasury initialization verified successfully!");
  });

  it("rejects duplicate treasury initialization", async () => {
    // Derive the existing treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 1: Verify the treasury already exists.
    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.ok(treasuryBefore.owner.equals(vaultPda));
    assert.ok(treasuryBefore.mint.equals(tokenMint));

    const balanceBefore = treasuryBefore.amount;

    // STEP 2: Attempt to initialize the same treasury again.
    await assert.rejects(async () => {
      await program.methods
        .initializeTreasury()
        .accountsPartial({
          owner,
          vault: vaultPda,
          tokenMint,
          treasury: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    // STEP 3: Verify the original treasury remains intact.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.ok(treasuryAfter.owner.equals(vaultPda));
    assert.ok(treasuryAfter.mint.equals(tokenMint));

    // No funds should be added or removed.
    assert.strictEqual(
      treasuryAfter.amount.toString(),
      balanceBefore.toString()
    );

    assert.strictEqual(treasuryAfter.isInitialized, true);

    console.log("Duplicate treasury initialization rejected");
  });

  it("deposits SPL tokens into the Vault treasury", async () => {
    // STEP 1: Define amounts in base units.
    // Our test mint has 6 decimals.
    const mintAmount = 1_000_000;
    const depositAmount = new BN(400_000);

    // STEP 2: Derive the owner's token account.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 3: Derive the Vault's treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 4: Check the treasury's initial balance.
    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "0");
    assert.ok(treasuryBefore.owner.equals(vaultPda));

    // Our existing tests have not created the owner's ATA.
    const ownerAtaBefore = await provider.connection.getAccountInfo(
      ownerTokenAta,
      "processed"
    );

    assert.strictEqual(ownerAtaBefore, null);

    // STEP 5: Prepare the instruction to create the owner's ATA.
    const createOwnerAtaIx = createAssociatedTokenAccountInstruction(
      owner,
      ownerTokenAta,
      owner,
      tokenMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Mint test tokens to the owner's ATA.
    // The test mint authority is the owner.
    const mintTokensIx = createMintToInstruction(
      tokenMint,
      ownerTokenAta,
      owner,
      mintAmount,
      [],
      TOKEN_PROGRAM_ID
    );

    // STEP 7: Execute all three actions in one transaction:
    //   1. Create owner's token account.
    //   2. Mint 1 token to the owner.
    //   3. Deposit 0.4 tokens into the treasury.
    const tx = await program.methods
      .depositTokens(depositAmount)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        ownerTokenAccount: ownerTokenAta,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([createOwnerAtaIx, mintTokensIx])
      .rpc();

    console.log("Deposit transaction:", tx);

    // STEP 8: Read the owner's final token balance.
    const ownerTokenAccount = await getAccount(
      provider.connection,
      ownerTokenAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 9: Read the treasury's final token balance.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 10: Verify the owner's remaining balance.
    assert.strictEqual(ownerTokenAccount.amount.toString(), "600000");

    // STEP 11: Verify the treasury received the deposit.
    assert.strictEqual(treasuryAfter.amount.toString(), "400000");

    // STEP 12: Verify the treasury's authority and mint.
    assert.ok(treasuryAfter.owner.equals(vaultPda));
    assert.ok(treasuryAfter.mint.equals(tokenMint));

    // STEP 13: Verify Vault accounting remains unchanged.
    const updatedVault = await program.account.vault.fetch(vaultPda);

    assert.ok(updatedVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(updatedVault.paused, false);

    console.log("Owner balance:", ownerTokenAccount.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("SPL token deposit verified successfully!");
  });

  it("rejects a zero-amount deposit", async () => {
    // STEP 1: Derive the owner's token account.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 2: Derive the Vault treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 3: Record balances before the invalid deposit.
    const ownerBefore = await getAccount(
      provider.connection,
      ownerTokenAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 4: Attempt to deposit zero tokens.
    await assert.rejects(
      async () => {
        await program.methods
          .depositTokens(new BN(0))
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint,
            ownerTokenAccount: ownerTokenAta,
            treasury: treasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // Verify our custom Rust error caused the rejection.
        assert.match(
          details,
          /InvalidDepositAmount|Deposit amount must be greater than zero/i
        );

        return true;
      }
    );

    // STEP 5: Fetch balances after the rejected deposit.
    const ownerAfter = await getAccount(
      provider.connection,
      ownerTokenAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 6: Verify neither balance changed.
    assert.strictEqual(
      ownerAfter.amount.toString(),
      ownerBefore.amount.toString()
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 7: Verify Vault reservations remain unchanged.
    const vault = await program.account.vault.fetch(vaultPda);

    assert.ok(vault.totalReserved.eq(new BN(0)));

    console.log("Zero-amount deposit rejected correctly!");
    console.log("Owner balance:", ownerAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("rejects deposits exceeding the owner's token balance", async () => {
    // STEP 1: Derive the owner's SPL token account.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 2: Derive the Vault treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 3: Record balances before the attempted deposit.
    const ownerBefore = await getAccount(
      provider.connection,
      ownerTokenAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 4: Request one base unit more than the owner has.
    const insufficientAmount = new BN(ownerBefore.amount.toString()).add(
      new BN(1)
    );

    assert.ok(insufficientAmount.gt(new BN(ownerBefore.amount.toString())));

    // STEP 5: Attempt the deposit.
    await assert.rejects(
      async () => {
        await program.methods
          .depositTokens(insufficientAmount)
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint,
            ownerTokenAccount: ownerTokenAta,
            treasury: treasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      },
      (error: any) => {
        const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
          "\n"
        );

        // Confirm the Token Program rejected the transfer
        // because the source account lacks sufficient funds.
        assert.match(
          details,
          /insufficient funds|insufficient balance|custom program error: 0x1/i
        );

        return true;
      }
    );

    // STEP 6: Fetch balances after the rejected transaction.
    const ownerAfter = await getAccount(
      provider.connection,
      ownerTokenAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 7: Verify the owner's balance did not change.
    assert.strictEqual(
      ownerAfter.amount.toString(),
      ownerBefore.amount.toString()
    );

    // STEP 8: Verify the treasury received nothing.
    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 9: Verify Vault reservations remain unchanged.
    const vault = await program.account.vault.fetch(vaultPda);

    assert.ok(vault.totalReserved.eq(new BN(0)));

    console.log("Insufficient-balance deposit rejected!");
    console.log("Attempted amount:", insufficientAmount.toString());
    console.log("Owner balance:", ownerAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });
});
