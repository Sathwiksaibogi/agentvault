
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

describe("AgentVault - Payment and Revocation Ordering", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

it("preserves financial state across payment and revocation ordering", async () => {
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );

    const agentSigner = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
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

    const ownerAta = getAssociatedTokenAddressSync(tokenMint, owner);
    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint, vaultPda, true
    );
    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint, recipient
    );

    // Initialize and fund the vault.
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
        ...[
          [owner, ownerAta],
          [vaultPda, treasuryAta],
          [recipient, recipientAta],
        ].map(([authority, address]) =>
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            address,
            authority,
            tokenMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
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
      50_000,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .depositTokens(new BN(50_000))
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
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    const clock = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );

    assert.ok(clock);

    const expiresAt = new BN(
      Number(clock.data.readBigInt64LE(32)) + 3600
    );

    await program.methods
      .createTask(taskId, new BN(10_000), recipient, expiresAt)
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

    async function snapshot(taskAddress: PublicKey = taskPda) {
      const [vault, task, treasury, recipientTokens] =
        await Promise.all([
          program.account.vault.fetch(vaultPda, "confirmed"),
          program.account.task.fetch(taskAddress, "confirmed"),
          getAccount(
            provider.connection,
            treasuryAta,
            "confirmed",
            TOKEN_PROGRAM_ID
          ),
          getAccount(
            provider.connection,
            recipientAta,
            "confirmed",
            TOKEN_PROGRAM_ID
          ),
        ]);

      return {
        spent: task.spent.toString(),
        nonce: task.nextNonce.toString(),
        reserved: vault.totalReserved.toString(),
        treasury: treasury.amount.toString(),
        recipient: recipientTokens.amount.toString(),
      };
    }

    assert.deepStrictEqual(await snapshot(), {
      spent: "0",
      nonce: "0",
      reserved: "10000",
      treasury: "50000",
      recipient: "0",
    });

    const accounts = {
      agentAuthority: agentSigner.publicKey,
      vault: vaultPda,
      agent: agentPda,
      task: taskPda,
      tokenMint,
      treasury: treasuryAta,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    };


    async function expectProgramError(
      action: () => Promise<unknown>,
      code: string
    ) {
      await assert.rejects(action, (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        assert.ok(
          details.includes(code),
          `Expected ${code}, received: ${details}`
        );
        return true;
      });
    }

    async function revokeTask(task: PublicKey) {
      return program.methods
        .revokeTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          task,
        })
        .rpc(rpcOptions);
    }

    async function payTask(
      task: PublicKey,
      amount: number,
      nonce: number
    ) {
      return program.methods
        .executeTaskPayment(new BN(amount), new BN(nonce))
        .accountsPartial({
          ...accounts,
          task,
        })
        .signers([agentSigner])
        .rpc(rpcOptions);
    }

    // Scenario A: Revocation is confirmed before payment.
    // Task 1 has budget 10,000 and no prior spending.

    await revokeTask(taskPda);

    const revokedTaskA = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    assert.strictEqual(revokedTaskA.active, false);
    assert.ok(revokedTaskA.spent.eq(new BN(0)));
    assert.ok(revokedTaskA.nextNonce.eq(new BN(0)));

    assert.deepStrictEqual(await snapshot(), {
      spent: "0",
      nonce: "0",
      reserved: "0",
      treasury: "50000",
      recipient: "0",
    });

    const beforeRejectedPaymentA = await snapshot();

    await expectProgramError(
      () => payTask(taskPda, 7_000, 0),
      "TaskInactive"
    );

    assert.deepStrictEqual(
      await snapshot(),
      beforeRejectedPaymentA
    );

    await expectProgramError(
      () => revokeTask(taskPda),
      "TaskInactive"
    );

    console.log(
      "[verified] revocation first: payment and duplicate revocation rejected"
    );

    // Scenario B: An authorized payment executes first.
    // Create an independent task belonging to the same agent.

    const taskBId = new BN(2);

    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentPda.toBuffer(),
        taskBId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createTask(
        taskBId,
        new BN(10_000),
        recipient,
        expiresAt
      )
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        task: taskBPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    assert.deepStrictEqual(await snapshot(taskBPda), {
      spent: "0",
      nonce: "0",
      reserved: "10000",
      treasury: "50000",
      recipient: "0",
    });

    // Pay 7,000 before revoking Task B.

    await payTask(taskBPda, 7_000, 0);

    assert.deepStrictEqual(await snapshot(taskBPda), {
      spent: "7000",
      nonce: "1",
      reserved: "3000",
      treasury: "43000",
      recipient: "7000",
    });

    // Owner revokes Task B after its partial execution.
    // Only the unused 3,000-unit reservation is released.

    await revokeTask(taskBPda);

    const taskBAfter = await program.account.task.fetch(
      taskBPda,
      "confirmed"
    );

    assert.strictEqual(taskBAfter.active, false);
    assert.ok(taskBAfter.budget.eq(new BN(10_000)));
    assert.ok(taskBAfter.spent.eq(new BN(7_000)));
    assert.ok(taskBAfter.nextNonce.eq(new BN(1)));

    const afterRevocationB = await snapshot(taskBPda);

    assert.deepStrictEqual(afterRevocationB, {
      spent: "7000",
      nonce: "1",
      reserved: "0",
      treasury: "43000",
      recipient: "7000",
    });

    // Even the correct next nonce cannot spend from a revoked task.

    await expectProgramError(
      () => payTask(taskBPda, 3_000, 1),
      "TaskInactive"
    );

    assert.deepStrictEqual(
      await snapshot(taskBPda),
      afterRevocationB
    );

    // Duplicate revocation cannot release the same funds again.

    await expectProgramError(
      () => revokeTask(taskBPda),
      "TaskInactive"
    );

    assert.deepStrictEqual(
      await snapshot(taskBPda),
      afterRevocationB
    );

    console.log(
      "[verified] payment first: only unused budget released"
    );

    console.log(
      "[verified] revoked tasks cannot spend or release reservations twice"
    );

  });
});
