
import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { strict as assert } from "assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Cross-Vault Isolation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("rejects cross-vault account substitution without modifying funds", async () => {
    // Both vaults deliberately share an owner, token mint
    // and agent signing authority.
    const sharedAgentSigner = Keypair.generate();
    const taskId = new BN(1);

    const tokenMint = await createMint(
      provider.connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    const ata = (authority: PublicKey, offCurve = false) =>
      getAssociatedTokenAddressSync(
        tokenMint,
        authority,
        offCurve,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

    const ownerAta = ata(owner);

    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ownerAta,
          owner,
          tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      ),
      [payer],
      { commitment: "confirmed" }
    );

    await mintTo(
      provider.connection,
      payer,
      tokenMint,
      ownerAta,
      payer,
      190_000,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    const clockInfo = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );

    assert.ok(clockInfo);

    const expiresAt = new BN(
      Number(clockInfo.data.readBigInt64LE(32)) + 3600
    );

    // Build two independent, fully funded vault fixtures.
    async function createVaultFixture(
      deposit: number,
      budget: number
    ) {
      const vaultId = new BN(
        Buffer.from(
          Keypair.generate().publicKey.toBytes().slice(0, 8)
        ),
        "le"
      );

      const recipient = Keypair.generate().publicKey;

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.toBuffer(),
          vaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const [agentPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent"),
          vaultPda.toBuffer(),
          sharedAgentSigner.publicKey.toBuffer(),
        ],
        program.programId
      );

      const [taskPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("task"),
          agentPda.toBuffer(),
          taskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const treasuryAta = ata(vaultPda, true);
      const recipientAta = ata(recipient);

      await program.methods
        .initializeVault(vaultId)
        .accountsPartial({
          owner,
          vault: vaultPda,
          tokenMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOptions);

      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            treasuryAta,
            vaultPda,
            tokenMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            recipientAta,
            recipient,
            tokenMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        ),
        [payer],
        { commitment: "confirmed" }
      );

      await program.methods
        .depositTokens(new BN(deposit))
        .accountsPartial({
          owner,
          vault: vaultPda,
          tokenMint,
          ownerTokenAccount: ownerAta,
          treasury: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(rpcOptions);

      await program.methods
        .registerAgent(sharedAgentSigner.publicKey)
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOptions);

      await program.methods
        .createTask(
          taskId,
          new BN(budget),
          recipient,
          expiresAt
        )
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          tokenMint,
          treasury: treasuryAta,
          task: taskPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOptions);

      return {
        vaultPda,
        agentPda,
        taskPda,
        treasuryAta,
        recipient,
        recipientAta,
      };
    }

    const vaultA = await createVaultFixture(100_000, 50_000);
    const vaultB = await createVaultFixture(90_000, 40_000);

    assert.ok(!vaultA.vaultPda.equals(vaultB.vaultPda));
    assert.ok(!vaultA.agentPda.equals(vaultB.agentPda));
    assert.ok(!vaultA.taskPda.equals(vaultB.taskPda));

    // Read the complete financial state of both fixtures.
    async function snapshot() {
      const [
        stateA,
        stateB,
        taskA,
        taskB,
        treasuryA,
        treasuryB,
        recipientA,
        recipientB,
      ] = await Promise.all([
        program.account.vault.fetch(vaultA.vaultPda, "confirmed"),
        program.account.vault.fetch(vaultB.vaultPda, "confirmed"),
        program.account.task.fetch(vaultA.taskPda, "confirmed"),
        program.account.task.fetch(vaultB.taskPda, "confirmed"),
        getAccount(
          provider.connection,
          vaultA.treasuryAta,
          "confirmed",
          TOKEN_PROGRAM_ID
        ),
        getAccount(
          provider.connection,
          vaultB.treasuryAta,
          "confirmed",
          TOKEN_PROGRAM_ID
        ),
        getAccount(
          provider.connection,
          vaultA.recipientAta,
          "confirmed",
          TOKEN_PROGRAM_ID
        ),
        getAccount(
          provider.connection,
          vaultB.recipientAta,
          "confirmed",
          TOKEN_PROGRAM_ID
        ),
      ]);

      return {
        reservedA: stateA.totalReserved.toString(),
        reservedB: stateB.totalReserved.toString(),
        treasuryA: treasuryA.amount.toString(),
        treasuryB: treasuryB.amount.toString(),
        recipientA: recipientA.amount.toString(),
        recipientB: recipientB.amount.toString(),
        spentA: taskA.spent.toString(),
        spentB: taskB.spent.toString(),
        nonceA: taskA.nextNonce.toString(),
        nonceB: taskB.nextNonce.toString(),
        activeA: taskA.active,
        activeB: taskB.active,
      };
    }

    const initial = await snapshot();

    assert.strictEqual(initial.reservedA, "50000");
    assert.strictEqual(initial.reservedB, "40000");
    assert.strictEqual(initial.treasuryA, "100000");
    assert.strictEqual(initial.treasuryB, "90000");

    // Every rejected transaction must preserve
    // both vaults' reservations, tokens, and task state.
    async function expectRejectedAttack(
      name: string,
      action: () => Promise<unknown>,
      expectedError: RegExp
    ) {
      await assert.rejects(action, (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        assert.match(
          details,
          expectedError,
          `${name}: unexpected rejection reason`
        );

        return true;
      });

      assert.deepStrictEqual(
        await snapshot(),
        initial,
        `${name}: financial or task state changed`
      );

      console.log(`[rejected] ${name}`);
    }

    // Attack 1: Use Vault B with Agent A and Task A.
    await expectRejectedAttack(
      "foreign vault substitution",
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
          .accountsPartial({
            agentAuthority: sharedAgentSigner.publicKey,
            vault: vaultB.vaultPda,
            agent: vaultA.agentPda,
            task: vaultA.taskPda,
            tokenMint,
            treasury: vaultB.treasuryAta,
            recipient: vaultA.recipient,
            recipientToken: vaultA.recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([sharedAgentSigner])
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    // Attack 2: Substitute Agent B into Vault A's payment.
    await expectRejectedAttack(
      "foreign agent substitution",
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
          .accountsPartial({
            agentAuthority: sharedAgentSigner.publicKey,
            vault: vaultA.vaultPda,
            agent: vaultB.agentPda,
            task: vaultA.taskPda,
            tokenMint,
            treasury: vaultA.treasuryAta,
            recipient: vaultA.recipient,
            recipientToken: vaultA.recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([sharedAgentSigner])
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    // Attack 3: Substitute Task B under Vault A's Agent.
    await expectRejectedAttack(
      "foreign task substitution",
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
          .accountsPartial({
            agentAuthority: sharedAgentSigner.publicKey,
            vault: vaultA.vaultPda,
            agent: vaultA.agentPda,
            task: vaultB.taskPda,
            tokenMint,
            treasury: vaultA.treasuryAta,
            recipient: vaultB.recipient,
            recipientToken: vaultB.recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([sharedAgentSigner])
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    // Attack 4: Replace Vault A's treasury with Vault B's.
    await expectRejectedAttack(
      "foreign treasury substitution",
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
          .accountsPartial({
            agentAuthority: sharedAgentSigner.publicKey,
            vault: vaultA.vaultPda,
            agent: vaultA.agentPda,
            task: vaultA.taskPda,
            tokenMint,
            treasury: vaultB.treasuryAta,
            recipient: vaultA.recipient,
            recipientToken: vaultA.recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([sharedAgentSigner])
          .rpc(rpcOptions),
      /ConstraintAssociated|ConstraintTokenOwner|ConstraintRaw/
    );

    // Attack 5: Create a new task in Vault A using Agent B.
    const foreignTaskId = new BN(99);

    const [foreignTaskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        vaultB.agentPda.toBuffer(),
        foreignTaskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await expectRejectedAttack(
      "cross-vault task creation",
      () =>
        program.methods
          .createTask(
            foreignTaskId,
            new BN(1_000),
            vaultA.recipient,
            expiresAt
          )
          .accountsPartial({
            owner,
            vault: vaultA.vaultPda,
            agent: vaultB.agentPda,
            tokenMint,
            treasury: vaultA.treasuryAta,
            task: foreignTaskPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    assert.strictEqual(
      await provider.connection.getAccountInfo(
        foreignTaskPda,
        "confirmed"
      ),
      null
    );

    // Attack 6: Try to revoke Task A through Vault B.
    await expectRejectedAttack(
      "cross-vault task revocation",
      () =>
        program.methods
          .revokeTask()
          .accountsPartial({
            owner,
            vault: vaultB.vaultPda,
            agent: vaultA.agentPda,
            task: vaultA.taskPda,
          })
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    // Positive controls: both legitimate payments must work.
    for (const fixture of [vaultA, vaultB]) {
      await program.methods
        .executeTaskPayment(new BN(5_000), new BN(0))
        .accountsPartial({
          agentAuthority: sharedAgentSigner.publicKey,
          vault: fixture.vaultPda,
          agent: fixture.agentPda,
          task: fixture.taskPda,
          tokenMint,
          treasury: fixture.treasuryAta,
          recipient: fixture.recipient,
          recipientToken: fixture.recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sharedAgentSigner])
        .rpc(rpcOptions);
    }

    const final = await snapshot();

    assert.deepStrictEqual(final, {
      reservedA: "45000",
      reservedB: "35000",
      treasuryA: "95000",
      treasuryB: "85000",
      recipientA: "5000",
      recipientB: "5000",
      spentA: "5000",
      spentB: "5000",
      nonceA: "1",
      nonceB: "1",
      activeA: true,
      activeB: true,
    });

    console.log(
      "Cross-vault isolation verified; both legitimate payments succeeded."
    );
  });
});
