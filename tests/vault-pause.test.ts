import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
getAccount,
mintTo,
getAssociatedTokenAddressSync,
createAssociatedTokenAccountInstruction,
ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { strict as assert } from "assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Vault Pause Security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Separate vault from the existing sequential integration suite.
  const vaultId = new BN(
  Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)),
  "le"
);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  let tokenMint: PublicKey;

  before(async () => {
    tokenMint = await createMint(
      provider.connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("allows the owner to pause and unpause the vault", async () => {
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();

    let vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, true);

    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();

    vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, false);
  });

  it("rejects pause attempts by a non-owner", async () => {
    const attacker = Keypair.generate();

    const airdrop = await provider.connection.requestAirdrop(
      attacker.publicKey,
      LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(
      airdrop,
      "confirmed"
    );

    await assert.rejects(async () => {
      await program.methods
        .setVaultPaused(true)
        .accountsPartial({
          owner: attacker.publicKey,
          vault: vaultPda,
        })
        .signers([attacker])
        .rpc();
    });

    const vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, false);
  });

  it("allows repeated pause and unpause operations", async () => {
    for (const paused of [true, true, false, false]) {
      await program.methods
        .setVaultPaused(paused)
        .accountsPartial({ owner, vault: vaultPda })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.strictEqual(vault.paused, paused);
    }
  });
  it("blocks payment while paused without changing financial state, then resumes", async () => {
  const agentSigner = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  const taskId = new BN(610002);
  const budget = new BN(100_000);
  const depositAmount = new BN(200_000);
  const paymentAmount = new BN(10_000);

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

  // Derive canonical token accounts.
const ownerAta = {
  address: getAssociatedTokenAddressSync(
    tokenMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
};

const treasuryAta = {
  address: getAssociatedTokenAddressSync(
    tokenMint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
};

const recipientAta = {
  address: getAssociatedTokenAddressSync(
    tokenMint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
};

// Create all three ATAs in one transaction.
const createAtasTx = new Transaction().add(
  createAssociatedTokenAccountInstruction(
    owner,
    ownerAta.address,
    owner,
    tokenMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
  createAssociatedTokenAccountInstruction(
    owner,
    treasuryAta.address,
    vaultPda,
    tokenMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
  createAssociatedTokenAccountInstruction(
    owner,
    recipientAta.address,
    recipient,
    tokenMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )
);

await sendAndConfirmTransaction(
  provider.connection,
  createAtasTx,
  [payer],
  { commitment: "confirmed" }
);


  // Fund the treasury through AgentVault's deposit instruction.
  await mintTo(
    provider.connection,
    payer,
    tokenMint,
    ownerAta.address,
    payer,
    200_000,
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
      ownerTokenAccount: ownerAta.address,
      treasury: treasuryAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

 // Register the agent and wait for confirmation.
const registerTx = await program.methods
  .registerAgent(agentSigner.publicKey)
  .accountsPartial({
    owner,
    vault: vaultPda,
    agent: agentPda,
    systemProgram: SystemProgram.programId,
  })
  .rpc({
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

console.log("Agent registration transaction:", registerTx);
console.log("Agent PDA:", agentPda.toBase58());

// Verify initialization before creating a task.
const registeredAgent = await program.account.agent.fetch(
  agentPda,
  "confirmed"
);

assert.ok(registeredAgent.vault.equals(vaultPda));
assert.ok(
  registeredAgent.authority.equals(agentSigner.publicKey)
);
assert.strictEqual(registeredAgent.active, true);

console.log("Agent successfully initialized and confirmed");

  // Obtain actual chain time for task expiry.
  const clockInfo = await provider.connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  assert.ok(clockInfo);

  const chainNow = Number(clockInfo.data.readBigInt64LE(32));
  const expiresAt = new BN(chainNow + 3600);

  await program.methods
    .createTask(taskId, budget, recipient, expiresAt)
    .accountsPartial({
      owner,
      vault: vaultPda,
      agent: agentPda,
      tokenMint,
      treasury: treasuryAta.address,
      task: taskPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
     })
  .rpc({
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // Capture financial state before the rejected payment.
  const taskBefore = await program.account.task.fetch(
    taskPda,
    "confirmed"
  );

  const vaultBefore = await program.account.vault.fetch(
    vaultPda,
    "confirmed"
  );

  const treasuryBefore = await getAccount(
    provider.connection,
    treasuryAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  const recipientBefore = await getAccount(
    provider.connection,
    recipientAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(taskBefore.spent.eq(new BN(0)));
  assert.ok(taskBefore.nextNonce.eq(new BN(0)));
  assert.ok(vaultBefore.totalReserved.eq(budget));
 assert.strictEqual(recipientBefore.amount, BigInt(0));

  const pauseSignature = await program.methods
  .setVaultPaused(true)
  .accountsPartial({
    owner,
    vault: vaultPda,
  })
  .rpc({
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

const pauseConfirmation =
  await provider.connection.confirmTransaction(
    pauseSignature,
    "confirmed"
  );

assert.strictEqual(pauseConfirmation.value.err, null);

const vaultImmediatelyAfterPause =
  await program.account.vault.fetch(
    vaultPda,
    "confirmed"
  );

console.log("Pause transaction:", pauseSignature);
console.log(
  "Paused immediately after transaction:",
  vaultImmediatelyAfterPause.paused
);

assert.strictEqual(
  vaultImmediatelyAfterPause.paused,
  true,
  "Vault must be paused before attempting payment"
);

  // The payment is otherwise valid but must fail with VaultPaused.
  await assert.rejects(
    async () => {
      await program.methods
        .executeTaskPayment(paymentAmount, taskBefore.nextNonce)
        .accountsPartial({
          agentAuthority: agentSigner.publicKey,
          vault: vaultPda,
          agent: agentPda,
          task: taskPda,
          tokenMint,
          treasury: treasuryAta.address,
          recipient,
          recipientToken: recipientAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agentSigner])
        .rpc();
    },
    (error: any) => {
      const details = [
        error?.message ?? "",
        error?.error?.errorCode?.code ?? "",
        ...(error?.logs ?? []),
        ...(error?.transactionLogs ?? []),
      ].join("\n");

      assert.match(
        details,
        /VaultPaused/,
        "Payment must fail specifically with VaultPaused"
      );

      return true;
    }
  );

  // Verify the failed payment did not mutate financial state.
  const taskAfter = await program.account.task.fetch(
    taskPda,
    "confirmed"
  );

  const vaultAfter = await program.account.vault.fetch(
    vaultPda,
    "confirmed"
  );

  const treasuryAfter = await getAccount(
    provider.connection,
    treasuryAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  const recipientAfter = await getAccount(
    provider.connection,
    recipientAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  console.log("Vault state after rejected payment:", {
  paused: vaultAfter.paused,
  reserved: vaultAfter.totalReserved.toString(),
});
  assert.strictEqual(vaultAfter.paused, true);
  assert.ok(taskAfter.spent.eq(taskBefore.spent));
  assert.ok(taskAfter.nextNonce.eq(taskBefore.nextNonce));
  assert.ok(vaultAfter.totalReserved.eq(vaultBefore.totalReserved));
  assert.strictEqual(treasuryAfter.amount, treasuryBefore.amount);
  assert.strictEqual(recipientAfter.amount, recipientBefore.amount);

  // Unpause and confirm before attempting the payment.
const unpauseSignature = await program.methods
  .setVaultPaused(false)
  .accountsPartial({
    owner,
    vault: vaultPda,
  })
  .rpc({
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

const unpauseConfirmation =
  await provider.connection.confirmTransaction(
    unpauseSignature,
    "confirmed"
  );

assert.strictEqual(unpauseConfirmation.value.err, null);

// Verify that the unpause is visible on-chain.
const vaultAfterUnpause = await program.account.vault.fetch(
  vaultPda,
  "confirmed"
);

console.log("Unpause transaction:", unpauseSignature);
console.log("Vault paused after unpause:", vaultAfterUnpause.paused);

assert.strictEqual(
  vaultAfterUnpause.paused,
  false,
  "Vault must be unpaused before payment execution"
);

  const paymentSignature = await program.methods
  .executeTaskPayment(paymentAmount, taskBefore.nextNonce)
    .accountsPartial({
      agentAuthority: agentSigner.publicKey,
      vault: vaultPda,
      agent: agentPda,
      task: taskPda,
      tokenMint,
      treasury: treasuryAta.address,
      recipient,
      recipientToken: recipientAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([agentSigner])
    .rpc({
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});

const confirmation = await provider.connection.confirmTransaction(
  paymentSignature,
  "confirmed"
);

assert.strictEqual(confirmation.value.err, null);

console.log("Confirmed payment:", paymentSignature);

  // Verify successful execution updates accounting exactly once.
  const taskFinal = await program.account.task.fetch(
    taskPda,
    "confirmed"
  );

  const vaultFinal = await program.account.vault.fetch(
    vaultPda,
    "confirmed"
  );

  const treasuryFinal = await getAccount(
    provider.connection,
    treasuryAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  const recipientFinal = await getAccount(
    provider.connection,
    recipientAta.address,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  assert.strictEqual(vaultFinal.paused, false);
  assert.ok(taskFinal.spent.eq(taskBefore.spent.add(paymentAmount)));
  console.log("Payment accounting:", {
  spentBefore: taskBefore.spent.toString(),
  spentAfter: taskFinal.spent.toString(),
  expectedSpent: taskBefore.spent.add(paymentAmount).toString(),
  nonceBefore: taskBefore.nextNonce.toString(),
  nonceAfter: taskFinal.nextNonce.toString(),
  reservedBefore: vaultBefore.totalReserved.toString(),
  reservedAfter: vaultFinal.totalReserved.toString(),
  treasuryBefore: treasuryBefore.amount.toString(),
  treasuryAfter: treasuryFinal.amount.toString(),
  recipientBefore: recipientBefore.amount.toString(),
  recipientAfter: recipientFinal.amount.toString(),
});
  assert.ok(taskFinal.nextNonce.eq(taskBefore.nextNonce.addn(1)));

  assert.ok(
    vaultFinal.totalReserved.eq(
      vaultBefore.totalReserved.sub(paymentAmount)
    )
  );

  assert.strictEqual(
    treasuryFinal.amount,
    treasuryBefore.amount - BigInt(paymentAmount.toString())
  );

  assert.strictEqual(
    recipientFinal.amount,
    recipientBefore.amount + BigInt(paymentAmount.toString())
  );
});
});