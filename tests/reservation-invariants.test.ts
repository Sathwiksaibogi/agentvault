
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

describe("AgentVault - Reservation Conservation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("conserves reservations and tokens across multiple agents and lifecycle changes", async () => {
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );

    const agentA = Keypair.generate();
    const agentB = Keypair.generate();

    const recipientA = Keypair.generate().publicKey;
    const recipientB = Keypair.generate().publicKey;

    const depositAmount = new BN(120_000);
    const taskABudget = new BN(50_000);
    const taskBBudget = new BN(30_000);

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

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const agentPda = (authority: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent"),
          vaultPda.toBuffer(),
          authority.toBuffer(),
        ],
        program.programId
      )[0];

    const agentAPda = agentPda(agentA.publicKey);
    const agentBPda = agentPda(agentB.publicKey);

    const taskId = new BN(1);

    const taskPda = (agent: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("task"),
          agent.toBuffer(),
          taskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      )[0];

    const taskAPda = taskPda(agentAPda);
    const taskBPda = taskPda(agentBPda);

    const ata = (authority: PublicKey, offCurve = false) =>
      getAssociatedTokenAddressSync(
        tokenMint,
        authority,
        offCurve,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

    const ownerAta = ata(owner);
    const treasuryAta = ata(vaultPda, true);
    const recipientAAta = ata(recipientA);
    const recipientBAta = ata(recipientB);

    // Track every task created in this isolated fixture.
    const trackedTasks: PublicKey[] = [];

    // Independently verify reservation and token conservation
    // after every important state transition.
    async function assertConservation(
      stage: string,
      expectedReserved: number,
      expectedPaidA: number,
      expectedPaidB: number
    ) {
      const vault = await program.account.vault.fetch(
        vaultPda,
        "confirmed"
      );

      const tasks = await Promise.all(
        trackedTasks.map((pda) =>
          program.account.task.fetch(pda, "confirmed")
        )
      );

      let recomputedReserved = new BN(0);

      for (const task of tasks) {
        assert.ok(
          task.spent.lte(task.budget),
          `${stage}: spent exceeds task budget`
        );

        // Inactive/revoked tasks no longer contribute
        // to the aggregate reservation.
        if (task.active) {
          recomputedReserved = recomputedReserved.add(
            task.budget.sub(task.spent)
          );
        }
      }

      assert.ok(
        vault.totalReserved.eq(recomputedReserved),
        `${stage}: vault reservation differs from active task sum`
      );

      assert.ok(
        vault.totalReserved.eq(new BN(expectedReserved)),
        `${stage}: unexpected reserved amount`
      );

      const [treasury, recipientATokens, recipientBTokens] =
        await Promise.all([
          getAccount(
            provider.connection,
            treasuryAta,
            "confirmed",
            TOKEN_PROGRAM_ID
          ),
          getAccount(
            provider.connection,
            recipientAAta,
            "confirmed",
            TOKEN_PROGRAM_ID
          ),
          getAccount(
            provider.connection,
            recipientBAta,
            "confirmed",
            TOKEN_PROGRAM_ID
          ),
        ]);

      assert.strictEqual(
        treasury.amount,
        BigInt(120_000 - expectedPaidA - expectedPaidB),
        `${stage}: incorrect treasury balance`
      );

      assert.strictEqual(
        recipientATokens.amount,
        BigInt(expectedPaidA),
        `${stage}: incorrect Agent A recipient balance`
      );

      assert.strictEqual(
        recipientBTokens.amount,
        BigInt(expectedPaidB),
        `${stage}: incorrect Agent B recipient balance`
      );

      // No tokens may disappear or be created by these
      // task-management and payment operations.
      assert.strictEqual(
        treasury.amount +
          recipientATokens.amount +
          recipientBTokens.amount,
        BigInt(120_000),
        `${stage}: token conservation violated`
      );

      // All reservations must remain fully funded.
      assert.ok(
        BigInt(vault.totalReserved.toString()) <= treasury.amount,
        `${stage}: reservations exceed treasury balance`
      );

      console.log(
        `[${stage}] reserved=${vault.totalReserved.toString()} ` +
        `treasury=${treasury.amount.toString()} ` +
        `paidA=${recipientATokens.amount.toString()} ` +
        `paidB=${recipientBTokens.amount.toString()}`
      );
    }

    async function expectProgramError(
      action: () => Promise<unknown>,
      expectedCode: string
    ) {
      await assert.rejects(action, (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        assert.ok(
          details.includes(expectedCode),
          `Expected ${expectedCode}; received: ${details}`
        );

        return true;
      });
    }

    // --------------------------------------------------
    // STEP 1: Initialize and fund the shared vault.
    // --------------------------------------------------

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    const ataInstructions = [
      [owner, ownerAta],
      [vaultPda, treasuryAta],
      [recipientA, recipientAAta],
      [recipientB, recipientBAta],
    ].map(([authority, address]) =>
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        address,
        authority,
        tokenMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(...ataInstructions),
      [payer],
      { commitment: "confirmed" }
    );

    await mintTo(
      provider.connection,
      payer,
      tokenMint,
      ownerAta,
      payer,
      120_000,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .depositTokens(depositAmount)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        ownerTokenAccount: ownerAta,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(rpcOptions);

    await assertConservation("deposit", 0, 0, 0);

    // --------------------------------------------------
    // STEP 2: Register two independent AI agents.
    // --------------------------------------------------

    for (const [signer, agent] of [
      [agentA, agentAPda],
      [agentB, agentBPda],
    ] as [Keypair, PublicKey][]) {
      await program.methods
        .registerAgent(signer.publicKey)
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent,
          systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOptions);
    }

    await assertConservation("register agents", 0, 0, 0);

    const clockInfo = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );

    assert.ok(clockInfo);

    const expiresAt = new BN(
      Number(clockInfo.data.readBigInt64LE(32)) + 3600
    );

    // --------------------------------------------------
    // STEP 3: Agent A reserves 50,000.
    // --------------------------------------------------

    await program.methods
      .createTask(taskId, taskABudget, recipientA, expiresAt)
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
      .rpc(rpcOptions);

    trackedTasks.push(taskAPda);

    await assertConservation("reserve A", 50_000, 0, 0);

    // --------------------------------------------------
    // STEP 4: Agent B reserves another 30,000.
    // --------------------------------------------------

    await program.methods
      .createTask(taskId, taskBBudget, recipientB, expiresAt)
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
      .rpc(rpcOptions);

    trackedTasks.push(taskBPda);

    await assertConservation("reserve B", 80_000, 0, 0);

    // --------------------------------------------------
    // STEP 5: Agent A pays 10,000.
    // --------------------------------------------------

    await program.methods
      .executeTaskPayment(new BN(10_000), new BN(0))
      .accountsPartial({
        agentAuthority: agentA.publicKey,
        vault: vaultPda,
        agent: agentAPda,
        task: taskAPda,
        tokenMint,
        treasury: treasuryAta,
        recipient: recipientA,
        recipientToken: recipientAAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentA])
      .rpc(rpcOptions);

    await assertConservation("payment A", 70_000, 10_000, 0);

    // --------------------------------------------------
    // STEP 6: Deactivate Agent A.
    // Reservations must remain unchanged.
    // --------------------------------------------------

    await program.methods
      .deactivateAgent()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentAPda,
      })
      .rpc(rpcOptions);

    await assertConservation("deactivate A", 70_000, 10_000, 0);

    await expectProgramError(
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(1))
          .accountsPartial({
            agentAuthority: agentA.publicKey,
            vault: vaultPda,
            agent: agentAPda,
            task: taskAPda,
            tokenMint,
            treasury: treasuryAta,
            recipient: recipientA,
            recipientToken: recipientAAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentA])
          .rpc(rpcOptions),
      "AgentInactive"
    );

    await assertConservation(
      "rejected inactive-agent payment",
      70_000,
      10_000,
      0
    );

    // --------------------------------------------------
    // STEP 7: Pause the shared vault.
    // --------------------------------------------------

    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    await assertConservation("pause", 70_000, 10_000, 0);

    // Even active Agent B cannot spend during pause.
    await expectProgramError(
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
          .accountsPartial({
            agentAuthority: agentB.publicKey,
            vault: vaultPda,
            agent: agentBPda,
            task: taskBPda,
            tokenMint,
            treasury: treasuryAta,
            recipient: recipientB,
            recipientToken: recipientBAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentB])
          .rpc(rpcOptions),
      "VaultPaused"
    );

    await assertConservation(
      "rejected paused payment",
      70_000,
      10_000,
      0
    );

    // --------------------------------------------------
    // STEP 8: Revoke Agent A's partially spent task
    // while the vault is still paused.
    // Release exactly 40,000 unused units.
    // --------------------------------------------------

    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentAPda,
        task: taskAPda,
      })
      .rpc(rpcOptions);

    await assertConservation("revoke A", 30_000, 10_000, 0);

    const revokedTaskA = await program.account.task.fetch(
      taskAPda,
      "confirmed"
    );

    assert.strictEqual(revokedTaskA.active, false);
    assert.ok(revokedTaskA.budget.eq(new BN(50_000)));
    assert.ok(revokedTaskA.spent.eq(new BN(10_000)));
    assert.ok(revokedTaskA.nextNonce.eq(new BN(1)));

    // --------------------------------------------------
    // STEP 9: Unpause. Agent B remains operational.
    // --------------------------------------------------

    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    await assertConservation("unpause", 30_000, 10_000, 0);

    await program.methods
      .executeTaskPayment(new BN(5_000), new BN(0))
      .accountsPartial({
        agentAuthority: agentB.publicKey,
        vault: vaultPda,
        agent: agentBPda,
        task: taskBPda,
        tokenMint,
        treasury: treasuryAta,
        recipient: recipientB,
        recipientToken: recipientBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentB])
      .rpc(rpcOptions);

    await assertConservation("payment B", 25_000, 10_000, 5_000);

    // --------------------------------------------------
    // STEP 10: Revoke Agent B's remaining reservation.
    // --------------------------------------------------

    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentBPda,
        task: taskBPda,
      })
      .rpc(rpcOptions);

    await assertConservation("revoke B", 0, 10_000, 5_000);

    const [finalVault, finalTaskB, finalAgentA, finalAgentB] =
      await Promise.all([
        program.account.vault.fetch(vaultPda, "confirmed"),
        program.account.task.fetch(taskBPda, "confirmed"),
        program.account.agent.fetch(agentAPda, "confirmed"),
        program.account.agent.fetch(agentBPda, "confirmed"),
      ]);

    assert.ok(finalVault.totalReserved.eq(new BN(0)));
    assert.strictEqual(finalTaskB.active, false);
    assert.ok(finalTaskB.spent.eq(new BN(5_000)));
    assert.ok(finalTaskB.nextNonce.eq(new BN(1)));
    assert.strictEqual(finalAgentA.active, false);
    assert.strictEqual(finalAgentB.active, true);
    assert.strictEqual(finalVault.paused, false);
  });
});
