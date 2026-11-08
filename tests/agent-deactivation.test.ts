
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

describe("AgentVault - Agent Deactivation Security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcOptions = {
    commitment: "confirmed" as const,
    preflightCommitment: "confirmed" as const,
  };

  async function expectProgramError(
    action: () => Promise<unknown>,
    expectedCode: RegExp
  ) {
    await assert.rejects(action, (error: any) => {
      const details = [
        error?.message ?? "",
        error?.error?.errorCode?.code ?? "",
        ...(error?.logs ?? []),
        ...(error?.transactionLogs ?? []),
      ].join("\n");

      assert.match(details, expectedCode);
      return true;
    });
  }

  it("deactivates an agent during pause without releasing task funds", async () => {
    const vaultId = new BN(
      Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
      "le"
    );

    const agentSigner = Keypair.generate();
    const attacker = Keypair.generate();
    const recipient = Keypair.generate().publicKey;

    const taskId = new BN(1);
    const taskBudget = new BN(60_000);
    const depositAmount = new BN(100_000);
    const paymentAmount = new BN(10_000);

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

    const ownerAta = getAssociatedTokenAddressSync(
      tokenMint, owner, false,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const treasuryAta = getAssociatedTokenAddressSync(
      tokenMint, vaultPda, true,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = getAssociatedTokenAddressSync(
      tokenMint, recipient, false,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Initialize vault and token accounts.
    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

    const ataTransaction = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner, ownerAta, owner, tokenMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, treasuryAta, vaultPda, tokenMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, recipientAta, recipient, tokenMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(
      provider.connection,
      ataTransaction,
      [payer],
      { commitment: "confirmed" }
    );

    // Fund the vault.
    await mintTo(
      provider.connection,
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

    // Register an active agent.
    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOptions);

      // Register an independent second agent.
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

    const clockInfo = await provider.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );
    assert.ok(clockInfo);

    const expiresAt = new BN(
      Number(clockInfo.data.readBigInt64LE(32)) + 3600
    );

    // Create a task with 60,000 reserved units.
    await program.methods
      .createTask(taskId, taskBudget, recipient, expiresAt)
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

    // Execute a 10,000-unit payment before deactivation.
    await program.methods
      .executeTaskPayment(paymentAmount, new BN(0))
      .accountsPartial({
        agentAuthority: agentSigner.publicKey,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
        tokenMint,
        treasury: treasuryAta,
        recipient,
        recipientToken: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentSigner])
      .rpc(rpcOptions);

    const vaultBefore = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    const taskBefore = await program.account.task.fetch(
      taskPda, "confirmed"
    );
    const treasuryBefore = await getAccount(
      provider.connection, treasuryAta, "confirmed", TOKEN_PROGRAM_ID
    );
    const recipientBefore = await getAccount(
      provider.connection, recipientAta, "confirmed", TOKEN_PROGRAM_ID
    );

    assert.ok(taskBefore.spent.eq(paymentAmount));
    assert.ok(taskBefore.nextNonce.eq(new BN(1)));
    assert.ok(vaultBefore.totalReserved.eq(new BN(50_000)));
    assert.strictEqual(treasuryBefore.amount, BigInt(90_000));
    assert.strictEqual(recipientBefore.amount, BigInt(10_000));

    // Pause the vault.
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    const pausedVault = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    assert.strictEqual(pausedVault.paused, true);

    // An attacker must not be able to disable the agent.
    await expectProgramError(
      () =>
        program.methods
          .deactivateAgent()
          .accountsPartial({
            owner: attacker.publicKey,
            vault: vaultPda,
            agent: agentPda,
          })
          .signers([attacker])
          .rpc(rpcOptions),
      /ConstraintHasOne|ConstraintSeeds/
    );

    const agentAfterAttack = await program.account.agent.fetch(
      agentPda, "confirmed"
    );
    assert.strictEqual(agentAfterAttack.active, true);

    // Owner can disable the agent even while paused.
    await program.methods
      .deactivateAgent()
      .accountsPartial({ owner, vault: vaultPda, agent: agentPda })
      .rpc(rpcOptions);

    // Repeated deactivation is intentionally idempotent.
    await program.methods
      .deactivateAgent()
      .accountsPartial({ owner, vault: vaultPda, agent: agentPda })
      .rpc(rpcOptions);

    const disabledAgent = await program.account.agent.fetch(
      agentPda, "confirmed"
    );
    const vaultAfter = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    const taskAfter = await program.account.task.fetch(
      taskPda, "confirmed"
    );
    const treasuryAfter = await getAccount(
      provider.connection, treasuryAta, "confirmed", TOKEN_PROGRAM_ID
    );
    const recipientAfter = await getAccount(
      provider.connection, recipientAta, "confirmed", TOKEN_PROGRAM_ID
    );

    assert.strictEqual(disabledAgent.active, false);
    assert.strictEqual(vaultAfter.paused, true);
    assert.strictEqual(taskAfter.active, true);
    assert.ok(taskAfter.spent.eq(taskBefore.spent));
    assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));
    assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));
    assert.strictEqual(treasuryAfter.amount, treasuryBefore.amount);
    assert.strictEqual(recipientAfter.amount, recipientBefore.amount);

    // Unpause: an inactive agent must still be unable to spend.
    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    const unpausedVault = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    assert.strictEqual(unpausedVault.paused, false);

    await expectProgramError(
      () =>
        program.methods
          .executeTaskPayment(new BN(1_000), taskAfter.nextNonce)
          .accountsPartial({
            agentAuthority: agentSigner.publicKey,
            vault: vaultPda,
            agent: agentPda,
            task: taskPda,
            tokenMint,
            treasury: treasuryAta,
            recipient,
            recipientToken: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agentSigner])
          .rpc(rpcOptions),
      /AgentInactive/
    );

    const vaultAfterBlockedPayment = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    assert.ok(
      vaultAfterBlockedPayment.totalReserved.eq(vaultBefore.totalReserved)
    );

    // Owner can still revoke the inactive agent's task during pause.
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc(rpcOptions);

    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        task: taskPda,
      })
      .rpc(rpcOptions);

    const taskFinal = await program.account.task.fetch(
      taskPda, "confirmed"
    );
    const vaultFinal = await program.account.vault.fetch(
      vaultPda, "confirmed"
    );
    const treasuryFinal = await getAccount(
      provider.connection, treasuryAta, "confirmed", TOKEN_PROGRAM_ID
    );
    const recipientFinal = await getAccount(
      provider.connection, recipientAta, "confirmed", TOKEN_PROGRAM_ID
    );

    assert.strictEqual(taskFinal.active, false);
    assert.strictEqual(vaultFinal.paused, true);
    assert.ok(taskFinal.spent.eq(taskBefore.spent));
    assert.ok(taskFinal.nextNonce.eq(taskBefore.nextNonce));
    assert.ok(vaultFinal.totalReserved.eq(new BN(0)));
    assert.strictEqual(treasuryFinal.amount, treasuryBefore.amount);
    assert.strictEqual(recipientFinal.amount, recipientBefore.amount);
    // Verify that Agent A's deactivation does not disable Agent B.

