/**
 * Selected-vault Model A executor. Default PREVIEW ONLY; explicit interactive
 * --execute required to sign and broadcast. Does not modify the legacy demo.
 *
 * Usage:
 * AGENTVAULT_NETWORK=devnet pnpm exec tsx demo/execute-selected-vault-payment.ts \
 *   /absolute/agentvault-approval-UUID.json <expected-vault> \
 *   [--execute --agent-key /absolute/agent-02.json]
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import bs58 from "bs58";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL } from "./runtime-config";
import {
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";
import { AGENT_WORKFLOWS } from "./workflow-policy";
import {
  assertPaymentInstructions,
  assertExactAgentVaultPayment,
  assertSerializedAgentVaultPayment,
} from "./payment-transaction-guard";
import { claimApprovedWorkflow } from "./request-journal";
import { prepareSignedPayment, loadPreparedPayment } from "./prepared-payment";
import { evaluateSelectedVaultModelA } from "./selected-vault-model-a-ai";
import {
  SELECTED_VAULT_PROGRAM,
  selectedVaultExecutionDir,
  parseExecutionArguments,
  checkedAgentKeyPath,
} from "./selected-vault-execution-scope";

async function main() {
  assert.equal(NETWORK, "devnet", "Selected-vault payments are Devnet only");
  const {
    approvalFile,
    vault: vaultPda,
    execute,
    agentKeyFile,
  } = parseExecutionArguments(process.argv.slice(2));
  if (execute)
    assert.ok(
      process.stdin.isTTY,
      "Live execution requires an interactive terminal"
    );
  assert.ok(statSync(approvalFile).isFile(), "Approval must be a regular file");
  assert.ok(statSync(approvalFile).size < 32_768, "Oversized approval file");
  const signed = signedWorkflowSchema.parse(
    JSON.parse(readFileSync(approvalFile, "utf8"))
  );
  const workflow = signed.workflow;
  assert.equal(workflow.network, "devnet");
  assert.equal(
    workflow.programId,
    SELECTED_VAULT_PROGRAM,
    "Unexpected program"
  );
  assert.equal(workflow.vault, vaultPda.toBase58(), "Wrong selected vault");
  assert.equal(
    workflow.kind,
    AGENT_WORKFLOWS[workflow.assignedAgent],
    "Workflow routing mismatch"
  );

  const runtimeDir = selectedVaultExecutionDir(vaultPda);
  const claimFile = `${runtimeDir}/journal/${workflow.requestId}.json`;
  const preparedFile = `${runtimeDir}/journal/${workflow.requestId}.signed.json`;
  assert.ok(
    !existsSync(claimFile) && !existsSync(preparedFile),
    "Request previously claimed. Inspect recovery; never rerun execution for this request."
  );

  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(
    readFileSync("target/idl/agentvault.json", "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });
  assert.equal(
    program.programId.toBase58(),
    SELECTED_VAULT_PROGRAM,
    "IDL/program mismatch"
  );
  const [genesisHash, clock, vault] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
    program.account.vault.fetch(vaultPda, "confirmed"),
  ]);
  assert.ok(clock && clock.data.length >= 40, "Solana clock unavailable");
  const nowUnix = Number(clock.data.readBigInt64LE(32));
  assert.ok(Number.isSafeInteger(nowUnix), "Invalid Solana timestamp");
  const owner = vault.owner;
  const mint = vault.tokenMint;
  const [derivedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vault.vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  assert.ok(derivedVault.equals(vaultPda), "Invalid vault PDA");
  const scope: ApprovalScope = {
    network: "devnet",
    genesisHash,
    programId: SELECTED_VAULT_PROGRAM,
    vault: vaultPda.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
  };
  verifyWorkflowApproval(signed, scope, nowUnix);

  const authority = new PublicKey(workflow.agentAuthority);
  const recipient = new PublicKey(workflow.recipient);
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
    program.programId
  );
  const taskId = new BN(workflow.taskId);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  const treasury = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const amount = new BN(workflow.amountBaseUnits);

  // Reusable live recheck, including after Gemini and human confirmation.
  async function recheck(): Promise<{ nonce: BN }> {
    const [currentVault, agent, task, token, time, currentGenesis] =
      await Promise.all([
        program.account.vault.fetch(vaultPda, "confirmed"),
        program.account.agent.fetch(agentPda, "confirmed"),
        program.account.task.fetch(taskPda, "confirmed"),
        getAccount(connection, treasury, "confirmed", TOKEN_PROGRAM_ID),
        connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
        connection.getGenesisHash(),
      ]);
    assert.equal(currentGenesis, genesisHash, "Devnet ledger changed");
    assert.ok(time && time.data.length >= 40, "Clock unavailable");
    const chainTime = time.data.readBigInt64LE(32);
    verifyWorkflowApproval(signed, scope, Number(chainTime));
    assert.equal(currentVault.paused, false, "Vault paused");
    assert.ok(
      currentVault.owner.equals(owner) && currentVault.tokenMint.equals(mint),
      "Vault identity changed"
    );
    assert.ok(agent.active && task.active, "Agent or task inactive");
    assert.ok(
      agent.vault.equals(vaultPda) && agent.authority.equals(authority),
      "Agent identity mismatch"
    );
    assert.ok(
      task.vault.equals(vaultPda) &&
        task.agent.equals(agentPda) &&
        task.taskId.eq(taskId),
      "Task identity mismatch"
    );
    assert.ok(task.recipient.equals(recipient), "Recipient allowlist changed");
    assert.ok(BigInt(task.expiresAt.toString()) > chainTime, "Task expired");
    assert.ok(
      BigInt(workflow.expiresAtUnix) <= BigInt(task.expiresAt.toString()),
      "Approval outlives task"
    );
    assert.ok(task.spent.lte(task.budget), "Invalid task budget accounting");
    assert.ok(
      amount.gt(new BN(0)) && amount.lte(task.budget.sub(task.spent)),
      "Task budget insufficient"
    );
    assert.ok(
      amount.lte(currentVault.totalReserved),
      "Reserved funds insufficient"
    );
    assert.ok(
      token.owner.equals(vaultPda) && token.mint.equals(mint),
      "Treasury owner/mint mismatch"
    );
    assert.ok(
      currentVault.totalReserved.lte(new BN(token.amount.toString())),
      "Treasury undercollateralized"
    );
    return { nonce: task.nextNonce };
  }

  const initial = await recheck();
  // This check is deliberately done *before* the AI step. No Gemini model
  // response can supply signer, vault, destination, task or payment amount.
  if (execute) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    await evaluateSelectedVaultModelA(runtimeDir, signed, scope, nowUnix);
  }
  const current = await recheck();
  assert.ok(
    current.nonce.eq(initial.nonce),
    "Task nonce changed during evaluation"
  );

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const paymentInstruction = await program.methods
    .executeTaskPayment(amount, current.nonce)
    .accountsPartial({
      agentAuthority: authority,
      vault: vaultPda,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: authority,
    recentBlockhash: blockhash,
  }).add(ataInstruction, paymentInstruction);
  const expected = {
    agentAuthority: authority,
    recipient,
    mint,
    paymentInstruction,
  };
  assertPaymentInstructions(transaction, expected);

  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();
  const preview = await connection.simulateTransaction(
    new VersionedTransaction(message),
    {
      commitment: "confirmed",
      sigVerify: false,
    }
  );
  if (preview.value.err !== null) {
    console.error(preview.value.logs?.join("\n") ?? "");
    throw new Error(
      `Unsigned preview failed: ${JSON.stringify(preview.value.err)}`
    );
  }
  console.log("\n=== SELECTED-VAULT PAYMENT PREVIEW PASSED ===");
  console.log("Request:", workflow.requestId, "Vault:", vaultPda.toBase58());
  console.log("Agent:", authority.toBase58(), "Task:", taskId.toString());
  console.log("Recipient:", recipient.toBase58(), "Amount:", amount.toString());
  console.log(
    "Nonce:",
    current.nonce.toString(),
    "CU:",
    preview.value.unitsConsumed ?? "unavailable"
  );
  if (!execute) {
    console.log(
      "Preview only: no Gemini, private key, journal, signature or broadcast."
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(
      `Type EXECUTE ${workflow.requestId} to submit Devnet payment: `
    );
  } finally {
    rl.close();
  }
  assert.equal(
    answer.trim(),
    `EXECUTE ${workflow.requestId}`,
    "Execution cancelled"
  );

  const afterConfirmation = await recheck();
  assert.ok(
    afterConfirmation.nonce.eq(current.nonce),
    "Task nonce changed after preview"
  );

  // The initial blockhash belongs to the preview. A human confirmation can
  // take longer than Solana's blockhash lifetime. Refresh only AFTER consent.
  // The signed owner approval, instructions, amount, nonce, and recipient stay unchanged.
  const executionBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = executionBlockhash.blockhash;
  assertPaymentInstructions(transaction, expected);

  // Simulate the new message BEFORE claiming or accessing agent private key.
  const freshMessage = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: executionBlockhash.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();
  const freshPreview = await connection.simulateTransaction(
    new VersionedTransaction(freshMessage),
    { commitment: "confirmed", sigVerify: false }
  );
  if (freshPreview.value.err !== null) {
    console.error(freshPreview.value.logs?.join("\n") ?? "");
    throw new Error(
      `Post-confirmation simulation failed: ${JSON.stringify(
        freshPreview.value.err
      )}`
    );
  }
  assert.ok(
    (await connection.getBlockHeight("confirmed")) <=
      executionBlockhash.lastValidBlockHeight,
    "Fresh blockhash expired before claim; request remains unclaimed."
  );
  assert.ok(agentKeyFile, "Explicit key file required");
  const privatePath = checkedAgentKeyPath(agentKeyFile, process.cwd());
  const secretKey = JSON.parse(readFileSync(privatePath, "utf8")) as number[];
  assert.ok(
    Array.isArray(secretKey) &&
      secretKey.length === 64 &&
      secretKey.every((x) => Number.isInteger(x) && x >= 0 && x <= 255),
    "Invalid agent key material"
  );
  const signer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  assert.ok(
    signer.publicKey.equals(authority),
    "Private key does not match registered agent"
  );

  // After claim, never retry this request, even if subsequent RPC calls fail.
  claimApprovedWorkflow(
    runtimeDir,
    signed,
    scope,
    Number(
      (await connection.getAccountInfo(
        SYSVAR_CLOCK_PUBKEY,
        "confirmed"
      ))!.data.readBigInt64LE(32)
    )
  );
  transaction.sign(signer);
  assertExactAgentVaultPayment(transaction, expected);
  prepareSignedPayment(
    runtimeDir,
    workflow.requestId,
    workflow.assignedAgent,
    authority,
    taskPda,
    workflow.amountBaseUnits,
    current.nonce.toString(),
    executionBlockhash.lastValidBlockHeight,
    transaction
  );
  const prepared = loadPreparedPayment(runtimeDir, workflow.requestId);
  assertSerializedAgentVaultPayment(prepared.transaction, expected);
  assert.equal(
    prepared.record.lastValidBlockHeight,
    executionBlockhash.lastValidBlockHeight
  );
  assert.equal(prepared.record.taskPda, taskPda.toBase58());
  assert.equal(prepared.record.nonce, current.nonce.toString());
  const signature = bs58.encode(prepared.transaction.signature!);
  console.log("\nDURABLY PREPARED: signature", signature);
  const signedSimulation = await connection.simulateTransaction(
    VersionedTransaction.deserialize(prepared.raw),
    { commitment: "confirmed", sigVerify: true }
  );
  if (signedSimulation.value.err !== null) {
    console.error(signedSimulation.value.logs?.join("\n") ?? "");
    throw new Error(
      "Prepared signed transaction failed simulation; request remains claimed"
    );
  }
  const returned = await connection.sendRawTransaction(prepared.raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 2,
  });
  assert.equal(returned, signature, "RPC returned another signature");
  console.log("BROADCAST:", signature);
  console.log(
    `Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
  const confirmed = await connection.confirmTransaction(
    {
      signature,
      blockhash: executionBlockhash.blockhash,
      lastValidBlockHeight: executionBlockhash.lastValidBlockHeight,
    },
    "confirmed"
  );
  assert.equal(
    confirmed.value.err,
    null,
    "Payment failed on-chain; use recovery"
  );
  console.log(
    "PAYMENT CONFIRMED: journal retained and nonce should advance on-chain"
  );
}

main().catch((error) => {
  console.error(
    "\nEXECUTOR STOPPED:",
    error instanceof Error ? error.message : error
  );
  console.error(
    "If this request was claimed, DO NOT rerun it or delete the journal; inspect recovery."
  );
  process.exitCode = 1;
});
