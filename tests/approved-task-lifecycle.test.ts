import BN from "bn.js";
import * as anchor from "@anchor-lang/core";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { strict as assert } from "node:assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Model B Task Isolation", () => {
  const envProvider = anchor.AnchorProvider.env();

  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );

  // Create an isolated Program instance for this test.
  // Do not change the global Anchor provider.
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const owner = provider.wallet.publicKey;

  const agentSigner = Keypair.generate();
  const attacker = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  // A fresh vault ID lets us test without resetting localnet.
  const vaultId = new BN(
    Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 8)).toString(
      "hex"
    ),
    16
  );

  const taskId = new BN(42);
  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 86400);

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

  const deriveTask = (seed: string, id: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), agentPda.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  const modelATaskPda = deriveTask("task", taskId);
  const approvedTaskPda = deriveTask("approved-task", taskId);

  let tokenMint: PublicKey;
  let treasuryAta: PublicKey;
  let recipientAta: PublicKey;
  let genesisHash: PublicKey;

  async function reserved() {
    const vault = await program.account.vault.fetch(vaultPda, "confirmed");
    return vault.totalReserved.toString();
  }

  async function balances() {
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
      reserved: await reserved(),
      treasury: treasury.amount.toString(),
      recipient: recipientToken.amount.toString(),
    };
  }

  async function createApproved(
    id: BN,
    budget: BN,
    scope = genesisHash,
    task = deriveTask("approved-task", id)
  ) {
    return program.methods
      .createApprovedTask(id, budget, recipient, expiresAt, scope)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        approvedTask: task,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  before(async () => {
    genesisHash = new PublicKey(await connection.getGenesisHash());

    tokenMint = await createMint(
      connection,
      payer,
      owner,
      null,
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
      .rpc();

    const setup = new Transaction();

    for (const [ata, authority] of [
      [treasuryAta, vaultPda],
      [ownerAta, owner],
      [recipientAta, recipient],
    ] as const) {
      setup.add(
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

    await sendAndConfirmTransaction(connection, setup, [payer], {
      commitment: "confirmed",
    });

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
      .rpc();

    await program.methods
      .registerAgent(agentSigner.publicKey)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Existing Model A task reserves 20,000.
    await program.methods
      .createTask(taskId, new BN(20_000), recipient, expiresAt)
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        tokenMint,
        treasury: treasuryAta,
        task: modelATaskPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });

    assert.equal(await reserved(), "20000");
  });

  it("creates an isolated Model B task and reserves funds", async () => {
    assert.ok(!modelATaskPda.equals(approvedTaskPda));

    await createApproved(taskId, new BN(25_000));

    const task = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    assert.ok(task.vault.equals(vaultPda));
    assert.ok(task.agent.equals(agentPda));
    assert.ok(task.recipient.equals(recipient));
    assert.ok(task.genesisHash.equals(genesisHash));

    assert.equal(task.budget.toString(), "25000");
    assert.equal(task.spent.toString(), "0");
    assert.equal(task.nextNonce.toString(), "0");
    assert.equal(task.active, true);

    assert.deepEqual(await balances(), {
      reserved: "45000",
      treasury: "100000",
      recipient: "0",
    });
  });

  it("rejects invalid Model B task creation", async () => {
    const beforeState = await balances();

    // Invalid owner-configured approval scope.
    await assert.rejects(
      createApproved(new BN(43), new BN(10_000), SystemProgram.programId)
    );

    // Cannot reserve more than available funds.
    await assert.rejects(createApproved(new BN(44), new BN(90_000)));

    // A second initialization of the same PDA fails.
    await assert.rejects(createApproved(taskId, new BN(25_000)));

    // A different signer cannot create a task for this vault.
    await assert.rejects(
      program.methods
        .createApprovedTask(
          new BN(45),
          new BN(10_000),
          recipient,
          expiresAt,
          genesisHash
        )
        .accountsPartial({
          owner: attacker.publicKey,
          vault: vaultPda,
          agent: agentPda,
          tokenMint,
          treasury: treasuryAta,
          approvedTask: deriveTask("approved-task", new BN(45)),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc()
    );

    assert.deepEqual(await balances(), beforeState);
  });

  it("blocks Model B spending through the Model A instruction", async () => {
    const beforeState = await balances();

    await assert.rejects(
      program.methods
        .executeTaskPayment(new BN(1_000), new BN(0))
        .accountsPartial({
          agentAuthority: agentSigner.publicKey,
          vault: vaultPda,
          agent: agentPda,
          task: approvedTaskPda,
          tokenMint,
          treasury: treasuryAta,
          recipient,
          recipientToken: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agentSigner])
        .rpc(),
      (error: unknown) => {
        const message = String((error as Error).message ?? error);

        // The existing Task account decoder must reject
        // the distinct ApprovedTask discriminator.
        assert.match(message, /AccountDiscriminatorMismatch|3002|0xbba/i);
        return true;
      }
    );

    const approved = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    assert.equal(approved.spent.toString(), "0");
    assert.equal(approved.nextNonce.toString(), "0");
    assert.deepEqual(await balances(), beforeState);
  });

  it("allows owner revocation during pause without double release", async () => {
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();

    const beforeState = await balances();

    await assert.rejects(createApproved(new BN(46), new BN(1_000)));

    // An attacker cannot revoke the reserved task.
    await assert.rejects(
      program.methods
        .revokeApprovedTask()
        .accountsPartial({
          owner: attacker.publicKey,
          vault: vaultPda,
          agent: agentPda,
          approvedTask: approvedTaskPda,
        })
        .signers([attacker])
        .rpc()
    );

    assert.deepEqual(await balances(), beforeState);

    // Emergency recovery remains available while paused.
    await program.methods
      .revokeApprovedTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        approvedTask: approvedTaskPda,
      })
      .rpc();

    assert.equal(await reserved(), "20000");

    const revoked = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    assert.equal(revoked.active, false);

    await assert.rejects(
      program.methods
        .revokeApprovedTask()
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          approvedTask: approvedTaskPda,
        })
        .rpc()
    );

    assert.equal(await reserved(), "20000");

    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();
  });

  it("preserves ordinary Model A payments and treasury accounting", async () => {
    await program.methods
      .executeTaskPayment(new BN(2_000), new BN(0))
      .accountsPartial({
        agentAuthority: agentSigner.publicKey,
        vault: vaultPda,
        agent: agentPda,
        task: modelATaskPda,
        tokenMint,
        treasury: treasuryAta,
        recipient,
        recipientToken: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentSigner])
      .rpc();

    assert.deepEqual(await balances(), {
      reserved: "18000",
      treasury: "98000",
      recipient: "2000",
    });

    await program.methods
      .revokeTask()
      .accountsPartial({
        owner,
        vault: vaultPda,
        agent: agentPda,
        task: modelATaskPda,
      })
      .rpc();

    assert.deepEqual(await balances(), {
      reserved: "0",
      treasury: "98000",
      recipient: "2000",
    });

    const modelB = await program.account.approvedTask.fetch(
      approvedTaskPda,
      "confirmed"
    );

    assert.equal(modelB.active, false);
    assert.equal(modelB.spent.toString(), "0");
    assert.equal(modelB.nextNonce.toString(), "0");
  });
});
