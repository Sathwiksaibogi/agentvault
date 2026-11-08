
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

describe("AgentVault - Concurrent Deactivation and Payment", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

it("preserves financial safety when payment competes with agent deactivation", async () => {
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


    // Competing operations:
    // A: agent attempts a payment of 7,000 using nonce 0.
    // B: owner attempts to deactivate the agent.
    //
    // Both transactions reference the same writable
    // Agent and Vault accounts.

    const paymentInstruction = await program.methods
      .executeTaskPayment(new BN(7_000), new BN(0))
      .accountsPartial(accounts)
      .instruction();

    const deactivateInstruction = await program.methods
      .deactivateAgent()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
      })
      .instruction();

    const latest = await provider.connection.getLatestBlockhash(
      "confirmed"
    );

    const paymentTx = new Transaction({
      feePayer: owner,
      recentBlockhash: latest.blockhash,
    }).add(paymentInstruction);

    const deactivateTx = new Transaction({
      feePayer: owner,
      recentBlockhash: latest.blockhash,
    }).add(deactivateInstruction);

    paymentTx.sign(payer, agentSigner);
    deactivateTx.sign(payer);

    // Broadcast both signed transactions concurrently.

    const submissions = await Promise.allSettled([
      provider.connection.sendRawTransaction(
        paymentTx.serialize(),
        { skipPreflight: true, maxRetries: 5 }
      ),
      provider.connection.sendRawTransaction(
        deactivateTx.serialize(),
        { skipPreflight: true, maxRetries: 5 }
      ),
    ]);

    const paymentSignature =
      submissions[0].status === "fulfilled"
        ? submissions[0].value
        : null;

    const deactivationSignature =
      submissions[1].status === "fulfilled"
        ? submissions[1].value
        : null;

    console.log("Broadcast outcomes:", {
      payment: submissions[0].status,
      deactivation: submissions[1].status,
    });

    console.log("Transaction signatures:", {
      payment: paymentSignature,
      deactivation: deactivationSignature,
    });

    // A successful RPC submission is not evidence that
    // the transaction executed successfully.

    type Outcome =
      | "succeeded"
      | "failed"
      | "unverified"
      | "not-submitted";

    async function finalizedOutcome(
      signature: string | null
    ): Promise<Outcome> {
      if (!signature) return "not-submitted";

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
        // Confirmation can throw for an on-chain failure
        // or timeout. Inspect the signature status below.
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

    const [paymentOutcome, deactivationOutcome] =
      await Promise.all([
        finalizedOutcome(paymentSignature),
        finalizedOutcome(deactivationSignature),
      ]);

    console.log("Finalized execution outcomes:", {
      payment: paymentOutcome,
      deactivation: deactivationOutcome,
    });

    // If neither operation can be verified as successful,
    // don't count this as a meaningful concurrency test.

    assert.ok(
      paymentOutcome === "succeeded" ||
        deactivationOutcome === "succeeded",
      "Neither transaction has a verified successful execution"
    );

    const afterRace = await snapshot();

    const agentAfterRace = await program.account.agent.fetch(
      agentPda,
      "confirmed"
    );

    // Payment may execute before deactivation, or fail
    // after the agent becomes inactive.

    assert.ok(
      afterRace.spent === "0" ||
        afterRace.spent === "7000",
      `Unexpected payment amount: ${afterRace.spent}`
    );

    const amountPaid = Number(afterRace.spent);
    const nextNonce = amountPaid === 7_000 ? 1 : 0;
    const remaining = 10_000 - amountPaid;

    assert.deepStrictEqual(afterRace, {
      spent: String(amountPaid),
      nonce: String(nextNonce),
      reserved: String(remaining),
      treasury: String(50_000 - amountPaid),
      recipient: String(amountPaid),
    });

    // Verify transaction status against authoritative
    // on-chain financial state.

    if (paymentOutcome === "succeeded") {
      assert.strictEqual(amountPaid, 7_000);
    }

    if (paymentOutcome === "failed") {
      assert.strictEqual(amountPaid, 0);
    }

    if (deactivationOutcome === "succeeded") {
      assert.strictEqual(
        agentAfterRace.active,
        false,
        "Successful deactivation did not disable the agent"
      );
    }

    if (deactivationOutcome === "failed") {
      assert.strictEqual(
        agentAfterRace.active,
        true,
        "Failed deactivation unexpectedly disabled the agent"
      );
    }

    console.log(
      "[verified] race accounting and token conservation"
    );

    // If deactivation did not land, explicitly retry it.
    // This is a recovery action, not evidence that the
    // competing deactivation transaction succeeded.

    if (agentAfterRace.active) {
      assert.notStrictEqual(
        deactivationOutcome,
        "succeeded",
        "Agent active despite successful deactivation"
      );

      console.log(
        "[recovery] competing deactivation did not execute; retrying"
      );

      await program.methods
        .deactivateAgent()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
        })
        .rpc(rpcOptions);
    }

    const inactiveAgent = await program.account.agent.fetch(
      agentPda,
      "confirmed"
    );

    assert.strictEqual(inactiveAgent.active, false);

    // Deactivation does not release task reservations.
    // The unused allocation remains reserved until
    // the owner explicitly revokes the task.

    assert.deepStrictEqual(
      await snapshot(),
      afterRace,
      "Agent deactivation unexpectedly modified finances"
    );

    // Even with the correct next nonce, this agent
    // must not be able to spend after deactivation.

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

        assert.match(details, /AgentInactive/);
        return true;
      }
    );

    assert.deepStrictEqual(
      await snapshot(),
      afterRace,
      "Rejected payment modified on-chain accounting"
    );

    console.log(
      "[verified] deactivated agent cannot spend reserved funds"
    );

    // The owner must still be able to revoke an active
    // task belonging to a deactivated agent.

    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
      })
      .rpc(rpcOptions);

    const revokedTask = await program.account.task.fetch(
      taskPda,
      "confirmed"
    );

    assert.strictEqual(revokedTask.active, false);
    assert.ok(revokedTask.spent.eq(new BN(amountPaid)));
    assert.ok(revokedTask.nextNonce.eq(new BN(nextNonce)));

    const finalState = await snapshot();

    assert.deepStrictEqual(finalState, {
      spent: String(amountPaid),
      nonce: String(nextNonce),
      reserved: "0",
      treasury: String(50_000 - amountPaid),
      recipient: String(amountPaid),
    });

    console.log(
      "[verified] unused task reservation recovered by owner"
    );

    // Duplicate revocation must not release the same
    // reservation a second time.

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
      "[verified] duplicate revocation blocked"
    );

    console.log(
      "[verified] concurrent deactivation/payment security complete"
    );

  });
});
