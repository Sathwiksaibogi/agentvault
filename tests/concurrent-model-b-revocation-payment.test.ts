import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nacl from "tweetnacl";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import type { Agentvault } from "../target/types/agentvault";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "../demo/payment-approval-v2";

/**
 * Direct on-chain Model B payment/revocation race on an isolated local validator.
 * A separate Model A reservation must remain intact in either possible order.
 * No demo journal, Gemini, Devnet wallet or production treasury is involved.
 */
describe("AgentVault - Concurrent Model B Revocation and Payment", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const owner = provider.wallet.publicKey;
  const options = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("conserves both models' reservations when signed Model B spending races owner revocation", async () => {
    assert.ok(owner.equals(payer.publicKey));

    const endpoint = new URL(connection.rpcEndpoint);
    assert.ok(
      endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname),
      "Refusing non-local RPC for an on-chain state-changing test"
    );
    const genesis = await connection.getGenesisHash();
    assert.notEqual(
      genesis,
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "Refusing Devnet genesis; this test needs a local validator"
    );
    const genesisHash = new PublicKey(genesis);

    const signerA = Keypair.generate();
    const signerB = Keypair.generate();
    const recipientA = Keypair.generate().publicKey;
    const recipientB = Keypair.generate().publicKey;
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );
    const taskIdA = new BN(1);
    const taskIdB = new BN(2);
    const now = Math.floor(Date.now() / 1000);
    const taskExpiry = new BN(now + 86_400);
    const approvalExpiry = new BN(now + 3_600);
    const paymentAmount = 7_000;
    const initialTreasury = 100_000;
    const budgetA = 40_000;
    const budgetB = 30_000;

    const [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const agentPda = (authority: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
        program.programId
      )[0];
    const agentA = agentPda(signerA.publicKey);
    const agentB = agentPda(signerB.publicKey);
    const taskA = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentA.toBuffer(),
        taskIdA.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
    const taskB = PublicKey.findProgramAddressSync(
      [
        Buffer.from("approved-task"),
        agentB.toBuffer(),
        taskIdB.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const mint = await createMint(
      connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    const ata = (authority: PublicKey, offCurve = false) =>
      getAssociatedTokenAddressSync(
        mint,
        authority,
        offCurve,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    const ownerAta = ata(owner);
    const treasury = ata(vault, true);
    const recipientAtaA = ata(recipientA);
    const recipientAtaB = ata(recipientB);

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault,
        tokenMint: mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(options);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ...(
          [
            [treasury, vault],
            [ownerAta, owner],
            [recipientAtaA, recipientA],
            [recipientAtaB, recipientB],
          ] as const
        ).map(([address, authority]) =>
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            address,
            authority,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        )
      ),
      [payer],
      options
    );
    await mintTo(
      connection,
      payer,
      mint,
      ownerAta,
      payer,
      initialTreasury,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    await program.methods
      .depositTokens(new BN(initialTreasury))
      .accountsPartial({
        owner,
        vault,
        tokenMint: mint,
        ownerTokenAccount: ownerAta,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(options);

    for (const [signer, agent] of [
      [signerA, agentA],
      [signerB, agentB],
    ] as const) {
      await program.methods
        .registerAgent(signer.publicKey)
        .accountsPartial({
          owner,
          vault,
          agent,
          systemProgram: SystemProgram.programId,
        })
        .rpc(options);
    }
    await program.methods
      .createTask(taskIdA, new BN(budgetA), recipientA, taskExpiry)
      .accountsPartial({
        owner,
        vault,
        agent: agentA,
        task: taskA,
        tokenMint: mint,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(options);
    await program.methods
      .createApprovedTask(
        taskIdB,
        new BN(budgetB),
        recipientB,
        taskExpiry,
        genesisHash
      )
      .accountsPartial({
        owner,
        vault,
        agent: agentB,
        approvedTask: taskB,
        tokenMint: mint,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(options);

    // The agent is only funded for transaction fees. It cannot sign as owner.
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: signerB.publicKey,
          lamports: 100_000_000,
        })
      ),
      [payer],
      options
    );

    async function audit(
      stage: string,
      bSpent: number,
      bActive: boolean,
      aSpent = 0
    ) {
      const [v, a, b, t, o, ra, rb] = await Promise.all([
        program.account.vault.fetch(vault, "confirmed"),
        program.account.task.fetch(taskA, "confirmed"),
        program.account.approvedTask.fetch(taskB, "confirmed"),
        getAccount(connection, treasury, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, ownerAta, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, recipientAtaA, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, recipientAtaB, "confirmed", TOKEN_PROGRAM_ID),
      ]);
      assert.ok(a.vault.equals(vault) && b.vault.equals(vault));
      assert.ok(a.agent.equals(agentA) && b.agent.equals(agentB));
      assert.ok(b.genesisHash.equals(genesisHash));
      assert.ok(a.budget.eq(new BN(budgetA)) && b.budget.eq(new BN(budgetB)));
      assert.ok(a.active, `${stage}: Model A unexpectedly inactive`);
      assert.equal(b.active, bActive, `${stage}: Model B active status`);
      assert.equal(
        a.spent.toString(),
        String(aSpent),
        `${stage}: Model A spent`
      );
      assert.equal(
        b.spent.toString(),
        String(bSpent),
        `${stage}: Model B spent`
      );
      assert.equal(a.nextNonce.toString(), String(aSpent > 0 ? 1 : 0));
      assert.equal(b.nextNonce.toString(), String(bSpent > 0 ? 1 : 0));
      assert.ok(a.spent.lte(a.budget) && b.spent.lte(b.budget));
      const expectedReserved =
        budgetA - aSpent + (bActive ? budgetB - bSpent : 0);
      const reserved = BigInt(v.totalReserved.toString());
      assert.equal(
        reserved,
        BigInt(expectedReserved),
        `${stage}: reservation sum`
      );
      assert.equal(t.amount, BigInt(initialTreasury - aSpent - bSpent));
      assert.equal(ra.amount, BigInt(aSpent));
      assert.equal(rb.amount, BigInt(bSpent));
      assert.equal(o.amount, BigInt(0));
      assert.equal(
        t.amount + o.amount + ra.amount + rb.amount,
        BigInt(initialTreasury),
        `${stage}: token conservation`
      );
      assert.ok(reserved <= t.amount, `${stage}: undercollateralized`);
      console.log(
        `[${stage}] reserved=${reserved}, treasury=${t.amount}, bSpent=${bSpent}, bActive=${bActive}`
      );
    }

    await audit("before concurrent submissions", 0, true);

    const requestId = "concurrent-model-b-revocation-001";
    const approval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: genesisHash.toBase58(),
      programId: program.programId.toBase58(),
      vault: vault.toBase58(),
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      agent: agentB.toBase58(),
      agentAuthority: signerB.publicKey.toBase58(),
      task: taskB.toBase58(),
      recipient: recipientB.toBase58(),
      amountBaseUnits: String(paymentAmount),
      nonce: "0",
      expiresAtUnix: approvalExpiry.toString(),
      requestId,
    };
    const encoded = encodePaymentApprovalV2(approval);
    const ed25519 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: owner.toBytes(),
      message: encoded,
      signature: nacl.sign.detached(encoded, payer.secretKey),
    });
    const requestHash = createHash("sha256")
      .update(Buffer.from(requestId, "utf8"))
      .digest();
    const paymentInstruction = await program.methods
      .executeApprovedPayment(
        new BN(paymentAmount),
        new BN(0),
        approvalExpiry,
        Array.from(requestHash)
      )
      .accountsPartial({
        agentAuthority: signerB.publicKey,
        vault,
        agent: agentB,
        approvedTask: taskB,
        tokenMint: mint,
        treasury,
        recipient: recipientB,
        recipientToken: recipientAtaB,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const revocationInstruction = await program.methods
      .revokeApprovedTask()
      .accountsPartial({ owner, vault, agent: agentB, approvedTask: taskB })
      .instruction();

    // Sign both BEFORE broadcasting, using the same blockhash. The agent's
    // transaction contains native Ed25519 immediately before Model B payment.
    const latest = await connection.getLatestBlockhash("confirmed");
    const paymentTx = new Transaction({
      feePayer: signerB.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(ed25519, paymentInstruction);
    const revocationTx = new Transaction({
      feePayer: owner,
      recentBlockhash: latest.blockhash,
    }).add(revocationInstruction);
    paymentTx.sign(signerB);
    revocationTx.sign(payer);

    const submissions = await Promise.allSettled([
      connection.sendRawTransaction(paymentTx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      }),
      connection.sendRawTransaction(revocationTx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      }),
    ]);
    const signatureOf = (i: number) =>
      submissions[i].status === "fulfilled"
        ? (submissions[i] as PromiseFulfilledResult<string>).value
        : null;
    const paymentSignature = signatureOf(0);
    const revocationSignature = signatureOf(1);
    console.log("Concurrent submissions", {
      payment: submissions[0].status,
      revocation: submissions[1].status,
    });

    async function finalizedOutcome(
      signature: string | null
    ): Promise<"succeeded" | "failed" | "not-submitted" | "unverified"> {
      if (!signature) return "not-submitted";
      try {
        await connection.confirmTransaction(
          { signature, ...latest },
          "finalized"
        );
      } catch {
        // RPC confirmation can throw for a finalized failed transaction.
        // Trust only the finalized on-chain signature status below.
      }
      const status = (
        await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (!status || status.confirmationStatus !== "finalized") {
        return "unverified";
      }
      return status.err ? "failed" : "succeeded";
    }

    const [paymentOutcome, revocationOutcome] = await Promise.all([
      finalizedOutcome(paymentSignature),
      finalizedOutcome(revocationSignature),
    ]);
    console.log("Finalized outcomes", {
      payment: paymentOutcome,
      revocation: revocationOutcome,
    });
    assert.notEqual(
      paymentOutcome,
      "unverified",
      "Payment outcome is ambiguous"
    );
    assert.notEqual(
      revocationOutcome,
      "unverified",
      "Revocation outcome is ambiguous"
    );
    assert.ok(
      paymentOutcome === "succeeded" || revocationOutcome === "succeeded",
      "No verified successful race participant"
    );

    const bAfter = await program.account.approvedTask.fetch(taskB, "confirmed");
    const bSpent = Number(bAfter.spent.toString());
    assert.ok(
      bSpent === 0 || bSpent === paymentAmount,
      "Model B paid an unexpected amount"
    );
    if (paymentOutcome === "succeeded") assert.equal(bSpent, paymentAmount);
    if (paymentOutcome === "failed") assert.equal(bSpent, 0);
    if (revocationOutcome === "succeeded") assert.equal(bAfter.active, false);
    await audit("after competing transactions", bSpent, bAfter.active);

    // If revocation did not land, complete the owner action explicitly.
    // This is cleanup, not proof that the racing revocation succeeded.
    if (bAfter.active) {
      assert.notEqual(revocationOutcome, "succeeded");
      await program.methods
        .revokeApprovedTask()
        .accountsPartial({ owner, vault, agent: agentB, approvedTask: taskB })
        .rpc(options);
    }
    await audit("Model B revoked, Model A reserved", bSpent, false);

    // Try to replay the original, correctly signed approval with a FRESH
    // blockhash. Revocation must reject it, without changing balances.
    await assert.rejects(
      sendAndConfirmTransaction(
        connection,
        new Transaction({ feePayer: signerB.publicKey }).add(
          ed25519,
          paymentInstruction
        ),
        [signerB],
        options
      )
    );
    await audit(
      "original owner approval cannot execute after revoke",
      bSpent,
      false
    );

    // The unrelated Model A reservation remains fully spendable.
    await program.methods
      .executeTaskPayment(new BN(5_000), new BN(0))
      .accountsPartial({
        agentAuthority: signerA.publicKey,
        vault,
        agent: agentA,
        task: taskA,
        tokenMint: mint,
        treasury,
        recipient: recipientA,
        recipientToken: recipientAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signerA])
      .rpc(options);
    await audit(
      "Model A payment unaffected by Model B revoke",
      bSpent,
      false,
      5_000
    );

    // Revoke A as well: both tasks must release all remaining reservations.
    await program.methods
      .revokeTask()
      .accountsPartial({ owner, vault, agent: agentA, task: taskA })
      .rpc(options);
    const finalVault = await program.account.vault.fetch(vault, "confirmed");
    assert.equal(finalVault.totalReserved.toString(), "0");
    const t = await getAccount(
      connection,
      treasury,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    const ra = await getAccount(
      connection,
      recipientAtaA,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    const rb = await getAccount(
      connection,
      recipientAtaB,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    assert.equal(
      t.amount + ra.amount + rb.amount,
      BigInt(initialTreasury),
      "Final token conservation failed"
    );
    await assert.rejects(
      program.methods
        .revokeApprovedTask()
        .accountsPartial({ owner, vault, agent: agentB, approvedTask: taskB })
        .rpc(options)
    );
    console.log(
      "[verified] mixed-model Model B payment/revocation race complete"
    );
  });
});
