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

describe("AgentVault - Emergency Task Revocation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  async function expectAnchorError(
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
        `Expected ${expectedCode}, received: ${details}`
      );

      return true;
    });
  }

  it("revokes a partially spent task during pause and releases only unused funds", async () => {
    const vaultId = new BN(
      Buffer.from(
        Keypair.generate().publicKey.toBytes().slice(0, 8)
      ),
      "le"
    );

    const agentSigner = Keypair.generate();
    const recipient = Keypair.generate().publicKey;

    const taskId = new BN(1);
    const budget = new BN(60_000);
    const depositAmount = new BN(100_000);
    const paymentAmount = new BN(10_000);

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

    const [agentPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentSigner.publicKey.toBuffer(),
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

    const ownerAta = getAssociatedTokenAddressSync(
      tokenMint,
      owner
    );

    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint,
      vaultPda,
      true
    );

    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint,
      recipient
    );

    // 1. Initialize an isolated vault.
    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    // 2. Create required token accounts.
    const createAtasTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerAta,
        owner,
        tokenMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
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
    );

    await sendAndConfirmTransaction(
      provider.connection,
      createAtasTx,
      [payer],
      { commitment: "confirmed" }
    );

    // 3. Fund the treasury.
    await mintTo(
      provider.connection,
      payer,
      tokenMint,
      ownerAta,
      payer,
      100_000,
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

    // 4. Register the AI agent.
    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    // 5. Create a task with a 60,000-token-unit budget.
    const clockInfo = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );

    assert.ok(clockInfo);

    const chainNow = Number(
      clockInfo.data.readBigInt64LE(32)
    );

    const expiresAt = new BN(chainNow + 3600);

    await program.methods
      .createTask(taskId, budget, recipient, expiresAt)
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

    // 6. Execute a valid payment BEFORE pausing.
    await program.methods
      .executeTaskPayment(paymentAmount, new BN(0))
      .accountsPartial({
        agentAuthority: agentSigner.publicKey,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
        tokenMint,
        treasury: treasuryAta,
        recipient,
        recipientToken: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentSigner])
      .rpc(rpcOptions);

    // 7. Activate the emergency pause.
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    // 8. Snapshot state before revocation.
    const taskBefore = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    const vaultBefore = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      treasuryAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    const recipientBefore = await getAccount(
      provider.connection,
      recipientAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(vaultBefore.paused, true);
    assert.strictEqual(taskBefore.active, true);
    assert.ok(taskBefore.budget.eq(budget));
    assert.ok(taskBefore.spent.eq(paymentAmount));
    assert.ok(taskBefore.nextNonce.eq(new BN(1)));

    const unusedBudget = taskBefore.budget.sub(
      taskBefore.spent
    );

    assert.ok(unusedBudget.eq(new BN(50_000)));
    assert.ok(vaultBefore.totalReserved.eq(unusedBudget));

    // 9. Owner must be able to revoke while paused.
    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
      })
      .rpc(rpcOptions);

    // 10. Verify accounting and history.
    const taskAfter = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    const vaultAfter = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    const treasuryAfter = await getAccount(
      provider.connection,
      treasuryAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    const recipientAfter = await getAccount(
      provider.connection,
      recipientAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(taskAfter.active, false);
    assert.strictEqual(vaultAfter.paused, true);

    assert.ok(taskAfter.budget.eq(taskBefore.budget));
    assert.ok(taskAfter.spent.eq(taskBefore.spent));
    assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));
    assert.ok(taskAfter.recipient.equals(taskBefore.recipient));

    assert.ok(
      vaultAfter.totalReserved.eq(
        vaultBefore.totalReserved.sub(unusedBudget)
      )
    );

    assert.ok(vaultAfter.totalReserved.eq(new BN(0)));

    // Revocation releases reservations, not tokens.
    assert.strictEqual(
      treasuryAfter.amount,
      treasuryBefore.amount
    );

    assert.strictEqual(
      recipientAfter.amount,
      recipientBefore.amount
    );

    // 11. Duplicate revocation must be rejected.
    await expectAnchorError(
      () =>
        program.methods
          .revokeTask()
          .accountsPartial({
            owner,
            vault: vaultPda,
            agent: agentPda,
            task: taskPda,
          })
          .rpc(rpcOptions),
      "TaskInactive"
    );

    // 12. Unpause, but revoked task must remain unusable.
    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    const unpausedVault = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    assert.strictEqual(unpausedVault.paused, false);

    await expectAnchorError(
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), taskAfter.nextNonce)
          .accountsPartial({
            agentAuthority: agentSigner.publicKey,
            vault: vaultPda,
            agent: agentPda,
            task: taskPda,
            tokenMint,
            treasury: treasuryAta,
            recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentSigner])
          .rpc(rpcOptions),
      "TaskInactive"
    );

    // 13. Failed post-revocation payment must not move funds.
    const taskFinal = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    const vaultFinal = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    const treasuryFinal = await getAccount(
      provider.connection,
      treasuryAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    const recipientFinal = await getAccount(
      provider.connection,
      recipientAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    assert.strictEqual(taskFinal.active, false);
    assert.ok(taskFinal.spent.eq(taskAfter.spent));
    assert.ok(taskFinal.nextNonce.eq(taskAfter.nextNonce));
    assert.ok(
      vaultFinal.totalReserved.eq(vaultAfter.totalReserved)
    );
    assert.strictEqual(treasuryFinal.amount, treasuryAfter.amount);
    assert.strictEqual(recipientFinal.amount, recipientAfter.amount);
  });
});