// Unpause to allow normal spending.
await program.methods
  .setVaultPaused(false)
  .accountsPartial({ owner, vault: vaultPda })
  .rpc(rpcOptions);

const agentB = await program.account.agent.fetch(
  agentBPda,
  "confirmed"
);

assert.strictEqual(agentB.active, true);

// Agent B has an independent task and recipient.
const agentBTaskId = new BN(2);
const agentBBudget = new BN(20_000);
const agentBPayment = new BN(5_000);
const agentBRecipient = Keypair.generate().publicKey;

const [agentBTaskPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("task"),
    agentBPda.toBuffer(),
    agentBTaskId.toArrayLike(Buffer, "le", 8),
  ],
  program.programId
);

const agentBRecipientAta = getAssociatedTokenAddressSync(
  tokenMint,
  agentBRecipient,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);

await sendAndConfirmTransaction(
  provider.connection,
  new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      agentBRecipientAta,
      agentBRecipient,
      tokenMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  ),
  [payer],
  { commitment: "confirmed" }
);

// Obtain a fresh expiration from the chain clock.
const clockInfoB = await provider.connection.getAccountInfo(
  SYSVAR_CLOCK_PUBKEY,
  "confirmed"
);

assert.ok(clockInfoB);

const expiresAtB = new BN(
  Number(clockInfoB.data.readBigInt64LE(32)) + 3600
);

// Agent B creates its own spending reservation.
await program.methods
  .createTask(
    agentBTaskId,
    agentBBudget,
    agentBRecipient,
    expiresAtB
  )
  .accountsPartial({
    owner,
    vault: vaultPda,
    agent: agentBPda,
    tokenMint,
    treasury: treasuryAta,
    task: agentBTaskPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc(rpcOptions);

const treasuryBeforeB = await getAccount(
  provider.connection,
  treasuryAta,
  "confirmed",
  TOKEN_PROGRAM_ID
);

// Agent B must still be able to execute an authorized payment.
await program.methods
  .executeTaskPayment(agentBPayment, new BN(0))
  .accountsPartial({
    agentAuthority: agentBSigner.publicKey,
    vault: vaultPda,
    agent: agentBPda,
    task: agentBTaskPda,
    tokenMint,
    treasury: treasuryAta,
    recipient: agentBRecipient,
    recipientToken: agentBRecipientAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([agentBSigner])
  .rpc(rpcOptions);

// Verify independent spending and reservations.
const agentBTaskAfter = await program.account.task.fetch(
  agentBTaskPda,
  "confirmed"
);

const vaultAfterB = await program.account.vault.fetch(
  vaultPda,
  "confirmed"
);

const treasuryAfterB = await getAccount(
  provider.connection,
  treasuryAta,
  "confirmed",
  TOKEN_PROGRAM_ID
);

const recipientAfterB = await getAccount(
  provider.connection,
  agentBRecipientAta,
  "confirmed",
  TOKEN_PROGRAM_ID
);

const agentAFinal = await program.account.agent.fetch(
  agentPda,
  "confirmed"
);

assert.strictEqual(agentAFinal.active, false);
assert.strictEqual(vaultAfterB.paused, false);
assert.ok(agentBTaskAfter.spent.eq(agentBPayment));
assert.ok(agentBTaskAfter.nextNonce.eq(new BN(1)));

assert.ok(
  vaultAfterB.totalReserved.eq(
    agentBBudget.sub(agentBPayment)
  )
);

assert.strictEqual(
  treasuryAfterB.amount,
  treasuryBeforeB.amount - BigInt(5_000)
);

assert.strictEqual(
  recipientAfterB.amount,
  BigInt(5_000)
);
  });
});
