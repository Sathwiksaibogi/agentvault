
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

describe("AgentVault - Owner Withdrawal Security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("withdraws only unreserved funds while preserving task commitments", async () => {
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


    const withdrawalAccounts = {
      owner,
      vault: vaultPda,
      tokenMint,
      treasury: treasuryAta,
      ownerTokenAccount: ownerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    async function withdraw(amount: number) {
      return program.methods
        .withdrawUnreserved(new BN(amount))
        .accountsPartial(withdrawalAccounts)
        .rpc(rpcOptions);
    }

    async function ownerBalance(): Promise<bigint> {
      const account = await getAccount(
        provider.connection,
        ownerAta,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      return account.amount;
    }

    async function expectRejectedUnchanged(
      description: string,
      operation: () => Promise<unknown>,
      expectedError?: RegExp
    ) {
      const before = await snapshot();
      const ownerBefore = await ownerBalance();

      await assert.rejects(operation, (error: any) => {
        const details = [
          error?.message ?? "",
          error?.error?.errorCode?.code ?? "",
          ...(error?.logs ?? []),
          ...(error?.transactionLogs ?? []),
        ].join("\n");

        if (expectedError) {
          assert.match(details, expectedError);
        }

        return true;
      });

      assert.deepStrictEqual(
        await snapshot(),
        before,
        `${description}: vault or task state changed`
      );

      assert.strictEqual(
        await ownerBalance(),
        ownerBefore,
        `${description}: owner balance changed`
      );

      console.log(`[rejected] ${description}`);
    }

    // Initial state:
    // Treasury: 50,000
    // Reserved: 10,000
    // Withdrawable: 40,000

    assert.strictEqual(await ownerBalance(), BigInt(0));

    // Zero-value withdrawals are invalid.
    await expectRejectedUnchanged(
      "zero-value withdrawal",
      () => withdraw(0),
      /InvalidWithdrawalAmount/
    );

    // Cannot withdraw more than the free balance.
    await expectRejectedUnchanged(
      "withdrawal exceeds unreserved balance",
      () => withdraw(40_001),
      /InsufficientUnreservedFunds/
    );

    // A different signer must not control this vault.
    const outsider = Keypair.generate();

    await expectRejectedUnchanged(
      "unauthorized owner substitution",
      () =>
        program.methods
          .withdrawUnreserved(new BN(1_000))
          .accountsPartial({
            ...withdrawalAccounts,
            owner: outsider.publicKey,
          })
          .signers([outsider])
          .rpc(rpcOptions)
    );

    // Owner cannot redirect funds to the agent's
    // approved recipient account. The destination
    // must itself be owned by the vault owner.
    await expectRejectedUnchanged(
      "foreign withdrawal destination",
      () =>
        program.methods
          .withdrawUnreserved(new BN(1_000))
          .accountsPartial({
            ...withdrawalAccounts,
            ownerTokenAccount: recipientAta,
          })
          .rpc(rpcOptions)
    );

    // The supplied treasury must be the canonical
    // associated token account of the vault.
    await expectRejectedUnchanged(
      "treasury account substitution",
      () =>
        program.methods
          .withdrawUnreserved(new BN(1_000))
          .accountsPartial({
            ...withdrawalAccounts,
            treasury: ownerAta,
          })
          .rpc(rpcOptions)
    );

    // Withdraw a portion of the free funds.
    await withdraw(30_000);

    assert.deepStrictEqual(await snapshot(), {
      spent: "0",
      nonce: "0",
      reserved: "10000",
      treasury: "20000",
      recipient: "0",
    });

    assert.strictEqual(await ownerBalance(), BigInt(30_000));

    console.log(
      "[verified] owner withdrew 30,000 unreserved tokens"
    );

    // There are now only 10,000 free tokens.
    await expectRejectedUnchanged(
      "withdrawal after free balance reduction",
      () => withdraw(10_001),
      /InsufficientUnreservedFunds/
    );

    // The reserved task still has its full budget
    // available, despite the owner's withdrawal.
    await program.methods
      .executeTaskPayment(new BN(4_000), new BN(0))
      .accountsPartial(accounts)
      .signers([agentSigner])
      .rpc(rpcOptions);

    assert.deepStrictEqual(await snapshot(), {
      spent: "4000",
      nonce: "1",
      reserved: "6000",
      treasury: "16000",
      recipient: "4000",
    });

    assert.strictEqual(await ownerBalance(), BigInt(30_000));

    console.log(
      "[verified] reserved task payment unaffected by withdrawal"
    );

    // Pause the vault. Emergency pause should block
    // agents but not prevent the owner from withdrawing
    // genuinely unreserved funds.
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({
        owner,
        vault: vaultPda,
      })
      .rpc(rpcOptions);

    const pausedVault = await program.account.vault.fetch(
      vaultPda,
      "confirmed"
    );

    assert.strictEqual(pausedVault.paused, true);

    // Available = 16,000 - 6,000 = 10,000.
    await withdraw(10_000);

    assert.deepStrictEqual(await snapshot(), {
      spent: "4000",
      nonce: "1",
      reserved: "6000",
      treasury: "6000",
      recipient: "4000",
    });

    assert.strictEqual(await ownerBalance(), BigInt(40_000));

    console.log(
      "[verified] owner withdrew free funds during emergency pause"
    );

    // The remaining 6,000 tokens are fully reserved.
    await expectRejectedUnchanged(
      "cannot consume reservations during pause",
      () => withdraw(1),
      /InsufficientUnreservedFunds/
    );

    // Owner explicitly revokes the partially spent task.
    // This releases its 6,000-unit unused reservation.
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
      spent: "4000",
      nonce: "1",
      reserved: "0",
      treasury: "6000",
      recipient: "4000",
    });

    console.log(
      "[verified] revocation released unused task budget"
    );

    // The final 6,000 tokens are now unreserved.
    await withdraw(6_000);

    const finalState = await snapshot();

    assert.deepStrictEqual(finalState, {
      spent: "4000",
      nonce: "1",
      reserved: "0",
      treasury: "0",
      recipient: "4000",
    });

    assert.strictEqual(await ownerBalance(), BigInt(46_000));

    // Original treasury funding = owner recovery +
    // authorized agent payment.
    assert.strictEqual(
      (await ownerBalance()) + BigInt(finalState.recipient),
      BigInt(50_000)
    );

    console.log(
      "[verified] owner recovered all remaining treasury funds"
    );

    console.log(
      "[verified] token conservation and task accounting preserved"
    );

  });
});
