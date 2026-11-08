
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

describe("AgentVault - Concurrent Revocation and Payment", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

 it("preserves task accounting when payment competes with revocation", async () => {
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

    async function snapshot() {
      const [vault, task, treasury, recipientTokens] =
        await Promise.all([
          program.account.vault.fetch(vaultPda, "confirmed"),
          program.account.task.fetch(taskPda, "confirmed"),
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


    // Both transactions compete for the same task and vault.
    // We sign them before submitting so that the same
    // recent blockhash is used for the race.

    const paymentInstruction = await program.methods
      .executeTaskPayment(new BN(7_000), new BN(0))
      .accountsPartial(accounts)
      .instruction();

    const revokeInstruction = await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
      })
      .instruction();

    const latest = await provider.connection.getLatestBlockhash(
      "confirmed"
    );

    const paymentTx = new Transaction({
      feePayer: owner,
      recentBlockhash: latest.blockhash,
    }).add(paymentInstruction);

    const revokeTx = new Transaction({
      feePayer: owner,
      recentBlockhash: latest.blockhash,
    }).add(revokeInstruction);

    paymentTx.sign(payer, agentSigner);
    revokeTx.sign(payer);

    // Broadcast both signed transactions concurrently.
    // sendRawTransaction returns a signature when the RPC
    // accepts submission, NOT proof of successful execution.

    const submissions = await Promise.allSettled([
      provider.connection.sendRawTransaction(
        paymentTx.serialize(),
        { skipPreflight: true, maxRetries: 5 }
      ),
      provider.connection.sendRawTransaction(
        revokeTx.serialize(),
        { skipPreflight: true, maxRetries: 5 }
      ),
    ]);

    const signatures = submissions.map((result) =>
      result.status === "fulfilled" ? result.value : null
    );

    const [paymentSignature, revokeSignature] = signatures;

    console.log("Broadcast outcomes:", {
      payment: submissions[0].status,
      revocation: submissions[1].status,
    });

    console.log("Transaction signatures:", {
      payment: paymentSignature,
      revocation: revokeSignature,
    });

    // Inspect the actual finalized ledger result.
    // The transaction may have failed after broadcast.
    // An absent status is inconclusive, not a success.

    async function finalizedOutcome(
      signature: string | null
    ): Promise<"succeeded" | "failed" | "unverified" | "not-submitted"> {
      if (!signature) {
        return "not-submitted";
      }

      try {
        await provider.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "finalized"
        );
      } catch {
        // Inspect the ledger status even when confirmation
        // reports a transaction error or timeout.
      }

      const response =
        await provider.connection.getSignatureStatuses(
          [signature],
          { searchTransactionHistory: true }
        );

      const status = response.value[0];

      if (!status || status.confirmationStatus !== "finalized") {
        return "unverified";
      }

      if (status.err) {
        console.log(
          `[on-chain failure] ${signature}`,
          JSON.stringify(status.err)
        );
        return "failed";
      }

      return "succeeded";
    }

    const [paymentOutcome, revokeOutcome] = await Promise.all([
      finalizedOutcome(paymentSignature),
      finalizedOutcome(revokeSignature),
    ]);

    console.log("Finalized execution outcomes:", {
      payment: paymentOutcome,
      revocation: revokeOutcome,
    });

    // If neither transaction has a verified successful
    // execution, this race gives insufficient evidence.
    assert.ok(
      paymentOutcome === "succeeded" ||
        revokeOutcome === "succeeded",
      "Neither transaction has a verified successful execution"
    );

    const afterRace = await snapshot();

    const taskAfterRace = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    // Exactly one payment may have executed, or none.
    assert.ok(
      afterRace.spent === "0" ||
        afterRace.spent === "7000",
      `Unexpected spending: ${afterRace.spent}`
    );

    const amountPaid = Number(afterRace.spent);
    const nextNonce = amountPaid === 7_000 ? 1 : 0;

    if (paymentOutcome === "succeeded") {
      assert.strictEqual(amountPaid, 7_000);
    }

    if (paymentOutcome === "failed") {
      assert.strictEqual(amountPaid, 0);
    }

    if (revokeOutcome === "succeeded") {
      assert.strictEqual(
        taskAfterRace.active,
        false,
        "Finalized revocation did not deactivate task"
      );
    }

    const expectedRaceReservation = taskAfterRace.active
      ? 10_000 - amountPaid
      : 0;

    assert.deepStrictEqual(afterRace, {
      spent: String(amountPaid),
      nonce: String(nextNonce),
      reserved: String(expectedRaceReservation),
      treasury: String(50_000 - amountPaid),
      recipient: String(amountPaid),
    });

    console.log(
      "[verified] race accounting and token conservation"
    );

    // If the owner revocation was not executed,
    // retry it explicitly. The retry is a recovery action,
    // not evidence that the concurrent revocation succeeded.

    if (taskAfterRace.active) {
      assert.notStrictEqual(
        revokeOutcome,
        "succeeded",
        "Task remained active despite successful revocation"
      );

      console.log(
        "[recovery] competing revocation did not execute; retrying"
      );

      await program.methods
        .revokeTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          task: taskPda,
        })
        .rpc(rpcOptions);
    }

    const finalTask = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    assert.strictEqual(finalTask.active, false);
    assert.ok(finalTask.budget.eq(new BN(10_000)));
    assert.ok(finalTask.spent.eq(new BN(amountPaid)));
    assert.ok(finalTask.nextNonce.eq(new BN(nextNonce)));

    const finalState = await snapshot();

    assert.deepStrictEqual(finalState, {
      spent: String(amountPaid),
      nonce: String(nextNonce),
      reserved: "0",
      treasury: String(50_000 - amountPaid),
      recipient: String(amountPaid),
    });

    console.log(
      "[verified] final task revoked; unused reservation released"
    );

    // A revoked task cannot execute another payment,
    // even when the agent supplies its correct next nonce.

    await assert.rejects(
      () =>
        program.methods
          .executeTaskPayment(
            new BN(1_000),
            new BN(nextNonce)
          )
          .accountsPartial(accounts)
          .signers([agentSigner])
          .rpc(rpcOptions),
      (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        assert.match(details, /TaskInactive/);
        return true;
      }
    );

    assert.deepStrictEqual(
      await snapshot(),
      finalState,
      "Rejected payment modified financial state"
    );

    // The owner cannot release the same reservation twice.

    await assert.rejects(
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
      (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        assert.match(details, /TaskInactive/);
        return true;
      }
    );

    assert.deepStrictEqual(await snapshot(), finalState);

    console.log(
      "[verified] post-revocation payment and double revocation rejected"
    );
    console.log(
      "[verified] concurrent revocation/payment security complete"
    );

  });
});
