
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

describe("AgentVault - Adversarial Payment Boundaries", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("enforces payment bounds, nonces, signatures and accounting atomicity", async () => {
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );

    const agentSigner = Keypair.generate();
    const attacker = Keypair.generate();
    const recipient = Keypair.generate().publicKey;

    const taskId = new BN(1);
    const taskBudget = new BN(25_000);
    const depositAmount = new BN(50_000);

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
    const recipientAta = ata(recipient);

    // Initialize the isolated vault.
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
          ownerAta,
          owner,
          tokenMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          treasuryAta,
          vaultPda,
          tokenMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          recipientAta,
          recipient,
          tokenMint
        )
      ),
      [payer],
      { commitment: "confirmed" }
    );

    // Fund the vault with 50,000 token units.
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

    // Register the authorized agent.
    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    const clockInfo = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );

    assert.ok(clockInfo);

    const expiresAt = new BN(
      Number(clockInfo.data.readBigInt64LE(32)) + 3600
    );

    // Reserve 25,000 units for the task.
    await program.methods
      .createTask(
        taskId,
        taskBudget,
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

    // Read every financial field relevant to a payment.
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

      // Independently check the active-task reservation.
      assert.strictEqual(task.active, true);
      assert.ok(task.spent.lte(task.budget));
      assert.ok(task.budget.eq(taskBudget));

      assert.ok(
        vault.totalReserved.eq(task.budget.sub(task.spent)),
        "Task reservation and vault accounting differ"
      );

      assert.strictEqual(
        treasury.amount + recipientTokens.amount,
        BigInt(50_000),
        "Token conservation violated"
      );

      assert.ok(
        BigInt(vault.totalReserved.toString()) <= treasury.amount,
        "Treasury is undercollateralized"
      );

      return {
        spent: task.spent.toString(),
        nonce: task.nextNonce.toString(),
        reserved: vault.totalReserved.toString(),
        treasury: treasury.amount.toString(),
        recipient: recipientTokens.amount.toString(),
      };
    }

    async function executePayment(
      amount: BN,
      nonce: BN,
      signer = agentSigner
    ) {
      return program.methods
        .executeTaskPayment(amount, nonce)
        .accountsPartial({
          agentAuthority: signer.publicKey,
          vault: vaultPda,
          agent: agentPda,
          task: taskPda,
          tokenMint,
          treasury: treasuryAta,
          recipient,
          recipientToken: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([signer])
        .rpc(rpcOptions);
    }

    // A rejected payment must match the expected
    // security error and preserve every financial field.
    async function expectRejected(
      label: string,
      amount: BN,
      nonce: BN,
      expectedError: RegExp,
      signer = agentSigner
    ) {
      const before = await snapshot();

      await assert.rejects(
        () => executePayment(amount, nonce, signer),
        (error: any) => {
          const details = [
            error?.message ?? "",
            error?.error?.errorCode?.code ?? "",
            ...(error?.logs ?? []),
            ...(error?.transactionLogs ?? []),
          ].join("\n");

          assert.match(
            details,
            expectedError,
            `${label}: unexpected failure reason`
          );

          return true;
        }
      );

      const after = await snapshot();

      assert.deepStrictEqual(
        after,
        before,
        `${label}: rejected payment changed on-chain state`
      );

      console.log(`[rejected] ${label}`);
    }

    // Check the newly created task.
    assert.deepStrictEqual(await snapshot(), {
      spent: "0",
      nonce: "0",
      reserved: "25000",
      treasury: "50000",
      recipient: "0",
    });

    // 1. Zero payments must be rejected.
    await expectRejected(
      "zero amount",
      new BN(0),
      new BN(0),
      /InvalidPaymentAmount/
    );

    // 2. A future nonce must be rejected.
    await expectRejected(
      "future nonce before first payment",
      new BN(1_000),
      new BN(2),
      /InvalidPaymentNonce/
    );

    // 3. Another signer cannot impersonate this agent.
    await expectRejected(
      "unauthorized signer",
      new BN(1_000),
      new BN(0),
      /Unauthorized/,
      attacker
    );

    // 4. A payment cannot exceed the entire task budget.
    await expectRejected(
      "payment exceeds budget",
      new BN(25_001),
      new BN(0),
      /TaskBudgetExceeded/
    );

    // 5. First legitimate payment: 10,000 units.
    await executePayment(new BN(10_000), new BN(0));

    assert.deepStrictEqual(await snapshot(), {
      spent: "10000",
      nonce: "1",
      reserved: "15000",
      treasury: "40000",
      recipient: "10000",
    });

    console.log("[accepted] first payment");

    // 6. Reusing nonce 0 must fail.
    await expectRejected(
      "stale nonce",
      new BN(1_000),
      new BN(0),
      /InvalidPaymentNonce/
    );

    // 7. Skipping ahead to nonce 3 must fail.
    await expectRejected(
      "skipped nonce",
      new BN(1_000),
      new BN(3),
      /InvalidPaymentNonce/
    );

    // 8. Cannot exceed the remaining 15,000 units.
    await expectRejected(
      "exceeds remaining budget",
      new BN(15_001),
      new BN(1),
      /TaskBudgetExceeded/
    );

    // 9. u64 addition must not wrap around.
    // Since spent is already 10,000, adding u64::MAX
    // must trigger the checked arithmetic guard.
    await expectRejected(
      "u64 spending overflow",
      new BN("18446744073709551615"),
      new BN(1),
      /MathOverflow/
    );

    // 10. Exactly exhaust the remaining task budget.
    await executePayment(new BN(15_000), new BN(1));

    assert.deepStrictEqual(await snapshot(), {
      spent: "25000",
      nonce: "2",
      reserved: "0",
      treasury: "25000",
      recipient: "25000",
    });

    console.log("[accepted] exact budget exhaustion");

    // 11. Replaying the last nonce must fail.
    await expectRejected(
      "replay after exhaustion",
      new BN(1),
      new BN(1),
      /InvalidPaymentNonce/
    );

    // 12. Even the correct next nonce cannot
    // spend beyond the exhausted budget.
    await expectRejected(
      "payment after full budget exhaustion",
      new BN(1),
      new BN(2),
      /TaskBudgetExceeded/
    );

    // 13. Zero amount is invalid even after exhaustion.
    await expectRejected(
      "zero amount after exhaustion",
      new BN(0),
      new BN(2),
      /InvalidPaymentAmount/
    );

    console.log(
      "Payment boundaries, nonce protection, " +
      "signer authorization and atomicity verified."
    );
  });
});
