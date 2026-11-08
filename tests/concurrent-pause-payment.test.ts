
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

describe("AgentVault - Concurrent Pause and Payment", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

it("preserves payment safety when an emergency pause competes with execution", async () => {
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


    // Build two competing transactions:
    //
    // Transaction A: agent attempts to pay 7,000.
    // Transaction B: owner attempts to pause the vault.
    //
    // Both write to the same Vault PDA, so Solana
    // must serialize their successful execution.

    const paymentInstruction = await program.methods
      .executeTaskPayment(new BN(7_000), new BN(0))
      .accountsPartial(accounts)
      .instruction();

    const pauseInstruction = await program.methods
      .setVaultPaused(true)
      .accountsPartial({
        owner,
        vault: vaultPda,
      })
      .instruction();

    const paymentTx = new Transaction().add(
      paymentInstruction
    );

    const pauseTx = new Transaction().add(
      pauseInstruction
    );

    const results = await Promise.allSettled([
      sendAndConfirmTransaction(
        provider.connection,
        paymentTx,
        [payer, agentSigner],
        {
          commitment: "finalized",
          skipPreflight: true,
          maxRetries: 5,
        }
      ),
      sendAndConfirmTransaction(
        provider.connection,
        pauseTx,
        [payer],
        {
          commitment: "finalized",
          skipPreflight: true,
          maxRetries: 5,
        }
      ),
    ]);

    const [paymentResult, pauseResult] = results;

    console.log("Concurrent outcomes:", {
      payment: paymentResult.status,
      pause: pauseResult.status,
    });

    // If both transactions were rejected, the run
    // is inconclusive. Do not count it as a security pass.
    assert.ok(
      results.some((result) => result.status === "fulfilled"),
      "Neither transaction completed; concurrency run inconclusive"
    );

    // Read the on-chain accounting after settlement.
    const afterRace = await snapshot();

    // A single 7,000-unit payment either happened or did not.
    // There must never be partial or duplicate spending.
    assert.ok(
      afterRace.spent === "0" ||
      afterRace.spent === "7000",
      `Unexpected spending: ${afterRace.spent}`
    );

    const paymentApplied = afterRace.spent === "7000";

    const spent = paymentApplied ? 7_000 : 0;
    const nonce = paymentApplied ? 1 : 0;
    const remaining = 10_000 - spent;

    assert.deepStrictEqual(afterRace, {
      spent: String(spent),
      nonce: String(nonce),
      reserved: String(remaining),
      treasury: String(50_000 - spent),
      recipient: String(spent),
    });

    // A fulfilled payment must be reflected in state.
    if (paymentResult.status === "fulfilled") {
      assert.strictEqual(paymentApplied, true);
    }

    let vaultState = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    if (pauseResult.status === "fulfilled") {
      assert.strictEqual(
        vaultState.paused,
        true,
        "Confirmed pause did not set the vault flag"
      );
    }

    console.log(
      paymentApplied
        ? "[verified] payment applied exactly once"
        : "[verified] competing payment did not execute"
    );

    // The pause transaction may have been rejected by
    // account contention. If so, explicitly retry the
    // owner's emergency control after the race.
    //
    // This recovery is not counted as a successful
    // concurrent pause transaction.

    if (!vaultState.paused) {
      assert.strictEqual(
        pauseResult.status,
        "rejected",
        "Unexpected missing pause state"
      );

      console.log(
        "[recovery] competing pause did not land; retrying"
      );

      await program.methods
        .setVaultPaused(true)
        .accountsPartial({
          owner,
          vault: vaultPda,
        })
        .rpc(rpcOptions);

      vaultState = await program.account.vault.fetch(
        vaultPda,
        "confirmed"
      );
    }

    assert.strictEqual(vaultState.paused, true);

    // Pausing must never change prior financial accounting.
    assert.deepStrictEqual(
      await snapshot(),
      afterRace
    );

    // Regardless of which competing transaction completed
    // first, the agent cannot spend while the vault is paused.
    const beforeBlockedPayment = await snapshot();

    await assert.rejects(
      () =>
        program.methods
          .executeTaskPayment(
            new BN(1_000),
            new BN(nonce)
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

        assert.match(details, /VaultPaused/);
        return true;
      }
    );

    assert.deepStrictEqual(
      await snapshot(),
      beforeBlockedPayment
    );

    console.log(
      "[verified] confirmed pause blocks further payments"
    );

    // The owner must retain recovery authority while paused.
    // Revoking the task releases only its unused reservation.
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

    assert.deepStrictEqual(await snapshot(), {
      spent: String(spent),
      nonce: String(nonce),
      reserved: "0",
      treasury: String(50_000 - spent),
      recipient: String(spent),
    });

    console.log(
      "[verified] owner recovered the unused reservation"
    );

    console.log(
      "[verified] concurrent emergency-control accounting preserved"
    );

  });
});
