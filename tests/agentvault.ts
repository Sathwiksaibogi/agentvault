import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createAccount,
  mintTo,
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
  // Test identities for independent AI agents.
  const agentAKeypair = Keypair.generate();
  const agentBKeypair = Keypair.generate();
  // Shared test configuration for Agent A's first task.
  const taskA1Id = new BN(1);
  const taskA1Budget = new BN(150_000);
  const taskA1Recipient = Keypair.generate().publicKey;
  const taskA1ExpiresAt = new BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

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

  it("rejects deposits using an incorrect token mint", async () => {
    // STEP 1: Create a different, valid SPL token mint.
    const wrongMint = await createMint(
      provider.connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    assert.ok(!wrongMint.equals(tokenMint));

    // STEP 2: Derive the owner's existing token account.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 3: Derive the existing treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 4: Verify the Vault's configured mint.
    const vaultBefore = await program.account.vault.fetch(vaultPda);

    assert.ok(vaultBefore.tokenMint.equals(tokenMint));

    // STEP 5: Record balances before the invalid deposit.
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

    // STEP 6: Attempt to use the incorrect mint.
    await assert.rejects(
      async () => {
        await program.methods
          .depositTokens(new BN(100_000))
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint: wrongMint,
            ownerTokenAccount: ownerTokenAta,
            treasury: treasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.error?.errorCode?.number ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // Anchor should reject the Vault's mint mismatch.
        assert.match(
          details,
          /ConstraintHasOne|2001|0x7d1|has one constraint/i
        );

        return true;
      }
    );

    // STEP 7: Fetch balances after the rejection.
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

    // STEP 8: Verify no tokens moved.
    assert.strictEqual(
      ownerAfter.amount.toString(),
      ownerBefore.amount.toString()
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 9: Verify the Vault configuration is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda);

    assert.ok(vaultAfter.tokenMint.equals(tokenMint));
    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));

    console.log("Incorrect token mint rejected correctly!");
    console.log("Configured mint:", tokenMint.toBase58());
    console.log("Rejected mint:", wrongMint.toBase58());
    console.log("Owner balance:", ownerAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("rejects deposits from an unauthorized source token account", async () => {
    // STEP 1: Create a different token authority.
    const foreignAuthority = Keypair.generate();

    assert.ok(!foreignAuthority.publicKey.equals(owner));

    // STEP 2: Create a valid SPL token account owned by
    // the foreign authority, using the Vault's actual mint.
    const foreignTokenAccount = await createAccount(
      provider.connection,
      payer,
      tokenMint,
      foreignAuthority.publicKey,
      undefined,
      { commitment: "processed" },
      TOKEN_PROGRAM_ID
    );

    // STEP 3: Fund the foreign account with test tokens.
    // Our test wallet is the mint authority.
    await mintTo(
      provider.connection,
      payer,
      tokenMint,
      foreignTokenAccount,
      owner,
      100_000,
      [],
      { commitment: "processed" },
      TOKEN_PROGRAM_ID
    );

    // STEP 4: Derive the legitimate owner's token ATA.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Derive the Vault treasury.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Fetch all three token accounts.
    const foreignBefore = await getAccount(
      provider.connection,
      foreignTokenAccount,
      "processed",
      TOKEN_PROGRAM_ID
    );

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

    // The foreign account has the correct mint and funds,
    // but a different token authority.
    assert.ok(foreignBefore.mint.equals(tokenMint));
    assert.ok(foreignBefore.owner.equals(foreignAuthority.publicKey));

    assert.strictEqual(foreignBefore.amount.toString(), "100000");

    // STEP 7: Attempt to deposit Bob's tokens using
    // Alice's Vault owner signature.
    await assert.rejects(
      async () => {
        await program.methods
          .depositTokens(new BN(50_000))
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint,
            ownerTokenAccount: foreignTokenAccount,
            treasury: treasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.error?.errorCode?.number ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // Anchor's token authority constraint must reject it.
        assert.match(
          details,
          /ConstraintTokenOwner|2015|0x7df|token owner constraint/i
        );

        return true;
      }
    );

    // STEP 8: Read account balances after rejection.
    const foreignAfter = await getAccount(
      provider.connection,
      foreignTokenAccount,
      "processed",
      TOKEN_PROGRAM_ID
    );

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

    // STEP 9: Confirm that no tokens moved.
    assert.strictEqual(
      foreignAfter.amount.toString(),
      foreignBefore.amount.toString()
    );

    assert.strictEqual(
      ownerAfter.amount.toString(),
      ownerBefore.amount.toString()
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 10: Verify foreign account ownership is unchanged.
    assert.ok(foreignAfter.owner.equals(foreignAuthority.publicKey));

    // STEP 11: Verify Vault accounting is unaffected.
    const vaultAfter = await program.account.vault.fetch(vaultPda);

    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));

    console.log("Unauthorized source token account rejected!");
    console.log("Foreign balance:", foreignAfter.amount.toString());
    console.log("Owner balance:", ownerAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("rejects treasury destination substitution", async () => {
    // STEP 1: Derive the legitimate owner's token ATA.
    const ownerTokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 2: Derive the legitimate Vault treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 3: Create a non-associated SPL token account.
    // The account address has its own keypair, but its
    // SPL token authority will be the Vault PDA.
    const substituteTreasuryKeypair = Keypair.generate();

    const substituteTreasury = await createAccount(
      provider.connection,
      payer,
      tokenMint,
      vaultPda,
      substituteTreasuryKeypair, // Explicit keypair avoids ATA derivation.
      { commitment: "processed" },
      TOKEN_PROGRAM_ID
    );

    // It must be different from the legitimate treasury ATA.
    assert.ok(!substituteTreasury.equals(treasuryAta));

    // STEP 4: Verify the substitute is otherwise valid.
    const substituteBefore = await getAccount(
      provider.connection,
      substituteTreasury,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.ok(substituteBefore.mint.equals(tokenMint));
    assert.ok(substituteBefore.owner.equals(vaultPda));
    assert.strictEqual(substituteBefore.amount.toString(), "0");

    // STEP 5: Record existing balances.
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

    // STEP 6: Attempt to redirect a deposit.
    await assert.rejects(
      async () => {
        await program.methods
          .depositTokens(new BN(50_000))
          .accountsPartial({
            owner,
            vault: vaultPda,
            tokenMint,
            ownerTokenAccount: ownerTokenAta,
            treasury: substituteTreasury,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.error?.errorCode?.number ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // Reject the substituted ATA address.
        assert.match(
          details,
          /ConstraintAssociated|2009|0x7d9|associated token constraint/i
        );

        return true;
      }
    );

    // STEP 7: Fetch all balances after rejection.
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

    const substituteAfter = await getAccount(
      provider.connection,
      substituteTreasury,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 8: No tokens may move.
    assert.strictEqual(
      ownerAfter.amount.toString(),
      ownerBefore.amount.toString()
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      substituteAfter.amount.toString(),
      substituteBefore.amount.toString()
    );

    // STEP 9: Verify Vault accounting is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda);

    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));

    console.log("Treasury destination substitution rejected!");
    console.log("Owner balance:", ownerAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Substitute balance:", substituteAfter.amount.toString());
  });

  it("registers the first AI agent under the Vault", async () => {
    // STEP 1: Generate a signing identity for Agent A.
    const agentAuthority = agentAKeypair;

    // The agent must be different from the Vault owner.
    assert.ok(!agentAuthority.publicKey.equals(owner));

    // STEP 2: Derive Agent A's PDA.
    const [agentPda, agentBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAuthority.publicKey.toBuffer(),
      ],
      program.programId
    );

    console.log("Agent A authority:", agentAuthority.publicKey.toBase58());
    console.log("Agent A PDA:", agentPda.toBase58());

    // STEP 3: Verify the Agent account does not exist.
    const before = await provider.connection.getAccountInfo(
      agentPda,
      "processed"
    );

    assert.strictEqual(
      before,
      null,
      "Agent must not exist before registration"
    );

    // STEP 4: Register Agent A.
    // Only the Vault owner signs this transaction.
    const tx = await program.methods
      .registerAgent(agentAuthority.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Agent registration transaction:", tx);

    // STEP 5: Fetch the newly registered Agent account.
    const agent = await program.account.agent.fetch(agentPda, "processed");

    // STEP 6: Verify the Agent belongs to the correct Vault.
    assert.ok(
      agent.vault.equals(vaultPda),
      "Agent must belong to the expected Vault"
    );

    // STEP 7: Verify the registered signing authority.
    assert.ok(
      agent.authority.equals(agentAuthority.publicKey),
      "Agent authority must match the registered public key"
    );

    // STEP 8: Verify the Agent is active.
    assert.strictEqual(
      agent.active,
      true,
      "Newly registered Agent must be active"
    );

    // STEP 9: Verify the PDA bump.
    assert.strictEqual(agent.bump, agentBump);

    // STEP 10: Verify registration did not modify Vault state.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.owner.equals(owner));
    assert.ok(vaultAfter.tokenMint.equals(tokenMint));
    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));
    assert.strictEqual(vaultAfter.paused, false);

    console.log("Agent A registered successfully!");
    console.log("Agent active:", agent.active);
    console.log("Agent bump:", agent.bump);
  });

  it("registers a second independent agent under the same Vault", async () => {
    // STEP 1: Confirm Agent A and Agent B have different identities.
    assert.ok(!agentAKeypair.publicKey.equals(agentBKeypair.publicKey));

    // STEP 2: Derive Agent A's existing PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive Agent B's PDA.
    const [agentBPda, agentBBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Both agents belong to the same Vault,
    // but must have different PDA addresses.
    assert.ok(!agentAPda.equals(agentBPda));

    // STEP 4: Verify Agent A already exists.
    const agentABefore = await program.account.agent.fetch(
      agentAPda,
      "processed"
    );

    assert.ok(agentABefore.vault.equals(vaultPda));
    assert.ok(agentABefore.authority.equals(agentAKeypair.publicKey));
    assert.strictEqual(agentABefore.active, true);

    // STEP 5: Verify Agent B does not exist yet.
    const before = await provider.connection.getAccountInfo(
      agentBPda,
      "processed"
    );

    assert.strictEqual(before, null);

    // STEP 6: Register Agent B.
    const tx = await program.methods
      .registerAgent(agentBKeypair.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentBPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Agent B registration transaction:", tx);

    // STEP 7: Fetch both registered agents.
    const agentAAfter = await program.account.agent.fetch(
      agentAPda,
      "processed"
    );

    const agentB = await program.account.agent.fetch(agentBPda, "processed");

    // STEP 8: Verify Agent B belongs to the same Vault.
    assert.ok(agentB.vault.equals(vaultPda));

    // STEP 9: Verify Agent B has its own authority.
    assert.ok(agentB.authority.equals(agentBKeypair.publicKey));

    assert.strictEqual(agentB.active, true);
    assert.strictEqual(agentB.bump, agentBBump);

    // STEP 10: Verify Agent A was not modified.
    assert.ok(agentAAfter.vault.equals(agentABefore.vault));
    assert.ok(agentAAfter.authority.equals(agentABefore.authority));

    assert.strictEqual(agentAAfter.active, agentABefore.active);

    assert.strictEqual(agentAAfter.bump, agentABefore.bump);

    // STEP 11: Verify Vault accounting is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));
    assert.strictEqual(vaultAfter.paused, false);

    console.log("Agent A PDA:", agentAPda.toBase58());
    console.log("Agent B PDA:", agentBPda.toBase58());
    console.log("Both agents registered under the same Vault!");
  });

  it("rejects duplicate agent registration", async () => {
    // STEP 1: Derive the existing Agent A PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 2: Verify Agent A is already registered.
    const agentBefore = await program.account.agent.fetch(
      agentAPda,
      "processed"
    );

    assert.ok(agentBefore.vault.equals(vaultPda));

    assert.ok(agentBefore.authority.equals(agentAKeypair.publicKey));

    assert.strictEqual(agentBefore.active, true);

    // STEP 3: Attempt to register Agent A again.
    await assert.rejects(
      async () => {
        await program.methods
          .registerAgent(agentAKeypair.publicKey)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentAPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // The account initialization should fail
        // because the Agent PDA already exists.
        assert.match(
          details,
          /already in use|already initialized|already exists|AccountAlreadyInitialized|AccountDiscriminatorAlreadySet/i
        );

        return true;
      }
    );

    // STEP 4: Fetch Agent A after the rejected operation.
    const agentAfter = await program.account.agent.fetch(
      agentAPda,
      "processed"
    );

    // STEP 5: Verify Agent A was not modified.
    assert.ok(agentAfter.vault.equals(agentBefore.vault));

    assert.ok(agentAfter.authority.equals(agentBefore.authority));

    assert.strictEqual(agentAfter.active, agentBefore.active);

    assert.strictEqual(agentAfter.bump, agentBefore.bump);

    // STEP 6: Verify Vault accounting remains unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));
    assert.strictEqual(vaultAfter.paused, false);

    console.log("Duplicate agent registration rejected!");
    console.log("Existing Agent A PDA:", agentAPda.toBase58());
    console.log("Agent authority preserved:", agentAfter.authority.toBase58());
  });

  it("rejects agent registration by a non-owner", async () => {
    // STEP 1: Create an attacker wallet.
    const attacker = Keypair.generate();

    // Create an unrelated AI agent identity.
    const attackerAgentAuthority = Keypair.generate();

    assert.ok(!attacker.publicKey.equals(owner));

    // STEP 2: Derive the attempted Agent PDA.
    // The attacker is trying to register an agent
    // under the legitimate owner's Vault.
    const [attackerAgentPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        attackerAgentAuthority.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Verify the legitimate Vault owner.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    assert.ok(vaultBefore.owner.equals(owner));
    assert.ok(!vaultBefore.owner.equals(attacker.publicKey));

    // STEP 4: Verify the attempted Agent does not exist.
    const agentBefore = await provider.connection.getAccountInfo(
      attackerAgentPda,
      "processed"
    );

    assert.strictEqual(agentBefore, null);

    // STEP 5: Attempt unauthorized registration.
    await assert.rejects(
      async () => {
        await program.methods
          .registerAgent(attackerAgentAuthority.publicKey)
          .accountsPartial({
            owner: attacker.publicKey,
            vault: vaultPda,
            agent: attackerAgentPda,
            systemProgram: SystemProgram.programId,
          })
          // Give the attacker enough SOL to be a payer.
          // This transfer is atomic with the failing
          // registration and will be rolled back.
          .preInstructions([
            SystemProgram.transfer({
              fromPubkey: owner,
              toPubkey: attacker.publicKey,
              lamports: 20_000_000,
            }),
          ])
          // The attacker really signs the transaction.
          .signers([attacker])
          .rpc();
      },

      (error: any) => {
        const errorCode = error?.error?.errorCode?.code;

        if (errorCode) {
          // The attacker's public key produces an incorrect Vault PDA.
          assert.strictEqual(errorCode, "ConstraintSeeds");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /ConstraintSeeds|seeds constraint|0x7d6|2006/i);
        }

        return true;
      }
    );

    // STEP 6: Verify no unauthorized Agent was created.
    const agentAfter = await provider.connection.getAccountInfo(
      attackerAgentPda,
      "processed"
    );

    assert.strictEqual(agentAfter, null);

    // STEP 7: Verify the Vault remains unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.owner.equals(vaultBefore.owner));

    assert.ok(vaultAfter.tokenMint.equals(vaultBefore.tokenMint));

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    assert.strictEqual(vaultAfter.paused, vaultBefore.paused);

    console.log("Unauthorized agent registration rejected!");
    console.log("Vault owner:", owner.toBase58());
    console.log("Attacker:", attacker.publicKey.toBase58());
  });

  it("rejects registration with an invalid agent authority", async () => {
    // STEP 1: Use the default all-zero public key.
    const invalidAuthority = SystemProgram.programId;

    assert.ok(invalidAuthority.equals(new PublicKey(new Uint8Array(32))));

    // STEP 2: Derive the correct PDA for this invalid authority.
    const [invalidAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vaultPda.toBuffer(), invalidAuthority.toBuffer()],
      program.programId
    );

    // STEP 3: Confirm this Agent account does not exist.
    const before = await provider.connection.getAccountInfo(
      invalidAgentPda,
      "processed"
    );

    assert.strictEqual(before, null);

    // STEP 4: Record the existing Vault state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    // STEP 5: Attempt registration using the invalid authority.
    await assert.rejects(
      async () => {
        await program.methods
          .registerAgent(invalidAuthority)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: invalidAgentPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const errorCode = error?.error?.errorCode?.code;

        if (errorCode) {
          assert.strictEqual(errorCode, "InvalidAgentAuthority");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(
            details,
            /InvalidAgentAuthority|Invalid agent authority public key/i
          );
        }

        return true;
      }
    );

    // STEP 6: Verify the rejected account was not created.
    const after = await provider.connection.getAccountInfo(
      invalidAgentPda,
      "processed"
    );

    assert.strictEqual(
      after,
      null,
      "Invalid Agent account must not be created"
    );

    // STEP 7: Verify the Vault remains unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.owner.equals(vaultBefore.owner));

    assert.ok(vaultAfter.tokenMint.equals(vaultBefore.tokenMint));

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    assert.strictEqual(vaultAfter.paused, vaultBefore.paused);

    console.log("Invalid agent authority rejected correctly!");
    console.log("Rejected authority:", invalidAuthority.toBase58());
    console.log("No invalid Agent account was created.");
  });

  it("rejects registration with an incorrect Agent PDA", async () => {
    // STEP 1: Create two distinct agent identities.
    const agentC = Keypair.generate();
    const otherAgent = Keypair.generate();

    assert.ok(!agentC.publicKey.equals(otherAgent.publicKey));

    // STEP 2: Derive the correct PDA for Agent C.
    const [correctAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vaultPda.toBuffer(), agentC.publicKey.toBuffer()],
      program.programId
    );

    // STEP 3: Derive a different PDA using another authority.
    // This is the address we will deliberately substitute.
    const [wrongAgentPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        otherAgent.publicKey.toBuffer(),
      ],
      program.programId
    );

    // The addresses must be different.
    assert.ok(!correctAgentPda.equals(wrongAgentPda));

    // STEP 4: Verify neither account exists.
    const correctBefore = await provider.connection.getAccountInfo(
      correctAgentPda,
      "processed"
    );

    const wrongBefore = await provider.connection.getAccountInfo(
      wrongAgentPda,
      "processed"
    );

    assert.strictEqual(correctBefore, null);
    assert.strictEqual(wrongBefore, null);

    // STEP 5: Record the original Vault state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    // STEP 6: Attempt to register Agent C using
    // the PDA derived from another agent's authority.
    await assert.rejects(
      async () => {
        await program.methods
          .registerAgent(agentC.publicKey)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: wrongAgentPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const errorCode = error?.error?.errorCode?.code;

        if (errorCode) {
          assert.strictEqual(errorCode, "ConstraintSeeds");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /ConstraintSeeds|seeds constraint|0x7d6|2006/i);
        }

        return true;
      }
    );

    // STEP 7: Verify no Agent account was created.
    const correctAfter = await provider.connection.getAccountInfo(
      correctAgentPda,
      "processed"
    );

    const wrongAfter = await provider.connection.getAccountInfo(
      wrongAgentPda,
      "processed"
    );

    assert.strictEqual(
      correctAfter,
      null,
      "Correct Agent PDA must remain uninitialized"
    );

    assert.strictEqual(
      wrongAfter,
      null,
      "Substituted Agent PDA must remain uninitialized"
    );

    // STEP 8: Verify the existing Agent A remains valid.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const agentA = await program.account.agent.fetch(agentAPda, "processed");

    assert.ok(agentA.vault.equals(vaultPda));
    assert.ok(agentA.authority.equals(agentAKeypair.publicKey));
    assert.strictEqual(agentA.active, true);

    // STEP 9: Verify the Vault remains unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.owner.equals(vaultBefore.owner));
    assert.ok(vaultAfter.tokenMint.equals(vaultBefore.tokenMint));

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    assert.strictEqual(vaultAfter.paused, vaultBefore.paused);

    console.log("Incorrect Agent PDA rejected correctly!");
    console.log("Expected Agent PDA:", correctAgentPda.toBase58());
    console.log("Rejected Agent PDA:", wrongAgentPda.toBase58());
  });

  it("allows the same agent authority under different Vaults", async () => {
    // STEP 1: Use the existing Agent A signing identity.
    const agentAuthority = agentAKeypair.publicKey;

    // STEP 2: Derive Agent A's existing registration
    // under our primary Vault.
    const [primaryAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vaultPda.toBuffer(), agentAuthority.toBuffer()],
      program.programId
    );

    const primaryAgentBefore = await program.account.agent.fetch(
      primaryAgentPda,
      "processed"
    );

    assert.ok(primaryAgentBefore.vault.equals(vaultPda));
    assert.ok(primaryAgentBefore.authority.equals(agentAuthority));

    // STEP 3: Create a second Vault ID.
    // Choose an unused ID for this integration test.
    const secondVaultId = new BN(2700);

    const [secondVaultPda, secondVaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        secondVaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    assert.ok(!secondVaultPda.equals(vaultPda));

    // STEP 4: Initialize the second Vault.
    await program.methods
      .initializeVault(secondVaultId)
      .accountsPartial({
        owner,
        vault: secondVaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const secondVault = await program.account.vault.fetch(
      secondVaultPda,
      "processed"
    );

    assert.ok(secondVault.owner.equals(owner));
    assert.ok(secondVault.tokenMint.equals(tokenMint));
    assert.ok(secondVault.vaultId.eq(secondVaultId));
    assert.strictEqual(secondVault.bump, secondVaultBump);

    // STEP 5: Derive Agent A's PDA under Vault 2.
    const [secondAgentPda, secondAgentBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        secondVaultPda.toBuffer(),
        agentAuthority.toBuffer(),
      ],
      program.programId
    );

    // Same signing authority, different Vault:
    // the Agent PDA must be different.
    assert.ok(!secondAgentPda.equals(primaryAgentPda));

    const agentBefore = await provider.connection.getAccountInfo(
      secondAgentPda,
      "processed"
    );

    assert.strictEqual(agentBefore, null);

    // STEP 6: Register the same Agent A authority
    // under the second Vault.
    const tx = await program.methods
      .registerAgent(agentAuthority)
      .accountsPartial({
        owner,
        vault: secondVaultPda,
        agent: secondAgentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Second Vault registration transaction:", tx);

    // STEP 7: Fetch Agent A's new registration.
    const secondAgent = await program.account.agent.fetch(
      secondAgentPda,
      "processed"
    );

    assert.ok(secondAgent.vault.equals(secondVaultPda));
    assert.ok(secondAgent.authority.equals(agentAuthority));
    assert.strictEqual(secondAgent.active, true);
    assert.strictEqual(secondAgent.bump, secondAgentBump);

    // STEP 8: Verify the first registration is unaffected.
    const primaryAgentAfter = await program.account.agent.fetch(
      primaryAgentPda,
      "processed"
    );

    assert.ok(primaryAgentAfter.vault.equals(vaultPda));

    assert.ok(primaryAgentAfter.authority.equals(agentAuthority));

    assert.strictEqual(primaryAgentAfter.active, primaryAgentBefore.active);

    assert.strictEqual(primaryAgentAfter.bump, primaryAgentBefore.bump);

    // STEP 9: Verify the two Vaults remain independent.
    const primaryVault = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const updatedSecondVault = await program.account.vault.fetch(
      secondVaultPda,
      "processed"
    );

    assert.ok(primaryVault.totalReserved.eq(new BN(0)));

    assert.ok(updatedSecondVault.totalReserved.eq(new BN(0)));

    assert.strictEqual(primaryVault.paused, false);
    assert.strictEqual(updatedSecondVault.paused, false);

    console.log("Same agent registered under two Vaults!");
    console.log("Agent authority:", agentAuthority.toBase58());
    console.log("Vault 1 Agent PDA:", primaryAgentPda.toBase58());
    console.log("Vault 2 Agent PDA:", secondAgentPda.toBase58());
  });

  it("creates a budget-reserved task for Agent A", async () => {
    // STEP 1: Derive Agent A's registered PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 2: Derive the task PDA.
    const [taskPda, taskBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 3: Derive the treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 4: Verify Agent A is registered and active.
    const agent = await program.account.agent.fetch(agentAPda, "processed");

    assert.ok(agent.vault.equals(vaultPda));
    assert.ok(agent.authority.equals(agentAKeypair.publicKey));
    assert.strictEqual(agent.active, true);

    // STEP 5: Verify this task does not already exist.
    const before = await provider.connection.getAccountInfo(
      taskPda,
      "processed"
    );

    assert.strictEqual(before, null);

    // STEP 6: Record treasury and Vault state before creation.
    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    assert.ok(vaultBefore.totalReserved.eq(new BN(0)));

    assert.ok(new BN(treasuryBefore.amount.toString()).gte(taskA1Budget));

    // STEP 7: Create the task and reserve its budget.
    const tx = await program.methods
      .createTask(taskA1Id, taskA1Budget, taskA1Recipient, taskA1ExpiresAt)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentAPda,
        tokenMint,
        treasury: treasuryAta,
        task: taskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Task creation transaction:", tx);

    // STEP 8: Fetch the newly created Task.
    const task = await program.account.task.fetch(taskPda, "processed");

    // STEP 9: Verify task identity and permissions.
    assert.ok(task.vault.equals(vaultPda));
    assert.ok(task.agent.equals(agentAPda));
    assert.ok(task.taskId.eq(taskA1Id));
    assert.ok(task.recipient.equals(taskA1Recipient));

    // STEP 10: Verify task budget and initial spending state.
    assert.ok(task.budget.eq(taskA1Budget));
    assert.ok(task.spent.eq(new BN(0)));
    assert.ok(task.expiresAt.eq(taskA1ExpiresAt));
    assert.ok(task.nextNonce.eq(new BN(0)));
    assert.strictEqual(task.active, true);
    assert.strictEqual(task.bump, taskBump);

    // STEP 11: Verify the Vault reserved the budget.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    const expectedReserved = vaultBefore.totalReserved.add(taskA1Budget);

    assert.ok(vaultAfter.totalReserved.eq(expectedReserved));

    // STEP 12: Verify no SPL tokens were transferred.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 13: Calculate remaining unreserved funds.
    const availableBalance = new BN(treasuryAfter.amount.toString()).sub(
      vaultAfter.totalReserved
    );

    assert.strictEqual(availableBalance.toString(), "250000");

    console.log("Agent A Task PDA:", taskPda.toBase58());
    console.log("Task budget:", task.budget.toString());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
    console.log("Available balance:", availableBalance.toString());
    console.log("Agent A task created successfully!");
  });

  it("reserves an independent task budget for Agent B", async () => {
    // STEP 1: Define Agent B's task parameters.
    const taskBId = new BN(1);
    const taskBBudget = new BN(100_000);
    const taskBRecipient = Keypair.generate().publicKey;

    const taskBExpiresAt = new BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

    // STEP 2: Derive the registered Agent A PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive the registered Agent B PDA.
    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    assert.ok(!agentAPda.equals(agentBPda));

    // STEP 4: Derive Agent A's existing task PDA.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive Agent B's new task PDA.
    const [taskBPda, taskBBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        taskBId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Both tasks use ID 1, but have different PDAs.
    assert.ok(!taskAPda.equals(taskBPda));

    // STEP 6: Confirm Agent B is registered and active.
    const agentB = await program.account.agent.fetch(agentBPda, "processed");

    assert.ok(agentB.vault.equals(vaultPda));
    assert.ok(agentB.authority.equals(agentBKeypair.publicKey));
    assert.strictEqual(agentB.active, true);

    // STEP 7: Verify Agent A's task already exists.
    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskABefore.agent.equals(agentAPda));
    assert.ok(taskABefore.budget.eq(taskA1Budget));

    // Agent B's task must not exist yet.
    const taskBBefore = await provider.connection.getAccountInfo(
      taskBPda,
      "processed"
    );

    assert.strictEqual(taskBBefore, null);

    // STEP 8: Derive the shared treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 9: Record treasury and Vault state.
    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    // Agent A has already reserved 150,000.
    assert.ok(vaultBefore.totalReserved.eq(taskA1Budget));

    assert.strictEqual(treasuryBefore.amount.toString(), "400000");

    // STEP 10: Register Agent B's task and reserve its budget.
    const tx = await program.methods
      .createTask(taskBId, taskBBudget, taskBRecipient, taskBExpiresAt)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentBPda,
        tokenMint,
        treasury: treasuryAta,
        task: taskBPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Agent B task transaction:", tx);

    // STEP 11: Verify Agent B's task state.
    const taskB = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskB.vault.equals(vaultPda));
    assert.ok(taskB.agent.equals(agentBPda));
    assert.ok(taskB.taskId.eq(taskBId));
    assert.ok(taskB.recipient.equals(taskBRecipient));

    assert.ok(taskB.budget.eq(taskBBudget));
    assert.ok(taskB.spent.eq(new BN(0)));
    assert.ok(taskB.expiresAt.eq(taskBExpiresAt));
    assert.ok(taskB.nextNonce.eq(new BN(0)));
    assert.strictEqual(taskB.active, true);
    assert.strictEqual(taskB.bump, taskBBump);

    // STEP 12: Verify cumulative reservation accounting.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    const expectedReserved = vaultBefore.totalReserved.add(taskBBudget);

    assert.ok(vaultAfter.totalReserved.eq(expectedReserved));

    assert.strictEqual(vaultAfter.totalReserved.toString(), "250000");

    // STEP 13: Verify the treasury balance did not change.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 14: Verify remaining unreserved balance.
    const available = new BN(treasuryAfter.amount.toString()).sub(
      vaultAfter.totalReserved
    );

    assert.strictEqual(available.toString(), "150000");

    // STEP 15: Verify Agent A's original task is unchanged.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAAfter.agent.equals(taskABefore.agent));
    assert.ok(taskAAfter.budget.eq(taskABefore.budget));
    assert.ok(taskAAfter.spent.eq(taskABefore.spent));
    assert.ok(taskAAfter.recipient.equals(taskABefore.recipient));
    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce));
    assert.strictEqual(taskAAfter.active, taskABefore.active);

    console.log("Agent A reserved:", taskAAfter.budget.toString());
    console.log("Agent B reserved:", taskB.budget.toString());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
    console.log("Available balance:", available.toString());
    console.log("Independent task reservations verified!");
  });

  it("rejects task budgets exceeding unreserved treasury funds", async () => {
    // STEP 1: Attempt an additional task for Agent B.
    const taskId = new BN(2);
    const excessiveBudget = new BN(150_001);
    const recipient = Keypair.generate().publicKey;

    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

    // STEP 2: Derive Agent A and Agent B PDAs.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive the new attempted Task PDA.
    const [rejectedTaskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        taskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive the existing task PDAs.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive the shared treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Read financial state before the attack.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    const taskBBefore = await program.account.task.fetch(taskBPda, "processed");

    // STEP 7: Verify the starting financial conditions.
    assert.strictEqual(vaultBefore.totalReserved.toString(), "250000");

    assert.strictEqual(treasuryBefore.amount.toString(), "400000");

    const available = new BN(treasuryBefore.amount.toString()).sub(
      vaultBefore.totalReserved
    );

    assert.strictEqual(available.toString(), "150000");

    // We're attempting to reserve ONE more unit than available.
    assert.ok(excessiveBudget.eq(available.add(new BN(1))));

    // The proposed task must not already exist.
    const rejectedTaskBefore = await provider.connection.getAccountInfo(
      rejectedTaskPda,
      "processed"
    );

    assert.strictEqual(rejectedTaskBefore, null);

    // STEP 8: Attempt the excessive reservation.
    await assert.rejects(
      async () => {
        await program.methods
          .createTask(taskId, excessiveBudget, recipient, expiresAt)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentBPda,
            tokenMint,
            treasury: treasuryAta,
            task: rejectedTaskPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "InsufficientUnreservedFunds");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(
            details,
            /InsufficientUnreservedFunds|Insufficient unreserved treasury balance/i
          );
        }

        return true;
      }
    );

    // STEP 9: Verify the rejected Task was not created.
    const rejectedTaskAfter = await provider.connection.getAccountInfo(
      rejectedTaskPda,
      "processed"
    );

    assert.strictEqual(rejectedTaskAfter, null);

    // STEP 10: Verify Vault reservations are unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    // STEP 11: Verify treasury tokens are unchanged.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    // STEP 12: Verify both existing tasks remain intact.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    const taskBAfter = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskAAfter.budget.eq(taskABefore.budget));
    assert.ok(taskAAfter.spent.eq(taskABefore.spent));
    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce));
    assert.strictEqual(taskAAfter.active, taskABefore.active);

    assert.ok(taskBAfter.budget.eq(taskBBefore.budget));
    assert.ok(taskBAfter.spent.eq(taskBBefore.spent));
    assert.ok(taskBAfter.nextNonce.eq(taskBBefore.nextNonce));
    assert.strictEqual(taskBAfter.active, taskBBefore.active);

    console.log("Over-reservation correctly rejected!");
    console.log("Attempted budget:", excessiveBudget.toString());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("rejects duplicate task creation without modifying the existing policy", async () => {
    // STEP 1: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 2: Derive Agent A's existing Task 1 PDA.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 3: Derive the canonical treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 4: Read the original task policy.
    const taskBefore = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskBefore.vault.equals(vaultPda));
    assert.ok(taskBefore.agent.equals(agentAPda));
    assert.ok(taskBefore.taskId.eq(taskA1Id));
    assert.ok(taskBefore.budget.eq(taskA1Budget));

    // STEP 5: Record Vault and treasury state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(vaultBefore.totalReserved.toString(), "250000");

    // STEP 6: Attempt to overwrite Task 1's permissions.
    const replacementBudget = new BN(50_000);
    const replacementRecipient = Keypair.generate().publicKey;

    const replacementExpiry = new BN(
      Math.floor(Date.now() / 1000) + 48 * 60 * 60
    );

    assert.ok(!replacementRecipient.equals(taskBefore.recipient));

    await assert.rejects(
      async () => {
        await program.methods
          .createTask(
            taskA1Id,
            replacementBudget,
            replacementRecipient,
            replacementExpiry
          )
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentAPda,
            tokenMint,
            treasury: treasuryAta,
            task: taskAPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const details = [
          error?.error?.errorCode?.code ?? "",
          error?.message ?? "",
          ...(error?.logs ?? []),
        ].join("\n");

        // Account initialization must fail because
        // this Task PDA is already initialized.
        assert.match(
          details,
          /already in use|already initialized|already exists|AccountAlreadyInitialized|AccountDiscriminatorAlreadySet/i
        );

        return true;
      }
    );

    // STEP 7: Verify the existing task still exists.
    const taskAfter = await program.account.task.fetch(taskAPda, "processed");

    // STEP 8: Verify the policy was not overwritten.
    assert.ok(taskAfter.vault.equals(taskBefore.vault));
    assert.ok(taskAfter.agent.equals(taskBefore.agent));
    assert.ok(taskAfter.taskId.eq(taskBefore.taskId));

    assert.ok(taskAfter.recipient.equals(taskBefore.recipient));
    assert.ok(taskAfter.budget.eq(taskBefore.budget));
    assert.ok(taskAfter.spent.eq(taskBefore.spent));

    assert.ok(taskAfter.expiresAt.eq(taskBefore.expiresAt));
    assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));

    assert.strictEqual(taskAfter.active, taskBefore.active);
    assert.strictEqual(taskAfter.bump, taskBefore.bump);

    // STEP 9: Verify the total reservation did not change.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    // STEP 10: Verify the treasury tokens did not change.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    console.log("Duplicate task creation rejected!");
    console.log("Original task PDA:", taskAPda.toBase58());
    console.log("Original budget:", taskAfter.budget.toString());
    console.log("Original recipient:", taskAfter.recipient.toBase58());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
  });

  it("rejects task creation with a zero budget", async () => {
    // STEP 1: Define invalid task parameters.
    const taskId = new BN(2);
    const zeroBudget = new BN(0);

    const recipient = Keypair.generate().publicKey;

    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

    // STEP 2: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive the proposed Task PDA.
    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive the treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Confirm the task doesn't exist.
    const taskBefore = await provider.connection.getAccountInfo(
      taskPda,
      "processed"
    );

    assert.strictEqual(taskBefore, null);

    // STEP 6: Record financial state before rejection.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(vaultBefore.totalReserved.toString(), "250000");

    // STEP 7: Attempt to create a zero-budget task.
    await assert.rejects(
      async () => {
        await program.methods
          .createTask(taskId, zeroBudget, recipient, expiresAt)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentAPda,
            tokenMint,
            treasury: treasuryAta,
            task: taskPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "InvalidTaskBudget");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(
            details,
            /InvalidTaskBudget|Task budget must be greater than zero/i
          );
        }

        return true;
      }
    );

    // STEP 8: Verify no Task account was created.
    const taskAfter = await provider.connection.getAccountInfo(
      taskPda,
      "processed"
    );

    assert.strictEqual(taskAfter, null, "Zero-budget task must not exist");

    // STEP 9: Verify existing reservations are unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    assert.ok(vaultAfter.owner.equals(vaultBefore.owner));
    assert.strictEqual(vaultAfter.paused, vaultBefore.paused);

    // STEP 10: Verify treasury funds are unchanged.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    console.log("Zero-budget task correctly rejected!");
    console.log("Rejected budget:", zeroBudget.toString());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("rejects task creation with an expired deadline", async () => {
    // STEP 1: Define task parameters.
    const taskId = new BN(3);
    const budget = new BN(25_000);
    const recipient = Keypair.generate().publicKey;

    // This task expired one hour ago.
    const expiredAt = new BN(Math.floor(Date.now() / 1000) - 60 * 60);

    assert.ok(expiredAt.lt(new BN(Math.floor(Date.now() / 1000))));

    // STEP 2: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive the proposed Task PDA.
    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive the canonical treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Confirm this task does not exist.
    const taskBefore = await provider.connection.getAccountInfo(
      taskPda,
      "processed"
    );

    assert.strictEqual(taskBefore, null);

    // STEP 6: Record existing financial state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(vaultBefore.totalReserved.toString(), "250000");

    assert.strictEqual(treasuryBefore.amount.toString(), "400000");

    // STEP 7: Attempt to create an already-expired task.
    await assert.rejects(
      async () => {
        await program.methods
          .createTask(taskId, budget, recipient, expiredAt)
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentAPda,
            tokenMint,
            treasury: treasuryAta,
            task: taskPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "InvalidTaskExpiry");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(
            details,
            /InvalidTaskExpiry|Task expiration must be in the future/i
          );
        }

        return true;
      }
    );

    // STEP 8: Confirm no Task account was created.
    const taskAfter = await provider.connection.getAccountInfo(
      taskPda,
      "processed"
    );

    assert.strictEqual(taskAfter, null, "Expired task must not be initialized");

    // STEP 9: Verify reserved funds remain unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    assert.ok(vaultAfter.owner.equals(vaultBefore.owner));
    assert.strictEqual(vaultAfter.paused, vaultBefore.paused);

    // STEP 10: Verify treasury balance remains unchanged.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    console.log("Expired task correctly rejected!");
    console.log("Expired timestamp:", expiredAt.toString());
    console.log("Total reserved:", vaultAfter.totalReserved.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
  });

  it("executes an authorized SPL token payment by Agent A", async () => {
    // STEP 1: Define the first payment.
    const paymentAmount = new BN(40_000);
    const paymentNonce = new BN(0);

    // STEP 2: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive Agent B's PDA for isolation checks.
    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 4: Derive both existing task PDAs.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive the treasury's canonical ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Derive Agent A's approved recipient ATA.
    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      taskA1Recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 7: Verify Agent A's on-chain identity.
    const agentA = await program.account.agent.fetch(agentAPda, "processed");

    assert.ok(agentA.authority.equals(agentAKeypair.publicKey));

    assert.ok(agentA.vault.equals(vaultPda));
    assert.strictEqual(agentA.active, true);

    // STEP 8: Read the task policies before payment.
    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    const taskBBefore = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskABefore.agent.equals(agentAPda));
    assert.ok(taskABefore.recipient.equals(taskA1Recipient));
    assert.ok(taskABefore.budget.eq(new BN(150_000)));
    assert.ok(taskABefore.spent.eq(new BN(0)));
    assert.ok(taskABefore.nextNonce.eq(paymentNonce));
    assert.strictEqual(taskABefore.active, true);

    // STEP 9: Record the treasury and Vault state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "400000");

    assert.ok(vaultBefore.totalReserved.eq(new BN(250_000)));

    // STEP 10: Verify the recipient ATA does not yet exist.
    const recipientBefore = await provider.connection.getAccountInfo(
      recipientAta,
      "processed"
    );

    assert.strictEqual(recipientBefore, null);

    // STEP 11: Create the recipient ATA and execute
    // the payment in one atomic transaction.
    const tx = await program.methods
      .executeTaskPayment(paymentAmount, paymentNonce)
      .accountsPartial({
        agentAuthority: agentAKeypair.publicKey,
        vault: vaultPda,
        agent: agentAPda,
        task: taskAPda,
        tokenMint,
        treasury: treasuryAta,
        recipient: taskA1Recipient,
        recipientToken: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        createAssociatedTokenAccountInstruction(
          owner,
          recipientAta,
          taskA1Recipient,
          tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
      ])
      .signers([agentAKeypair])
      .rpc();

    console.log("Agent A payment transaction:", tx);

    // STEP 12: Read the updated token accounts.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 13: Verify actual SPL token movement.
    const expectedTreasuryBalance = new BN(
      treasuryBefore.amount.toString()
    ).sub(paymentAmount);

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      expectedTreasuryBalance.toString()
    );

    assert.strictEqual(
      recipientAfter.amount.toString(),
      paymentAmount.toString()
    );

    assert.ok(recipientAfter.owner.equals(taskA1Recipient));
    assert.ok(recipientAfter.mint.equals(tokenMint));

    // STEP 14: Verify Agent A's updated spending state.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    const expectedSpent = taskABefore.spent.add(paymentAmount);

    assert.ok(taskAAfter.spent.eq(expectedSpent));

    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce.add(new BN(1))));

    assert.ok(taskAAfter.budget.eq(taskABefore.budget));
    assert.ok(taskAAfter.agent.equals(taskABefore.agent));
    assert.ok(taskAAfter.recipient.equals(taskABefore.recipient));

    assert.strictEqual(taskAAfter.active, true);

    // STEP 15: Verify the remaining task budget.
    const remainingTaskBudget = taskAAfter.budget.sub(taskAAfter.spent);

    assert.strictEqual(remainingTaskBudget.toString(), "110000");

    // STEP 16: Verify the Vault's reservation decreased.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    const expectedReserved = vaultBefore.totalReserved.sub(paymentAmount);

    assert.ok(vaultAfter.totalReserved.eq(expectedReserved));

    assert.strictEqual(vaultAfter.totalReserved.toString(), "210000");

    // STEP 17: Verify unreserved funds are unchanged.
    const unreservedBefore = new BN(treasuryBefore.amount.toString()).sub(
      vaultBefore.totalReserved
    );

    const unreservedAfter = new BN(treasuryAfter.amount.toString()).sub(
      vaultAfter.totalReserved
    );

    assert.ok(unreservedAfter.eq(unreservedBefore));

    assert.strictEqual(unreservedAfter.toString(), "150000");

    // STEP 18: Verify Agent B's task was not modified.
    const taskBAfter = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskBAfter.budget.eq(taskBBefore.budget));
    assert.ok(taskBAfter.spent.eq(taskBBefore.spent));

    assert.ok(taskBAfter.nextNonce.eq(taskBBefore.nextNonce));

    assert.ok(taskBAfter.agent.equals(taskBBefore.agent));

    console.log("Agent A payment executed successfully!");
    console.log("Payment amount:", paymentAmount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Recipient balance:", recipientAfter.amount.toString());
    console.log("Agent A spent:", taskAAfter.spent.toString());
    console.log("Agent A remaining:", remainingTaskBudget.toString());
    console.log("Vault total reserved:", vaultAfter.totalReserved.toString());
    console.log("Next payment nonce:", taskAAfter.nextNonce.toString());
  });

  it("rejects Agent B attempting to execute Agent A's payment", async () => {
    // STEP 1: Agent B attempts to spend Agent A's funds.
    const paymentAmount = new BN(10_000);

    // Agent A's next valid nonce is 1.
    const paymentNonce = new BN(1);

    // STEP 2: Derive both Agent PDAs.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    assert.ok(!agentAPda.equals(agentBPda));

    // STEP 3: Derive Agent A's Task 1 PDA.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive Agent B's existing Task 1 PDA.
    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive treasury and approved recipient ATAs.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      taskA1Recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Verify Agent B is a registered, active agent.
    const agentB = await program.account.agent.fetch(agentBPda, "processed");

    assert.ok(agentB.vault.equals(vaultPda));
    assert.ok(agentB.authority.equals(agentBKeypair.publicKey));
    assert.strictEqual(agentB.active, true);

    // STEP 7: Read the task states before the attack.
    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    const taskBBefore = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskABefore.agent.equals(agentAPda));
    assert.ok(taskABefore.spent.eq(new BN(40_000)));
    assert.ok(taskABefore.nextNonce.eq(paymentNonce));

    // Verify Agent B does NOT control Agent A's task.
    assert.ok(!taskABefore.agent.equals(agentBPda));

    // STEP 8: Record treasury, recipient, and Vault state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientBefore = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "360000");

    assert.strictEqual(recipientBefore.amount.toString(), "40000");

    assert.ok(vaultBefore.totalReserved.eq(new BN(210_000)));

    // STEP 9: Agent B attempts to execute Agent A's task.
    await assert.rejects(
      async () => {
        await program.methods
          .executeTaskPayment(paymentAmount, paymentNonce)
          .accountsPartial({
            // ATTACK: Agent B supplies its own signing identity.
            agentAuthority: agentBKeypair.publicKey,

            vault: vaultPda,

            // ATTACK: But supplies Agent A's account and task.
            agent: agentAPda,
            task: taskAPda,

            tokenMint,
            treasury: treasuryAta,
            recipient: taskA1Recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          // Agent B genuinely signs the transaction.
          .signers([agentBKeypair])
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "Unauthorized");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /Unauthorized|unauthorized/i);
        }

        return true;
      }
    );

    // STEP 10: Verify treasury tokens were not moved.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      recipientAfter.amount.toString(),
      recipientBefore.amount.toString()
    );

    // STEP 11: Verify Agent A's spending state is unchanged.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAAfter.spent.eq(taskABefore.spent));
    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce));
    assert.ok(taskAAfter.budget.eq(taskABefore.budget));
    assert.ok(taskAAfter.agent.equals(taskABefore.agent));

    // STEP 12: Verify Agent B's task is also unchanged.
    const taskBAfter = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskBAfter.spent.eq(taskBBefore.spent));
    assert.ok(taskBAfter.nextNonce.eq(taskBBefore.nextNonce));
    assert.ok(taskBAfter.budget.eq(taskBBefore.budget));

    // STEP 13: Verify shared Vault accounting is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    console.log("Cross-agent payment attack rejected!");
    console.log("Legitimate Agent A:", agentAKeypair.publicKey.toBase58());
    console.log("Attacking Agent B:", agentBKeypair.publicKey.toBase58());
    console.log("Agent A nonce preserved:", taskAAfter.nextNonce.toString());
    console.log("Treasury balance preserved:", treasuryAfter.amount.toString());
  });

  it("rejects replaying an already-used payment nonce", async () => {
    // STEP 1: Repeat Agent A's previously authorized payment.
    const replayAmount = new BN(40_000);
    const usedNonce = new BN(0);
    const expectedNonce = new BN(1);

    // STEP 2: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive Agent A's Task 1 PDA.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive the shared treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Derive the approved recipient ATA.
    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      taskA1Recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Verify the previous payment was executed.
    const taskBefore = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskBefore.spent.eq(new BN(40_000)));
    assert.ok(taskBefore.nextNonce.eq(expectedNonce));

    // The old nonce must no longer be valid.
    assert.ok(!taskBefore.nextNonce.eq(usedNonce));

    // STEP 7: Record financial state before replay.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientBefore = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "360000");

    assert.strictEqual(recipientBefore.amount.toString(), "40000");

    assert.ok(vaultBefore.totalReserved.eq(new BN(210_000)));

    // STEP 8: Attempt a new transaction using nonce 0.
    // Agent A signs correctly, but the nonce is stale.
    await assert.rejects(
      async () => {
        await program.methods
          .executeTaskPayment(replayAmount, usedNonce)
          .accountsPartial({
            agentAuthority: agentAKeypair.publicKey,
            vault: vaultPda,
            agent: agentAPda,
            task: taskAPda,
            tokenMint,
            treasury: treasuryAta,
            recipient: taskA1Recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentAKeypair])
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "InvalidPaymentNonce");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /InvalidPaymentNonce|Invalid payment nonce/i);
        }

        return true;
      }
    );

    // STEP 9: Verify no additional tokens were transferred.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      recipientAfter.amount.toString(),
      recipientBefore.amount.toString()
    );

    // STEP 10: Verify task spending and nonce are unchanged.
    const taskAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAfter.spent.eq(taskBefore.spent));

    assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));

    assert.ok(taskAfter.budget.eq(taskBefore.budget));
    assert.ok(taskAfter.agent.equals(taskBefore.agent));

    // STEP 11: Verify reservations are unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    console.log("Payment replay correctly rejected!");
    console.log("Rejected nonce:", usedNonce.toString());
    console.log("Expected nonce:", taskAfter.nextNonce.toString());
    console.log("Total spent:", taskAfter.spent.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Recipient balance:", recipientAfter.amount.toString());
  });

  it("rejects payment to an unauthorized recipient", async () => {
    // STEP 1: Define an otherwise valid payment.
    const amount = new BN(10_000);
    const nonce = new BN(1);

    // Use the Vault owner's wallet as an unauthorized recipient.
    const unauthorizedRecipient = owner;

    assert.ok(!unauthorizedRecipient.equals(taskA1Recipient));

    // STEP 2: Derive Agent A and its Task PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 3: Derive the shared treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 4: Derive the legitimate recipient's ATA.
    const approvedRecipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      taskA1Recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Derive the unauthorized recipient's ATA.
    // This token account already exists from our deposit tests.
    const unauthorizedRecipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      unauthorizedRecipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Verify Agent A's existing task policy.
    const taskBefore = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskBefore.agent.equals(agentAPda));
    assert.ok(taskBefore.recipient.equals(taskA1Recipient));
    assert.ok(taskBefore.spent.eq(new BN(40_000)));
    assert.ok(taskBefore.nextNonce.eq(nonce));
    assert.strictEqual(taskBefore.active, true);

    // This payment is within Agent A's remaining budget.
    assert.ok(taskBefore.spent.add(amount).lte(taskBefore.budget));

    // STEP 7: Record financial state before the attack.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const approvedBefore = await getAccount(
      provider.connection,
      approvedRecipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const unauthorizedBefore = await getAccount(
      provider.connection,
      unauthorizedRecipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "360000");

    assert.strictEqual(approvedBefore.amount.toString(), "40000");

    assert.strictEqual(unauthorizedBefore.amount.toString(), "600000");

    assert.ok(vaultBefore.totalReserved.eq(new BN(210_000)));

    // STEP 8: Attempt to redirect Agent A's payment.
    await assert.rejects(
      async () => {
        await program.methods
          .executeTaskPayment(amount, nonce)
          .accountsPartial({
            agentAuthority: agentAKeypair.publicKey,
            vault: vaultPda,
            agent: agentAPda,
            task: taskAPda,
            tokenMint,
            treasury: treasuryAta,

            // ATTACK: Substitute a different recipient.
            recipient: unauthorizedRecipient,
            recipientToken: unauthorizedRecipientAta,

            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentAKeypair])
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "ConstraintAddress");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /ConstraintAddress|address constraint/i);
        }

        return true;
      }
    );

    // STEP 9: Read the token balances after rejection.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const approvedAfter = await getAccount(
      provider.connection,
      approvedRecipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const unauthorizedAfter = await getAccount(
      provider.connection,
      unauthorizedRecipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 10: Verify no tokens moved.
    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      approvedAfter.amount.toString(),
      approvedBefore.amount.toString()
    );

    assert.strictEqual(
      unauthorizedAfter.amount.toString(),
      unauthorizedBefore.amount.toString()
    );

    // STEP 11: Verify the task state did not change.
    const taskAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAfter.spent.eq(taskBefore.spent));
    assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));
    assert.ok(taskAfter.budget.eq(taskBefore.budget));
    assert.ok(taskAfter.recipient.equals(taskBefore.recipient));
    assert.strictEqual(taskAfter.active, taskBefore.active);

    // STEP 12: Verify the Vault reservation is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    console.log("Unauthorized recipient correctly rejected!");
    console.log("Approved recipient:", taskA1Recipient.toBase58());
    console.log("Rejected recipient:", unauthorizedRecipient.toBase58());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Vault reserved:", vaultAfter.totalReserved.toString());
    console.log("Payment nonce preserved:", taskAfter.nextNonce.toString());
  });

  it("rejects payment exceeding the remaining task budget", async () => {
    // STEP 1: Define an excessive payment.
    const excessiveAmount = new BN(110_001);
    const validNonce = new BN(1);

    // STEP 2: Derive Agent A and Agent B PDAs.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 3: Derive both existing Task PDAs.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive treasury and approved recipient ATAs.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      taskA1Recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 5: Read both task states before the attempt.
    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    const taskBBefore = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskABefore.agent.equals(agentAPda));
    assert.ok(taskABefore.recipient.equals(taskA1Recipient));
    assert.ok(taskABefore.spent.eq(new BN(40_000)));
    assert.ok(taskABefore.budget.eq(new BN(150_000)));
    assert.ok(taskABefore.nextNonce.eq(validNonce));
    assert.strictEqual(taskABefore.active, true);

    // STEP 6: Compute the exact remaining task budget.
    const remainingBudget = taskABefore.budget.sub(taskABefore.spent);

    assert.strictEqual(remainingBudget.toString(), "110000");

    assert.ok(excessiveAmount.eq(remainingBudget.add(new BN(1))));

    // STEP 7: Record Vault and token balances.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientBefore = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.ok(vaultBefore.totalReserved.eq(new BN(210_000)));

    assert.strictEqual(treasuryBefore.amount.toString(), "360000");

    assert.strictEqual(recipientBefore.amount.toString(), "40000");

    // STEP 8: Attempt payment exceeding Agent A's budget.
    // The signer, nonce, recipient, and accounts are valid.
    await assert.rejects(
      async () => {
        await program.methods
          .executeTaskPayment(excessiveAmount, validNonce)
          .accountsPartial({
            agentAuthority: agentAKeypair.publicKey,
            vault: vaultPda,
            agent: agentAPda,
            task: taskAPda,
            tokenMint,
            treasury: treasuryAta,
            recipient: taskA1Recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentAKeypair])
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "TaskBudgetExceeded");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(
            details,
            /TaskBudgetExceeded|Payment exceeds the remaining task budget/i
          );
        }

        return true;
      }
    );

    // STEP 9: Verify no tokens were transferred.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      recipientAfter.amount.toString(),
      recipientBefore.amount.toString()
    );

    // STEP 10: Verify Agent A's task state is unchanged.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAAfter.budget.eq(taskABefore.budget));
    assert.ok(taskAAfter.spent.eq(taskABefore.spent));
    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce));
    assert.ok(taskAAfter.recipient.equals(taskABefore.recipient));
    assert.strictEqual(taskAAfter.active, taskABefore.active);

    // STEP 11: Verify Agent B's policy is unaffected.
    const taskBAfter = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskBAfter.budget.eq(taskBBefore.budget));
    assert.ok(taskBAfter.spent.eq(taskBBefore.spent));
    assert.ok(taskBAfter.nextNonce.eq(taskBBefore.nextNonce));
    assert.strictEqual(taskBAfter.active, taskBBefore.active);

    // STEP 12: Verify shared Vault accounting is unchanged.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));

    // STEP 13: Print the verified result.
    console.log("Excessive task payment correctly rejected!");
    console.log("Attempted amount:", excessiveAmount.toString());
    console.log("Remaining budget:", remainingBudget.toString());
    console.log("Agent A spent:", taskAAfter.spent.toString());
    console.log("Payment nonce preserved:", taskAAfter.nextNonce.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Vault reserved:", vaultAfter.totalReserved.toString());
  });

  it("rejects payments after a task has expired", async function () {
    // This test waits for the validator's on-chain clock.
    this.timeout(60_000);

    // STEP 1: Read the actual Solana Clock sysvar.
    const readChainTime = async (): Promise<number> => {
      const clock = await provider.connection.getAccountInfo(
        SYSVAR_CLOCK_PUBKEY,
        "processed"
      );

      assert.ok(clock, "Clock sysvar must exist");

      // Clock layout:
      // slot: 8 bytes
      // epoch_start_timestamp: 8 bytes
      // epoch: 8 bytes
      // leader_schedule_epoch: 8 bytes
      // unix_timestamp: 8 bytes, starting at offset 32
      return Number(clock.data.readBigInt64LE(32));
    };

    // STEP 2: Define a new short-lived task for Agent A.
    const taskId = new BN(4);
    const budget = new BN(10_000);
    const chainNow = await readChainTime();

    // Give the task time to initialize successfully.
    const expiresAt = new BN(chainNow + 8);

    // Reuse the existing approved recipient and its ATA.
    const recipient = taskA1Recipient;

    // STEP 3: Derive Agent A's PDA.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // STEP 4: Derive the short-lived Task PDA.
    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive SPL token accounts.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      recipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 6: Record the Vault before task creation.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    assert.ok(vaultBefore.totalReserved.eq(new BN(210_000)));

    // STEP 7: Create the short-lived task.
    await program.methods
      .createTask(taskId, budget, recipient, expiresAt)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentAPda,
        tokenMint,
        treasury: treasuryAta,
        task: taskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // STEP 8: Verify the short-lived task was created.
    const taskBefore = await program.account.task.fetch(taskPda, "processed");

    assert.ok(taskBefore.vault.equals(vaultPda));
    assert.ok(taskBefore.agent.equals(agentAPda));
    assert.ok(taskBefore.recipient.equals(recipient));
    assert.ok(taskBefore.budget.eq(budget));
    assert.ok(taskBefore.spent.eq(new BN(0)));
    assert.ok(taskBefore.nextNonce.eq(new BN(0)));
    assert.ok(taskBefore.expiresAt.eq(expiresAt));
    assert.strictEqual(taskBefore.active, true);

    // Reservation has increased from 210,000 to 220,000.
    const vaultAfterCreation = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    assert.ok(vaultAfterCreation.totalReserved.eq(new BN(220_000)));

    // STEP 9: Wait until the on-chain Clock reaches expiry.
    const waitStarted = Date.now();
    let currentChainTime = await readChainTime();

    while (currentChainTime < expiresAt.toNumber()) {
      if (Date.now() - waitStarted > 45_000) {
        throw new Error("Validator Clock did not reach task expiry in time");
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      currentChainTime = await readChainTime();
    }

    assert.ok(currentChainTime >= expiresAt.toNumber());

    console.log("Task expiry:", expiresAt.toString());
    console.log("On-chain time:", currentChainTime);

    // STEP 10: Snapshot balances after the task expires.
    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientBefore = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 11: Attempt an otherwise valid payment.
    // Agent A signs correctly.
    // Nonce 0 is correct for this new task.
    // Amount is within the task's budget.
    await assert.rejects(
      async () => {
        await program.methods
          .executeTaskPayment(new BN(5_000), new BN(0))
          .accountsPartial({
            agentAuthority: agentAKeypair.publicKey,
            vault: vaultPda,
            agent: agentAPda,
            task: taskPda,
            tokenMint,
            treasury: treasuryAta,
            recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentAKeypair])
          .rpc();
      },
      (error: any) => {
        const code = error?.error?.errorCode?.code;

        if (code) {
          assert.strictEqual(code, "TaskExpired");
        } else {
          const details = [error?.message ?? "", ...(error?.logs ?? [])].join(
            "\n"
          );

          assert.match(details, /TaskExpired|Task has expired/i);
        }

        return true;
      }
    );

    // STEP 12: Verify the expired task was not modified.
    const taskAfter = await program.account.task.fetch(taskPda, "processed");

    assert.ok(taskAfter.spent.eq(new BN(0)));
    assert.ok(taskAfter.nextNonce.eq(new BN(0)));
    assert.ok(taskAfter.budget.eq(budget));
    assert.ok(taskAfter.expiresAt.eq(expiresAt));
    assert.strictEqual(taskAfter.active, true);

    // STEP 13: Verify no SPL tokens moved.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(
      treasuryAfter.amount.toString(),
      treasuryBefore.amount.toString()
    );

    assert.strictEqual(
      recipientAfter.amount.toString(),
      recipientBefore.amount.toString()
    );

    // STEP 14: Verify reservation accounting is unchanged
    // by the rejected payment.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    assert.ok(vaultAfter.totalReserved.eq(vaultAfterCreation.totalReserved));

    console.log("Expired task payment correctly rejected!");
    console.log("Task spent:", taskAfter.spent.toString());
    console.log("Task nonce:", taskAfter.nextNonce.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Vault total reserved:", vaultAfter.totalReserved.toString());
  });

  it("executes an independent authorized payment by Agent B", async () => {
    // STEP 1: Define Agent B's first payment.
    const paymentAmount = new BN(30_000);
    const paymentNonce = new BN(0);

    // STEP 2: Derive both Agent PDAs.
    const [agentAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentAKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    assert.ok(!agentAPda.equals(agentBPda));

    // STEP 3: Derive Agent A's existing Task 1.
    const [taskAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        taskA1Id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 4: Derive Agent B's existing Task 1.
    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 5: Derive the expired short-lived Task
    // created in Test 39.
    const [expiredTaskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentAPda.toBuffer(),
        new BN(4).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // STEP 6: Verify Agent B's registered identity.
    const agentB = await program.account.agent.fetch(agentBPda, "processed");

    assert.ok(agentB.vault.equals(vaultPda));

    assert.ok(agentB.authority.equals(agentBKeypair.publicKey));

    assert.strictEqual(agentB.active, true);

    // STEP 7: Read existing task policies.
    const taskABefore = await program.account.task.fetch(taskAPda, "processed");

    const taskBBefore = await program.account.task.fetch(taskBPda, "processed");

    const expiredTaskBefore = await program.account.task.fetch(
      expiredTaskPda,
      "processed"
    );

    // Verify Agent B's task is correctly configured.
    assert.ok(taskBBefore.vault.equals(vaultPda));
    assert.ok(taskBBefore.agent.equals(agentBPda));
    assert.ok(taskBBefore.budget.eq(new BN(100_000)));
    assert.ok(taskBBefore.spent.eq(new BN(0)));
    assert.ok(taskBBefore.nextNonce.eq(paymentNonce));
    assert.strictEqual(taskBBefore.active, true);

    // The recipient is obtained from the on-chain policy.
    const approvedRecipient = taskBBefore.recipient;

    assert.ok(!approvedRecipient.equals(taskABefore.recipient));

    // STEP 8: Derive the canonical treasury ATA.
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 9: Derive Agent B's approved recipient ATA.
    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      approvedRecipient,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // STEP 10: Record starting financial state.
    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "processed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(treasuryBefore.amount.toString(), "360000");

    assert.ok(vaultBefore.totalReserved.eq(new BN(220_000)));

    // STEP 11: The recipient ATA should not exist yet.
    const recipientBefore = await provider.connection.getAccountInfo(
      recipientAta,
      "processed"
    );

    assert.strictEqual(recipientBefore, null);

    // STEP 12: Execute Agent B's first payment.
    // The owner pays transaction fees and ATA rent,
    // but Agent B supplies the required agent signature.
    const tx = await program.methods
      .executeTaskPayment(paymentAmount, paymentNonce)
      .accountsPartial({
        agentAuthority: agentBKeypair.publicKey,
        vault: vaultPda,
        agent: agentBPda,
        task: taskBPda,
        tokenMint,
        treasury: treasuryAta,
        recipient: approvedRecipient,
        recipientToken: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        createAssociatedTokenAccountInstruction(
          owner,
          recipientAta,
          approvedRecipient,
          tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
      ])
      .signers([agentBKeypair])
      .rpc();

    console.log("Agent B payment transaction:", tx);

    // STEP 13: Read updated SPL token accounts.
    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "processed",
      TOKEN_PROGRAM_ID
    );

    // STEP 14: Verify real token movement.
    assert.strictEqual(treasuryAfter.amount.toString(), "330000");

    assert.strictEqual(recipientAfter.amount.toString(), "30000");

    assert.ok(recipientAfter.owner.equals(approvedRecipient));

    assert.ok(recipientAfter.mint.equals(tokenMint));

    // STEP 15: Verify Agent B's spending state.
    const taskBAfter = await program.account.task.fetch(taskBPda, "processed");

    assert.ok(taskBAfter.spent.eq(paymentAmount));

    assert.ok(taskBAfter.nextNonce.eq(new BN(1)));

    assert.ok(taskBAfter.budget.eq(taskBBefore.budget));

    assert.ok(taskBAfter.recipient.equals(approvedRecipient));

    assert.ok(taskBAfter.agent.equals(agentBPda));

    // STEP 16: Verify Agent B's remaining budget.
    const remainingBudget = taskBAfter.budget.sub(taskBAfter.spent);

    assert.strictEqual(remainingBudget.toString(), "70000");

    // STEP 17: Verify Vault reservation accounting.
    const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

    const expectedReserved = vaultBefore.totalReserved.sub(paymentAmount);

    assert.ok(vaultAfter.totalReserved.eq(expectedReserved));

    assert.strictEqual(vaultAfter.totalReserved.toString(), "190000");

    // STEP 18: Verify unreserved funds remain unchanged.
    const availableBefore = new BN(treasuryBefore.amount.toString()).sub(
      vaultBefore.totalReserved
    );

    const availableAfter = new BN(treasuryAfter.amount.toString()).sub(
      vaultAfter.totalReserved
    );

    assert.ok(availableAfter.eq(availableBefore));

    assert.strictEqual(availableAfter.toString(), "140000");

    // STEP 19: Verify Agent A's task was not modified.
    const taskAAfter = await program.account.task.fetch(taskAPda, "processed");

    assert.ok(taskAAfter.spent.eq(taskABefore.spent));

    assert.ok(taskAAfter.nextNonce.eq(taskABefore.nextNonce));

    assert.ok(taskAAfter.budget.eq(taskABefore.budget));

    assert.ok(taskAAfter.recipient.equals(taskABefore.recipient));

    // STEP 20: Verify the expired task remains unchanged.
    const expiredTaskAfter = await program.account.task.fetch(
      expiredTaskPda,
      "processed"
    );

    assert.ok(expiredTaskAfter.spent.eq(expiredTaskBefore.spent));

    assert.ok(expiredTaskAfter.budget.eq(expiredTaskBefore.budget));

    assert.ok(expiredTaskAfter.nextNonce.eq(expiredTaskBefore.nextNonce));

    // STEP 21: Print verified results.
    console.log("Agent B payment executed successfully!");
    console.log("Payment amount:", paymentAmount.toString());
    console.log("Recipient balance:", recipientAfter.amount.toString());
    console.log("Treasury balance:", treasuryAfter.amount.toString());
    console.log("Agent B spent:", taskBAfter.spent.toString());
    console.log("Agent B remaining:", remainingBudget.toString());
    console.log("Agent B next nonce:", taskBAfter.nextNonce.toString());
    console.log("Vault total reserved:", vaultAfter.totalReserved.toString());
    console.log("Unreserved funds:", availableAfter.toString());
  });
});
