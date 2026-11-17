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
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  freezeAccount,
  thawAccount,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "../demo/payment-approval-v2";

describe("AgentVault - Model B Owner Approval Security", () => {
  const envProvider = anchor.AnchorProvider.env();

  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  // Do not use global anchor.workspace in this suite.
  const program = new anchor.Program<Agentvault>(idl, provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const owner = provider.wallet.publicKey;

  const agentSigner = Keypair.generate();
  const attacker = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  const vaultId = new BN(
    Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)).toString(
      "hex"
    ),
    16
  );

  const taskId = new BN(7);
  const taskBudget = new BN(50_000);

  const taskExpiry = new BN(Math.floor(Date.now() / 1000) + 3600);

  const approvalExpiry = new BN(Math.floor(Date.now() / 1000) + 1800);

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

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("approved-task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  let tokenMint: PublicKey;
  let treasuryAta: PublicKey;
  let recipientAta: PublicKey;
  let genesisHash: PublicKey;

  const confirmed = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  async function snapshot() {
    const vault = await program.account.vault.fetch(vaultPda, "confirmed");

    const task = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    const treasury = await getAccount(
      connection,
      treasuryAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    const recipientToken = await getAccount(
      connection,
      recipientAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    return {
      reserved: vault.totalReserved.toString(),
      spent: task.spent.toString(),
      nonce: task.nextNonce.toString(),
      treasury: treasury.amount.toString(),
      recipient: recipientToken.amount.toString(),
    };
  }

  function approval(
    amount: number,
    nonce: number,
    requestId: string
  ): PaymentApprovalV2 {
    return {
      version: 2,
      genesisHash: genesisHash.toBase58(),
      programId: program.programId.toBase58(),
      vault: vaultPda.toBase58(),
      owner: owner.toBase58(),
      mint: tokenMint.toBase58(),
      agent: agentPda.toBase58(),
      agentAuthority: agentSigner.publicKey.toBase58(),
      task: approvedTaskPda.toBase58(),
      recipient: recipient.toBase58(),
      amountBaseUnits: String(amount),
      nonce: String(nonce),
      expiresAtUnix: approvalExpiry.toString(),
      requestId,
    };
  }

  function ed25519Instruction(
    input: PaymentApprovalV2,
    signer = payer
  ): TransactionInstruction {
    const message = encodePaymentApprovalV2(input);
    const signature = nacl.sign.detached(message, signer.secretKey);

    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: signer.publicKey.toBytes(),
      message,
      signature,
    });
  }

  function forgedInstruction(input: PaymentApprovalV2): TransactionInstruction {
    const message = encodePaymentApprovalV2(input);

    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: owner.toBytes(),
      message,
      signature: nacl.sign.detached(message, attacker.secretKey),
    });
  }

  function errorDetails(error: unknown): string {
    const e = error as {
      message?: string;
      logs?: string[];
      error?: { errorCode?: { code?: string } };
    };

    return [
      e.message ?? String(error),
      e.error?.errorCode?.code ?? "",
      ...(e.logs ?? []),
    ].join("\n");
  }

  async function paymentInstruction(
    amount: number,
    nonce: number,
    requestId: string,
    options: {
      expiresAt?: BN;
      recipient?: PublicKey;
      approvedTask?: PublicKey;
    } = {}
  ): Promise<TransactionInstruction> {
    const requestHash = createHash("sha256")
      .update(Buffer.from(requestId, "utf8"))
      .digest();

    return program.methods
      .executeApprovedPayment(
        new BN(amount),
        new BN(nonce),
        options.expiresAt ?? approvalExpiry,
        Array.from(requestHash)
      )
      .accountsPartial({
        agentAuthority: agentSigner.publicKey,
        vault: vaultPda,
        agent: agentPda,
        approvedTask: options.approvedTask ?? approvedTaskPda,
        tokenMint,
        treasury: treasuryAta,
        recipient: options.recipient ?? recipient,
        recipientToken: recipientAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async function send(...instructions: TransactionInstruction[]) {
    // The agent, NOT the owner, pays fees and signs
    // the on-chain transaction.
    const transaction = new Transaction({
      feePayer: agentSigner.publicKey,
    }).add(...instructions);

    return sendAndConfirmTransaction(
      connection,
      transaction,
      [agentSigner],
      confirmed
    );
  }

  before(async () => {
    assert.ok(owner.equals(payer.publicKey));

    genesisHash = new PublicKey(await connection.getGenesisHash());

    tokenMint = await createMint(
      connection,
      payer,
      owner,
      owner,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    treasuryAta = getAssociatedTokenAddressSync(tokenMint, vaultPda, true);

    const ownerAta = getAssociatedTokenAddressSync(tokenMint, owner);

    recipientAta = getAssociatedTokenAddressSync(tokenMint, recipient);

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(confirmed);

    const createAccounts = new Transaction();

    for (const [ata, authority] of [
      [treasuryAta, vaultPda],
      [ownerAta, owner],
      [recipientAta, recipient],
    ] as const) {
      createAccounts.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ata,
          authority,
          tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    await sendAndConfirmTransaction(
      connection,
      createAccounts,
      [payer],
      confirmed
    );

    await mintTo(
      connection,
      payer,
      tokenMint,
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
        vault: vaultPda,
        tokenMint,
        ownerTokenAccount: ownerAta,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(confirmed);

    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(confirmed);

    await program.methods
      .createApprovedTask(
        taskId,
        taskBudget,
        recipient,
        taskExpiry,
        genesisHash
      )
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        approvedTask: approvedTaskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(confirmed);

    // Fund only the agent's transaction fees.
    // The agent never receives treasury authority.
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: agentSigner.publicKey,
          lamports: LAMPORTS_PER_SOL,
        })
      ),
      [payer],
      confirmed
    );

    assert.deepEqual(await snapshot(), {
      reserved: "50000",
      spent: "0",
      nonce: "0",
      treasury: "100000",
      recipient: "0",
    });
  });

  it("rejects payments without preceding owner approval", async () => {
    const beforeState = await snapshot();

    await assert.rejects(
      send(await paymentInstruction(1_000, 0, "modelb-req-001"))
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects a forged owner Ed25519 signature", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 0, "modelb-req-002");

    await assert.rejects(
      send(
        forgedInstruction(input),
        await paymentInstruction(1_000, 0, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects a valid signature from another owner", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 0, "modelb-req-003");

    await assert.rejects(
      send(
        ed25519Instruction(input, attacker),
        await paymentInstruction(1_000, 0, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects modifying the amount after owner approval", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 0, "modelb-req-004");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(2_000, 0, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects unrelated instructions between approval and payment", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 0, "modelb-req-005");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        SystemProgram.transfer({
          fromPubkey: agentSigner.publicKey,
          toPubkey: owner,
          lamports: 1,
        }),
        await paymentInstruction(1_000, 0, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("executes an exact owner-approved payment with agent-only transaction signing", async () => {
    const input = approval(1_000, 0, "modelb-req-006");

    const signature = await send(
      ed25519Instruction(input),
      await paymentInstruction(1_000, 0, input.requestId)
    );

    console.log("Confirmed Model B payment:", signature);

    assert.deepEqual(await snapshot(), {
      reserved: "49000",
      spent: "1000",
      nonce: "1",
      treasury: "99000",
      recipient: "1000",
    });
  });

  it("rejects replay of an already executed owner approval", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 0, "modelb-req-006");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 0, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects skipped payment nonces", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 3, "modelb-req-007");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 3, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects a signed payment exceeding task budget", async () => {
    const beforeState = await snapshot();
    const input = approval(60_000, 1, "modelb-req-008");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(60_000, 1, input.requestId)
      )
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects changing the signed request identity", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 1, "modelb-req-009");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 1, "modelb-req-010")
      ),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects an expired but correctly signed owner approval", async () => {
    const beforeState = await snapshot();
    const expiredAt = Math.floor(Date.now() / 1000) - 60;

    const input: PaymentApprovalV2 = {
      ...approval(1_000, 1, "modelb-req-011"),
      expiresAtUnix: String(expiredAt),
    };

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 1, input.requestId, {
          expiresAt: new BN(expiredAt),
        })
      ),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects recipient substitution", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 1, "modelb-req-012");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 1, input.requestId, {
          recipient: Keypair.generate().publicKey,
        })
      ),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /ConstraintAddress|address constraint/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("blocks a valid owner-approved payment while the vault is paused", async () => {
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({
        owner,
        vault: vaultPda,
      })
      .rpc(confirmed);

    const beforeState = await snapshot();

    try {
      const input = approval(1_000, 1, "modelb-req-013");

      await assert.rejects(
        send(
          ed25519Instruction(input),
          await paymentInstruction(1_000, 1, input.requestId)
        ),
        (error: unknown) => {
          assert.match(errorDetails(error), /VaultPaused|Vault is paused/i);
          return true;
        }
      );

      assert.deepEqual(await snapshot(), beforeState);
    } finally {
      await program.methods
        .setVaultPaused(false)
        .accountsPartial({
          owner,
          vault: vaultPda,
        })
        .rpc(confirmed);
    }
  });

  it("rolls back payment accounting when the recipient token account is frozen", async () => {
    await freezeAccount(
      connection,
      payer,
      recipientAta,
      tokenMint,
      payer,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    try {
      const frozen = await getAccount(
        connection,
        recipientAta,
        "confirmed",
        TOKEN_PROGRAM_ID
      );

      assert.equal(frozen.isFrozen, true);

      const beforeState = await snapshot();
      const input = approval(1_000, 1, "modelb-req-014");

      await assert.rejects(
        send(
          ed25519Instruction(input),
          await paymentInstruction(1_000, 1, input.requestId)
        ),
        (error: unknown) => {
          assert.match(
            errorDetails(error),
            /AccountFrozen|account is frozen|0x11/i
          );
          return true;
        }
      );

      // Both token balances and on-chain accounting
      // must remain unchanged after the failed CPI.
      assert.deepEqual(await snapshot(), beforeState);
    } finally {
      await thawAccount(
        connection,
        payer,
        recipientAta,
        tokenMint,
        payer,
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );
    }
  });

  it("rejects using an approval for a different Model B task", async () => {
    const beforeState = await snapshot();
    const secondTaskId = new BN(8);

    const [secondTaskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("approved-task"),
        agentPda.toBuffer(),
        secondTaskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createApprovedTask(
        secondTaskId,
        new BN(2_000),
        recipient,
        taskExpiry,
        genesisHash
      )
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        approvedTask: secondTaskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(confirmed);

    try {
      // The owner signs for the ORIGINAL task.
      const input = approval(1_000, 0, "modelb-cross-task");

      // The agent attempts to spend from a DIFFERENT task.
      await assert.rejects(
        send(
          ed25519Instruction(input),
          await paymentInstruction(1_000, 0, input.requestId, {
            approvedTask: secondTaskPda,
          })
        ),
        (error: unknown) => {
          assert.match(
            errorDetails(error),
            /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
          );
          return true;
        }
      );
    } finally {
      // Release the temporary task reservation.
      await program.methods
        .revokeApprovedTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          approvedTask: secondTaskPda,
        })
        .rpc(confirmed);
    }

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects a noncanonical Ed25519 instruction with trailing data", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 1, "modelb-noncanonical");

    const edInstruction = ed25519Instruction(input);

    // The signed message and signature remain intact.
    // Only the instruction's data layout changes.
    edInstruction.data = Buffer.concat([edInstruction.data, Buffer.from([0])]);

    await assert.rejects(
      send(edInstruction, await paymentInstruction(1_000, 1, input.requestId)),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects owner approvals extending beyond task expiry", async () => {
    const beforeState = await snapshot();

    const invalidExpiry = taskExpiry.add(new BN(60));

    const input: PaymentApprovalV2 = {
      ...approval(1_000, 1, "modelb-invalid-expiry-bound"),
      expiresAtUnix: invalidExpiry.toString(),
    };

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 1, input.requestId, {
          expiresAt: invalidExpiry,
        })
      ),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("rejects an Ed25519 instruction using an explicit self-reference", async () => {
    const beforeState = await snapshot();
    const input = approval(1_000, 1, "modelb-explicit-self-ref");

    const edInstruction = ed25519Instruction(input);

    // Byte offset 14 stores message_instruction_index.
    // Index 0 references this same Ed25519 instruction.
    // Native Ed25519 verification should still succeed,
    // but AgentVault requires the canonical 0xffff value.
    edInstruction.data.writeUInt16LE(0, 14);

    await assert.rejects(
      send(edInstruction, await paymentInstruction(1_000, 1, input.requestId)),
      (error: unknown) => {
        assert.match(
          errorDetails(error),
          /InvalidOwnerApproval|Invalid Ed25519 owner approval/i
        );
        return true;
      }
    );

    assert.deepEqual(await snapshot(), beforeState);
  });

  it("revokes the remaining Model B budget and blocks future payments", async () => {
    const beforeState = await snapshot();

    assert.equal(beforeState.reserved, "49000");
    assert.equal(beforeState.spent, "1000");
    assert.equal(beforeState.nonce, "1");

    await program.methods
      .revokeApprovedTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        approvedTask: approvedTaskPda,
      })
      .rpc(confirmed);

    const revoked = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    assert.equal(revoked.active, false);

    const afterRevocation = await snapshot();

    assert.deepEqual(afterRevocation, {
      ...beforeState,
      reserved: "0",
    });

    await assert.rejects(
      program.methods
        .revokeApprovedTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          approvedTask: approvedTaskPda,
        })
        .rpc(confirmed),
      (error: unknown) => {
        assert.match(errorDetails(error), /TaskInactive|Task is inactive/i);
        return true;
      }
    );

    const input = approval(1_000, 1, "modelb-req-015");

    await assert.rejects(
      send(
        ed25519Instruction(input),
        await paymentInstruction(1_000, 1, input.requestId)
      ),
      (error: unknown) => {
        assert.match(errorDetails(error), /TaskInactive|Task is inactive/i);
        return true;
      }
    );

    assert.deepEqual(await snapshot(), afterRevocation);
  });

  it("blocks owner-approved payments after agent deactivation", async () => {
    const id = new BN(99);

    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("approved-task"),
        agentPda.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Create an active, funded Model B task before
    // deactivating the agent.
    await program.methods
      .createApprovedTask(id, new BN(2_000), recipient, taskExpiry, genesisHash)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        approvedTask: taskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(confirmed);

    await program.methods
      .deactivateAgent()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
      })
      .rpc(confirmed);

    const input: PaymentApprovalV2 = {
      ...approval(1_000, 0, "modelb-inactive-agent"),
      task: taskPda.toBase58(),
    };

    const beforeState = await snapshot();

    try {
      await assert.rejects(
        send(
          ed25519Instruction(input),
          await paymentInstruction(1_000, 0, input.requestId, {
            approvedTask: taskPda,
          })
        ),
        (error: unknown) => {
          assert.match(errorDetails(error), /AgentInactive|Agent is inactive/i);
          return true;
        }
      );

      assert.deepEqual(await snapshot(), beforeState);

      const task = await program.account.approvedTask.fetch(
        taskPda,
        "confirmed"
      );

      assert.equal(task.spent.toString(), "0");
      assert.equal(task.nextNonce.toString(), "0");
    } finally {
      // The owner must be able to recover reservations
      // even after the agent has been deactivated.
      await program.methods
        .revokeApprovedTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          approvedTask: taskPda,
        })
        .rpc(confirmed);
    }

    assert.equal((await snapshot()).reserved, "0");
  });
});
