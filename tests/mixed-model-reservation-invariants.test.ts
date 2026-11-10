import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import * as nacl from "tweetnacl";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
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
 * Local-validator only. Models A and B share one funded vault, but have
 * different agents, recipients and PDA namespaces. This test deliberately
 * invokes the on-chain instructions (not the demo workflow or AI evaluator).
 * It never reads demo/devnet state or broadcasts to Devnet.
 */
describe("AgentVault - Mixed Model A/B Reservation Conservation", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, provider);
  const connection = provider.connection;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const options = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  it("preserves aggregate reservations through both models' payments, replay, withdrawals and revocations", async () => {
    assert.ok(owner.equals(payer.publicKey));
    // This suite creates and moves test tokens. Refuse remote RPC endpoints;
    // the normal Anchor local-validator RPC is http://127.0.0.1:8899.
    const rpcUrl = new URL(connection.rpcEndpoint);
    assert.ok(
      rpcUrl.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(rpcUrl.hostname),
      "Mixed-model validator tests must use a local HTTP RPC endpoint"
    );
    const genesis = await connection.getGenesisHash();
    assert.notEqual(
      genesis,
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "Devnet genesis is not permitted in local-validator tests"
    );

    const agentASigner = Keypair.generate();
    const agentBSigner = Keypair.generate();
    const recipientA = Keypair.generate().publicKey;
    const recipientB = Keypair.generate().publicKey;
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );
    const taskIdA = new BN(1);
    const taskIdB = new BN(2);
    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 86_400);
    const approvalExpiresAt = new BN(Math.floor(Date.now() / 1000) + 3_600);
    const genesisHash = new PublicKey(genesis);

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
    const agentA = agentPda(agentASigner.publicKey);
    const agentB = agentPda(agentBSigner.publicKey);
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

    // Isolated fixture. All accounts are created for this test on the local
    // validator. No existing AgentVault vault or treasury is reused.
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
      100_000,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    await program.methods
      .depositTokens(new BN(100_000))
      .accountsPartial({
        owner,
        vault,
        tokenMint: mint,
        ownerTokenAccount: ownerAta,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(options);

    for (const [agentSigner, agent] of [
      [agentASigner, agentA],
      [agentBSigner, agentB],
    ] as const) {
      await program.methods
        .registerAgent(agentSigner.publicKey)
        .accountsPartial({
          owner,
          vault,
          agent,
          systemProgram: SystemProgram.programId,
        })
        .rpc(options);
    }
    // Model B's transaction fee payer is the agent; treasury authority is
    // still the vault PDA and Model B owner approval is a separate signature.
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: agentBSigner.publicKey,
          lamports: 100_000_000,
        })
      ),
      [payer],
      options
    );

    let aCreated = false;
    let bCreated = false;
    const expected = {
      reserved: 0,
      treasury: 100_000,
      ownerBalance: 0,
      paidA: 0,
      paidB: 0,
      aSpent: 0,
      bSpent: 0,
      aNonce: 0,
      bNonce: 0,
      aActive: false,
      bActive: false,
    };

    async function audit(stage: string) {
      const [
        vaultState,
        treasuryState,
        ownerState,
        recipientStateA,
        recipientStateB,
      ] = await Promise.all([
        program.account.vault.fetch(vault, "confirmed"),
        getAccount(connection, treasury, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, ownerAta, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, recipientAtaA, "confirmed", TOKEN_PROGRAM_ID),
        getAccount(connection, recipientAtaB, "confirmed", TOKEN_PROGRAM_ID),
      ]);
      const stateA = aCreated
        ? await program.account.task.fetch(taskA, "confirmed")
        : null;
      const stateB = bCreated
        ? await program.account.approvedTask.fetch(taskB, "confirmed")
        : null;

      let independentlyReserved = BigInt(0);
      if (stateA) {
        assert.ok(stateA.vault.equals(vault) && stateA.agent.equals(agentA));
        assert.ok(
          stateA.spent.lte(stateA.budget),
          `${stage}: Model A overspent`
        );
        if (stateA.active) {
          independentlyReserved += BigInt(
            stateA.budget.sub(stateA.spent).toString()
          );
        }
        assert.equal(stateA.spent.toString(), String(expected.aSpent));
        assert.equal(stateA.nextNonce.toString(), String(expected.aNonce));
        assert.equal(stateA.active, expected.aActive);
      }
      if (stateB) {
        assert.ok(stateB.vault.equals(vault) && stateB.agent.equals(agentB));
        assert.ok(stateB.genesisHash.equals(genesisHash));
        assert.ok(
          stateB.spent.lte(stateB.budget),
          `${stage}: Model B overspent`
        );
        if (stateB.active) {
          independentlyReserved += BigInt(
            stateB.budget.sub(stateB.spent).toString()
          );
        }
        assert.equal(stateB.spent.toString(), String(expected.bSpent));
        assert.equal(stateB.nextNonce.toString(), String(expected.bNonce));
        assert.equal(stateB.active, expected.bActive);
      }

      const reserved = BigInt(vaultState.totalReserved.toString());
      assert.equal(
        reserved,
        independentlyReserved,
        `${stage}: aggregate reservation mismatch`
      );
      assert.equal(
        reserved,
        BigInt(expected.reserved),
        `${stage}: reserved balance`
      );
      assert.equal(
        treasuryState.amount,
        BigInt(expected.treasury),
        `${stage}: treasury`
      );
      assert.equal(
        ownerState.amount,
        BigInt(expected.ownerBalance),
        `${stage}: owner`
      );
      assert.equal(
        recipientStateA.amount,
        BigInt(expected.paidA),
        `${stage}: recipient A`
      );
      assert.equal(
        recipientStateB.amount,
        BigInt(expected.paidB),
        `${stage}: recipient B`
      );
      assert.equal(
        treasuryState.amount +
          ownerState.amount +
          recipientStateA.amount +
          recipientStateB.amount,
        BigInt(100_000),
        `${stage}: SPL token conservation`
      );
      assert.ok(
        reserved <= treasuryState.amount,
        `${stage}: treasury undercollateralized`
      );
      console.log(
        `[${stage}] reserved=${reserved}, treasury=${treasuryState.amount}`
      );
    }

    function modelBApproval(
      amount: number,
      nonce: number,
      requestId: string
    ): PaymentApprovalV2 {
      return {
        version: 2,
        genesisHash: genesisHash.toBase58(),
        programId: program.programId.toBase58(),
        vault: vault.toBase58(),
        owner: owner.toBase58(),
        mint: mint.toBase58(),
        agent: agentB.toBase58(),
        agentAuthority: agentBSigner.publicKey.toBase58(),
        task: taskB.toBase58(),
        recipient: recipientB.toBase58(),
        amountBaseUnits: String(amount),
        nonce: String(nonce),
        expiresAtUnix: approvalExpiresAt.toString(),
        requestId,
      };
    }

    async function modelBPayment(
      amount: number,
      nonce: number,
      requestId: string,
      withApproval = true
    ) {
      const input = modelBApproval(amount, nonce, requestId);
      const message = encodePaymentApprovalV2(input);
      const ed25519 = Ed25519Program.createInstructionWithPublicKey({
        publicKey: owner.toBytes(),
        message,
        signature: nacl.sign.detached(message, payer.secretKey),
      });
      const requestIdHash = createHash("sha256")
        .update(requestId, "utf8")
        .digest();
      const payment: TransactionInstruction = await program.methods
        .executeApprovedPayment(
          new BN(amount),
          new BN(nonce),
          approvalExpiresAt,
          Array.from(requestIdHash)
        )
        .accountsPartial({
          agentAuthority: agentBSigner.publicKey,
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
      const tx = new Transaction({ feePayer: agentBSigner.publicKey });
      if (withApproval) tx.add(ed25519);
      tx.add(payment);
      return sendAndConfirmTransaction(connection, tx, [agentBSigner], options);
    }

    async function modelAPayment(amount: number, nonce: number) {
      return program.methods
        .executeTaskPayment(new BN(amount), new BN(nonce))
        .accountsPartial({
          agentAuthority: agentASigner.publicKey,
          vault,
          agent: agentA,
          task: taskA,
          tokenMint: mint,
          treasury,
          recipient: recipientA,
          recipientToken: recipientAtaA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agentASigner])
        .rpc(options);
    }

    await audit("funded, no tasks");

    await program.methods
      .createTask(taskIdA, new BN(40_000), recipientA, expiresAt)
      .accountsPartial({
        owner,
        vault,
        agent: agentA,
        tokenMint: mint,
        treasury,
        task: taskA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(options);
    aCreated = true;
    Object.assign(expected, { reserved: 40_000, aActive: true });
    await audit("Model A reserved");

    await program.methods
      .createApprovedTask(
        taskIdB,
        new BN(30_000),
        recipientB,
        expiresAt,
        genesisHash
      )
      .accountsPartial({
        owner,
        vault,
        agent: agentB,
        tokenMint: mint,
        treasury,
        approvedTask: taskB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(options);
    bCreated = true;
    Object.assign(expected, { reserved: 70_000, bActive: true });
    await audit("both models reserved");

    // The unreserved 30,000 cannot back a third 31,000-unit task.
    const excessId = new BN(3);
    const excessPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("approved-task"),
        agentB.toBuffer(),
        excessId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
    await assert.rejects(
      program.methods
        .createApprovedTask(
          excessId,
          new BN(31_000),
          recipientB,
          expiresAt,
          genesisHash
        )
        .accountsPartial({
          owner,
          vault,
          agent: agentB,
          tokenMint: mint,
          treasury,
          approvedTask: excessPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(options)
    );
    assert.equal(await connection.getAccountInfo(excessPda, "confirmed"), null);
    await audit("rejected cross-model overreservation");

    await assert.rejects(
      program.methods
        .withdrawUnreserved(new BN(30_001))
        .accountsPartial({
          owner,
          vault,
          tokenMint: mint,
          treasury,
          ownerTokenAccount: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(options)
    );
    await audit("rejected withdrawal of reserved tokens");

    await program.methods
      .withdrawUnreserved(new BN(10_000))
      .accountsPartial({
        owner,
        vault,
        tokenMint: mint,
        treasury,
        ownerTokenAccount: ownerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(options);
    Object.assign(expected, { ownerBalance: 10_000, treasury: 90_000 });
    await audit("unreserved owner withdrawal");

    await modelAPayment(10_000, 0);
    Object.assign(expected, {
      reserved: 60_000,
      treasury: 80_000,
      paidA: 10_000,
      aSpent: 10_000,
      aNonce: 1,
    });
    await audit("Model A first partial payment");
    await assert.rejects(modelAPayment(1_000, 0));
    await audit("Model A replay rejected; Model B reservation preserved");

    // A valid agent signature without the owner's Ed25519 instruction cannot
    // spend from the Model B budget, even though that budget is funded.
    await assert.rejects(
      modelBPayment(7_000, 0, "mixed-model-no-owner", false)
    );
    await audit("Model B unsigned owner approval rejected");

    await modelBPayment(7_000, 0, "mixed-model-b1");
    Object.assign(expected, {
      reserved: 53_000,
      treasury: 73_000,
      paidB: 7_000,
      bSpent: 7_000,
      bNonce: 1,
    });
    await audit("Model B first partial payment");
    await assert.rejects(modelBPayment(7_000, 0, "mixed-model-b1"));
    await audit("Model B signed replay rejected; Model A unchanged");

    await modelBPayment(3_000, 1, "mixed-model-b2");
    Object.assign(expected, {
      reserved: 50_000,
      treasury: 70_000,
      paidB: 10_000,
      bSpent: 10_000,
      bNonce: 2,
    });
    await audit("Model B second partial payment");

    await program.methods
      .revokeApprovedTask()
      .accountsPartial({ owner, vault, agent: agentB, approvedTask: taskB })
      .rpc(options);
    Object.assign(expected, { reserved: 30_000, bActive: false });
    await audit("Model B revoked; Model A reservation preserved");
    await assert.rejects(modelBPayment(1_000, 2, "mixed-model-after-revoke"));
    await audit("Model B post-revocation payment rejected");

    await modelAPayment(5_000, 1);
    Object.assign(expected, {
      reserved: 25_000,
      treasury: 65_000,
      paidA: 15_000,
      aSpent: 15_000,
      aNonce: 2,
    });
    await audit("Model A remains spendable after Model B revocation");

    await program.methods
      .revokeTask()
      .accountsPartial({ owner, vault, agent: agentA, task: taskA })
      .rpc(options);
    Object.assign(expected, { reserved: 0, aActive: false });
    await audit("Model A revoked; all reservations released");

    await assert.rejects(
      program.methods
        .revokeTask()
        .accountsPartial({ owner, vault, agent: agentA, task: taskA })
        .rpc(options)
    );
    await assert.rejects(
      program.methods
        .revokeApprovedTask()
        .accountsPartial({ owner, vault, agent: agentB, approvedTask: taskB })
        .rpc(options)
    );
    await audit("both duplicate revocations rejected");
  });
});
