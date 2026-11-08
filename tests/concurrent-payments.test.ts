
import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
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

describe("AgentVault - Concurrent Payment Security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("prevents concurrent transactions from spending the same nonce twice", async () => {
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

    // Build two DIFFERENT signed transactions.
    // Different compute-unit prices give unique signatures,
    // while both transactions use the exact same task nonce.
    async function buildPaymentTransaction(
      microLamports: number
    ) {
      const paymentInstruction = await program.methods
        .executeTaskPayment(new BN(7_000), new BN(0))
        .accountsPartial(accounts)
        .instruction();

      return new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports,
        }),
        paymentInstruction
      );
    }

    const txA = await buildPaymentTransaction(1);
    const txB = await buildPaymentTransaction(2);

    // Submit concurrently. One transaction may be rejected
    // because of account locking or the on-chain nonce check.
    const results = await Promise.allSettled([
      sendAndConfirmTransaction(
        provider.connection,
        txA,
        [payer, agentSigner],
        {
          commitment: "confirmed",
          skipPreflight: true,
          maxRetries: 2,
        }
      ),
      sendAndConfirmTransaction(
        provider.connection,
        txB,
        [payer, agentSigner],
        {
          commitment: "confirmed",
          skipPreflight: true,
          maxRetries: 2,
        }
      ),
    ]);

    console.log(
      "Concurrent submission outcomes:",
      results.map((result) => result.status)
    );

    // RPC completion isn't our security oracle.
    // Verify the authoritative, confirmed on-chain state.
    assert.deepStrictEqual(await snapshot(), {
      spent: "7000",
      nonce: "1",
      reserved: "3000",
      treasury: "43000",
      recipient: "7000",
    });

    console.log(
      "[verified] exactly one payment applied on-chain"
    );

    // A fresh replay with nonce 0 must explicitly fail
    // with AgentVault's nonce error.
    await assert.rejects(
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), new BN(0))
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

        assert.match(details, /InvalidPaymentNonce/);
        return true;
      }
    );

    assert.deepStrictEqual(await snapshot(), {
      spent: "7000",
      nonce: "1",
      reserved: "3000",
      treasury: "43000",
      recipient: "7000",
    });

    // The remaining 3,000 units must still be spendable
    // with the legitimate next nonce.
    await program.methods
      .executeTaskPayment(new BN(3_000), new BN(1))
      .accountsPartial(accounts)
      .signers([agentSigner])
      .rpc(rpcOptions);

    assert.deepStrictEqual(await snapshot(), {
      spent: "10000",
      nonce: "2",
      reserved: "0",
      treasury: "40000",
      recipient: "10000",
    });

    console.log(
      "[verified] replay rejected and remaining budget safely consumed"
    );
  });
});
