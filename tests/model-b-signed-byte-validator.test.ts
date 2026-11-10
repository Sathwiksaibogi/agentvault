import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  VersionedTransaction,
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
import type { ModelBWorkflowBinding } from "../demo/model-b-workflow-binding";
import type { WorkflowApprovalV2 } from "../demo/signed-workflow-v2";
import type { PaymentApprovalV2 } from "../demo/payment-approval-v2";
import { signModelBOwnerApprovalPackage } from "../demo/model-b-owner-approval";
import { buildUnsignedModelBPayment } from "../demo/model-b-payment-builder";
import { prepareDurableModelBPayment } from "../demo/model-b-durable-preparation";
import { loadPreparedModelBPayment } from "../demo/model-b-prepared-payment";
import { AGENTVAULT_PROGRAM_ID } from "../demo/payment-transaction-guard";

/**
 * REAL local-validator integration tests for the production Model B builder,
 * the shared durable journal and the on-chain execute_approved_payment handler.
 *
 * This suite never invokes the Devnet-only coordinator or submission helper.
 * It creates a fresh local vault/mint/task and uses only generated test keys.
 * Run with an Anchor local validator, NOT against Devnet/Mainnet.
 */
describe("AgentVault - Model B signed-byte local-validator lifecycle", () => {
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
  const ownerSigner = (provider.wallet as anchor.Wallet).payer;
  const owner = provider.wallet.publicKey;
  const agentSigner = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const vaultId = new BN(
    Buffer.from(Keypair.generate().publicKey.toBytes().subarray(0, 8)).toString(
      "hex"
    ),
    16
  );
  const taskId = new BN(97);
  const taskBudget = new BN(10_000);
  const amount = 1_000;
  const runtimeDir = mkdtempSync(
    join(tmpdir(), "agentvault-model-b-validator-")
  );
  const requestId = "modelb-validator-001";

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

  let mint: PublicKey;
  let genesisHash: string;
  let taskExpiry: BN;
  let treasuryAta: PublicKey;
  let recipientAta: PublicKey;
  let originalBinding: ModelBWorkflowBinding;
  let originalSignature: string;

  async function chainNow(): Promise<number> {
    const clock = await connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );
    assert.ok(clock, "Local validator Clock sysvar not available");
    const value = Number(clock.data.readBigInt64LE(32));
    assert.ok(Number.isSafeInteger(value));
    return value;
  }

  async function state() {
    const [vault, task, treasury, to] = await Promise.all([
      program.account.vault.fetch(vaultPda, "confirmed"),
      program.account.approvedTask.fetch(approvedTaskPda, "confirmed"),
      getAccount(connection, treasuryAta, "confirmed", TOKEN_PROGRAM_ID),
      getAccount(connection, recipientAta, "confirmed", TOKEN_PROGRAM_ID),
    ]);
    return {
      reserved: vault.totalReserved.toString(),
      spent: task.spent.toString(),
      nonce: task.nextNonce.toString(),
      treasury: treasury.amount.toString(),
      recipient: to.amount.toString(),
    };
  }

  async function ownerBinding(nonce: string): Promise<ModelBWorkflowBinding> {
    const nowUnix = await chainNow();
    const workflow: WorkflowApprovalV2 = {
      version: 2,
      authorizationModel: "model-b",
      network: "localnet",
      requestId,
      genesisHash,
      programId: program.programId.toBase58(),
      vault: vaultPda.toBase58(),
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      assignedAgent: "agent-a",
      agentAuthority: agentSigner.publicKey.toBase58(),
      kind: "procurement",
      taskId: taskId.toNumber(),
      recipient: recipient.toBase58(),
      amountBaseUnits: amount,
      expiresAtUnix: nowUnix + 1800,
      description: "Local-validator signed-byte payment integration",
    };
    const payment: PaymentApprovalV2 = {
      version: 2,
      genesisHash,
      programId: workflow.programId,
      vault: workflow.vault,
      owner: workflow.owner,
      mint: workflow.mint,
      agent: agentPda.toBase58(),
      agentAuthority: workflow.agentAuthority,
      task: approvedTaskPda.toBase58(),
      recipient: workflow.recipient,
      amountBaseUnits: String(amount),
      nonce,
      expiresAtUnix: String(nowUnix + 900),
      requestId,
    };
    const context = {
      scope: {
        network: workflow.network,
        genesisHash,
        programId: workflow.programId,
        vault: workflow.vault,
        owner: workflow.owner,
        mint: workflow.mint,
      },
      agentPda,
      approvedTaskPda,
      nextNonce: nonce,
      taskExpiresAtUnix: taskExpiry.toString(),
      nowUnix,
    };
    return {
      ...context,
      ...signModelBOwnerApprovalPackage(
        workflow,
        payment,
        ownerSigner,
        context
      ),
    };
  }

  async function signedSimulation(
    transaction: Transaction
  ): Promise<Awaited<ReturnType<typeof connection.simulateTransaction>>> {
    transaction.sign(agentSigner);
    // VersionedTransaction.deserialize supports the legacy transaction format.
    const exact = VersionedTransaction.deserialize(transaction.serialize());
    return connection.simulateTransaction(exact, {
      commitment: "confirmed",
      sigVerify: true,
    });
  }

  before(async () => {
    assert.ok(
      owner.equals(ownerSigner.publicKey),
      "Owner wallet must be the local signer"
    );
    assert.ok(
      program.programId.equals(AGENTVAULT_PROGRAM_ID),
      "Program ID mismatch"
    );
    assert.ok(
      connection.rpcEndpoint.includes("127.0.0.1") ||
        connection.rpcEndpoint.includes("localhost"),
      "Refusing to run wallet-funded validator test on a remote RPC"
    );

    genesisHash = await connection.getGenesisHash();
    taskExpiry = new BN((await chainNow()) + 3600);
    mint = await createMint(
      connection,
      ownerSigner,
      owner,
      owner,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    treasuryAta = getAssociatedTokenAddressSync(mint, vaultPda, true);
    recipientAta = getAssociatedTokenAddressSync(mint, recipient);
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint: mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const ataTx = new Transaction();
    for (const [ata, authority] of [
      [treasuryAta, vaultPda],
      [recipientAta, recipient],
      [ownerAta, owner],
    ] as const) {
      ataTx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ata,
          authority,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    await sendAndConfirmTransaction(connection, ataTx, [ownerSigner], {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await mintTo(
      connection,
      ownerSigner,
      mint,
      ownerAta,
      ownerSigner,
      20_000,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    await program.methods
      .depositTokens(new BN(20_000))
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint: mint,
        ownerTokenAccount: ownerAta,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    await program.methods
      .createApprovedTask(
        taskId,
        taskBudget,
        recipient,
        taskExpiry,
        new PublicKey(genesisHash)
      )
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint: mint,
        treasury: treasuryAta,
        approvedTask: approvedTaskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: agentSigner.publicKey,
          lamports: LAMPORTS_PER_SOL,
        })
      ),
      [ownerSigner],
      { commitment: "confirmed", preflightCommitment: "confirmed" }
    );

    assert.deepEqual(await state(), {
      reserved: "10000",
      spent: "0",
      nonce: "0",
      treasury: "20000",
      recipient: "0",
    });
  });

  after(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("accepts the actual builder and stored signed bytes on the local validator", async () => {
    originalBinding = await ownerBinding("0");
    const latest = await connection.getLatestBlockhash("confirmed");
    const prepared = prepareDurableModelBPayment(
      runtimeDir,
      originalBinding,
      agentSigner,
      latest.blockhash,
      latest.lastValidBlockHeight
    );

    const restored = loadPreparedModelBPayment(
      runtimeDir,
      requestId,
      originalBinding.signedWorkflow,
      originalBinding.scope
    );
    assert.ok(existsSync(join(runtimeDir, "journal", `${requestId}.json`)));
    assert.ok(
      existsSync(join(runtimeDir, "journal", `${requestId}.signed.json`))
    );
    assert.ok(prepared.rawTransaction.equals(restored.raw));

    const simulated = await connection.simulateTransaction(
      VersionedTransaction.deserialize(restored.raw),
      { commitment: "confirmed", sigVerify: true }
    );
    assert.equal(
      simulated.value.err,
      null,
      JSON.stringify(simulated.value.err)
    );

    const signature = await connection.sendRawTransaction(restored.raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    });
    assert.equal(
      signature,
      prepared.signature,
      "Only the saved signature may be sent"
    );
    originalSignature = signature;
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
    assert.equal(confirmation.value.err, null);

    assert.deepEqual(await state(), {
      reserved: "9000",
      spent: "1000",
      nonce: "1",
      treasury: "19000",
      recipient: "1000",
    });
  });

  it("rejects on-chain replay of the exact owner approval with a fresh blockhash", async () => {
    const before = await state();
    const latest = await connection.getLatestBlockhash("confirmed");
    const { transaction } = buildUnsignedModelBPayment(
      originalBinding,
      latest.blockhash
    );
    const simulated = await signedSimulation(transaction);
    assert.notEqual(simulated.value.err, null, "Replay must fail on-chain");
    assert.deepEqual(await state(), before);
  });

  it("rejects an agent-modified amount against the original owner signature", async () => {
    const before = await state();
    const latest = await connection.getLatestBlockhash("confirmed");
    const { transaction, paymentInstruction } = buildUnsignedModelBPayment(
      originalBinding,
      latest.blockhash
    );
    paymentInstruction.data.writeBigUInt64LE(BigInt(amount + 1), 8);
    const simulated = await signedSimulation(transaction);
    assert.notEqual(
      simulated.value.err,
      null,
      "Modified amount must fail on-chain"
    );
    assert.deepEqual(await state(), before);
  });

  it("rejects an instruction inserted between owner verification and payment", async () => {
    const before = await state();
    const latest = await connection.getLatestBlockhash("confirmed");
    const { transaction } = buildUnsignedModelBPayment(
      originalBinding,
      latest.blockhash
    );
    transaction.instructions.splice(
      2,
      0,
      SystemProgram.transfer({
        fromPubkey: agentSigner.publicKey,
        toPubkey: owner,
        lamports: 1,
      })
    );
    const simulated = await signedSimulation(transaction);
    assert.notEqual(
      simulated.value.err,
      null,
      "Ed25519 must directly precede payment"
    );
    assert.deepEqual(await state(), before);
  });

  it("recovers confirmed payment status from the journal without re-signing", async () => {
    const restored = loadPreparedModelBPayment(
      runtimeDir,
      requestId,
      originalBinding.signedWorkflow,
      originalBinding.scope
    );
    assert.ok(restored.transaction.signature);
    assert.equal(restored.record.status, "prepared");
    assert.equal(restored.record.requestId, requestId);
    const current = await connection.getSignatureStatuses([originalSignature], {
      searchTransactionHistory: true,
    });
    assert.ok(current.value[0], "Stored signature must exist on the validator");
    assert.equal(current.value[0]?.err, null);
    assert.ok(
      current.value[0]?.confirmationStatus === "confirmed" ||
        current.value[0]?.confirmationStatus === "finalized",
      "Stored signature must be confirmed or finalized"
    );
    assert.deepEqual(await state(), {
      reserved: "9000",
      spent: "1000",
      nonce: "1",
      treasury: "19000",
      recipient: "1000",
    });
  });

  it("rejects a second durable claim without changing original signed bytes", async () => {
    const before = readFileSync(
      join(runtimeDir, "journal", `${requestId}.signed.json`)
    );
    const latest = await connection.getLatestBlockhash("confirmed");
    assert.throws(
      () =>
        prepareDurableModelBPayment(
          runtimeDir,
          originalBinding,
          agentSigner,
          latest.blockhash,
          latest.lastValidBlockHeight
        ),
      /already claimed/i
    );
    assert.deepEqual(
      readFileSync(join(runtimeDir, "journal", `${requestId}.signed.json`)),
      before
    );
  });
});
