
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

describe("AgentVault - Payment and Agent Deactivation Ordering", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

it("preserves reservations and blocks payments after agent deactivation", async () => {
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

    async function payTask(
      signer: Keypair,
      agentAddress: PublicKey,
      taskAddress: PublicKey,
      amount: number,
      nonce: number
    ) {
      return program.methods
        .executeTaskPayment(new BN(amount), new BN(nonce))
        .accountsPartial({
          ...accounts,
          agentAuthority: signer.publicKey,
          agent: agentAddress,
          task: taskAddress,
        })
        .signers([signer])
        .rpc(rpcOptions);
    }

    async function deactivateAgent(agentAddress: PublicKey) {
      await program.methods
        .deactivateAgent()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentAddress,
        })
        .rpc(rpcOptions);

      const state = await program.account.agent.fetch(
        agentAddress,
        "confirmed"
      );

      assert.strictEqual(state.active, false);
    }

    async function revokeTask(
      agentAddress: PublicKey,
      taskAddress: PublicKey
    ) {
      await program.methods
        .revokeTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentAddress,
          task: taskAddress,
        })
        .rpc(rpcOptions);
    }

    // SCENARIO A
    // Deactivation occurs before payment.
    // Task A already has a reserved budget of 10,000.

    const initialState = await snapshot();

    await deactivateAgent(agentPda);

    assert.deepStrictEqual(
      await snapshot(),
      initialState,
      "Deactivation must not modify reserved funds"
    );

    const taskAAfterDeactivation =
      await program.account.task.fetch(taskPda, "confirmed");

    assert.strictEqual(taskAAfterDeactivation.active, true);
    assert.ok(taskAAfterDeactivation.spent.eq(new BN(0)));
    assert.ok(taskAAfterDeactivation.nextNonce.eq(new BN(0)));

    await expectProgramError(
      () =>
        payTask(
          agentSigner,
          agentPda,
          taskPda,
          7_000,
          0
        ),
      "AgentInactive"
    );

    assert.deepStrictEqual(await snapshot(), {
      spent: "0",
      nonce: "0",
      reserved: "10000",
      treasury: "50000",
      recipient: "0",
    });

    console.log(
      "[verified] deactivation first: payment blocked, reservation preserved"
    );

    // SCENARIO B
    // A different agent completes a payment first,
    // then the owner deactivates that agent.

    const agentBSigner = Keypair.generate();

    const [agentBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        agentBSigner.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .registerAgent(agentBSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentBPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    const taskBId = new BN(1);

    const [taskBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentBPda.toBuffer(),
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
        agent: agentBPda,
        tokenMint,
        treasury: treasuryAta,
        task: taskBPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    // Both tasks reserve 10,000 each.
    assert.deepStrictEqual(await snapshot(taskBPda), {
      spent: "0",
      nonce: "0",
      reserved: "20000",
      treasury: "50000",
      recipient: "0",
    });

    // Agent B successfully spends 7,000.
    await payTask(
      agentBSigner,
      agentBPda,
      taskBPda,
      7_000,
      0
    );

    assert.deepStrictEqual(await snapshot(taskBPda), {
      spent: "7000",
      nonce: "1",
      reserved: "13000",
      treasury: "43000",
      recipient: "7000",
    });

    // Deactivation cannot roll back a confirmed payment,
    // and it must not release the unused 3,000.
    await deactivateAgent(agentBPda);

    const afterDeactivationB = await snapshot(taskBPda);

    assert.deepStrictEqual(afterDeactivationB, {
      spent: "7000",
      nonce: "1",
      reserved: "13000",
      treasury: "43000",
      recipient: "7000",
    });

    await expectProgramError(
      () =>
        payTask(
          agentBSigner,
          agentBPda,
          taskBPda,
          3_000,
          1
        ),
      "AgentInactive"
    );

    assert.deepStrictEqual(
      await snapshot(taskBPda),
      afterDeactivationB
    );

    // The existing deactivation instruction is idempotent.
    await deactivateAgent(agentBPda);

    assert.deepStrictEqual(
      await snapshot(taskBPda),
      afterDeactivationB
    );

    console.log(
      "[verified] payment first: completed transfer preserved, further payments blocked"
    );

    // SCENARIO C
    // The owner recovers unused reservations from both
    // deactivated agents through explicit task revocation.

    // Task A never spent funds; release all 10,000.
    await revokeTask(agentPda, taskPda);

    const taskAAfterRevocation =
      await program.account.task.fetch(taskPda, "confirmed");

    assert.strictEqual(taskAAfterRevocation.active, false);

    assert.deepStrictEqual(await snapshot(taskPda), {
      spent: "0",
      nonce: "0",
      reserved: "3000",
      treasury: "43000",
      recipient: "7000",
    });

    // Task B spent 7,000; release only the unused 3,000.
    await revokeTask(agentBPda, taskBPda);

    const taskBAfterRevocation =
      await program.account.task.fetch(taskBPda, "confirmed");

    assert.strictEqual(taskBAfterRevocation.active, false);
    assert.ok(taskBAfterRevocation.spent.eq(new BN(7_000)));
    assert.ok(taskBAfterRevocation.nextNonce.eq(new BN(1)));

    const finalState = await snapshot(taskBPda);

    assert.deepStrictEqual(finalState, {
      spent: "7000",
      nonce: "1",
      reserved: "0",
      treasury: "43000",
      recipient: "7000",
    });

    // A duplicate revocation must never release funds twice.
    await expectProgramError(
      () => revokeTask(agentBPda, taskBPda),
      "TaskInactive"
    );

    assert.deepStrictEqual(
      await snapshot(taskBPda),
      finalState
    );

    console.log(
      "[verified] owner recovered unused funds from both deactivated agents"
    );

    console.log(
      "[verified] treasury conservation, reservations and nonces preserved"
    );

  });
});
