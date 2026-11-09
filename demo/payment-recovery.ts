import { classifyPayment } from "./payment-recovery-state";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection } from "@solana/web3.js";
import bs58 from "bs58";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

import { loadPreparedPayment } from "./prepared-payment";
import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import { recoveryModeFromClaim } from "./payment-recovery-mode";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { signedWorkflowSchema } from "./signed-workflow";

type RecoveryState = {
  genesisHash: string;
  vault: string;
  owner: string;
  mint?: string;
  programId?: string;
};

async function main() {
  const requestId = process.argv[2];

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Usage: payment-recovery.ts <request-id>"
  );

  // 1. Determine authorization model BEFORE loading
  // either model's saved transaction.
  const claim = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "journal", `${requestId}.json`), "utf8")
  );

  const mode = recoveryModeFromClaim(claim, requestId);

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as RecoveryState;

  assert.equal(claim.network, NETWORK);
  assert.equal(claim.genesisHash, state.genesisHash);
  assert.equal(claim.vault, state.vault);
  assert.equal(claim.owner, state.owner);

  if (state.programId !== undefined) {
    assert.equal(
      state.programId,
      AGENTVAULT_PROGRAM_ID.toBase58(),
      "Configured program ID mismatch"
    );
  }

  // 2. Dispatch to exactly one persistence verifier.
  // Model B never falls back to Model A.
  const prepared =
    mode === "model-a"
      ? loadPreparedPayment(RUNTIME_DIR, requestId)
      : (() => {
          assert.ok(
            typeof state.mint === "string",
            "Model B recovery requires a configured mint"
          );

          assert.equal(
            claim.programId,
            AGENTVAULT_PROGRAM_ID.toBase58(),
            "Model B program mismatch"
          );

          assert.equal(claim.mint, state.mint, "Model B mint mismatch");

          const signedWorkflow = signedWorkflowSchema.parse(
            JSON.parse(
              readFileSync(
                join(RUNTIME_DIR, "approvals", `${requestId}.json`),
                "utf8"
              )
            )
          );

          return loadPreparedModelBPayment(
            RUNTIME_DIR,
            requestId,
            signedWorkflow,
            {
              network: NETWORK,
              genesisHash: state.genesisHash,
              programId: AGENTVAULT_PROGRAM_ID.toBase58(),
              vault: state.vault,
              owner: state.owner,
              mint: state.mint,
            }
          );
        })();

  const { record, transaction, raw } = prepared;

  assert.equal(record.network, NETWORK);
  assert.ok(transaction.signature);

  // Both loaders verify serialized bytes and agent
  // signatures before returning.
  const signature = bs58.encode(transaction.signature);

  const signatureBase64 =
    record.version === 1
      ? record.signatureBase64
      : record.transactionSignatureBase64;

  assert.equal(
    Buffer.from(transaction.signature).toString("base64"),
    signatureBase64,
    "Recovered agent signature mismatch"
  );

  // 3. Validate the RPC ledger before asking for status.
  const connection = new Connection(RPC_URL, "confirmed");

  assert.equal(
    await connection.getGenesisHash(),
    state.genesisHash,
    "RPC belongs to the wrong ledger"
  );

  const statusResponse = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });

  const status = statusResponse.value[0];

  const currentBlockHeight = await connection.getBlockHeight("confirmed");

  const recoveryState = classifyPayment(
    status,
    currentBlockHeight,
    record.lastValidBlockHeight
  );

  console.log("\n=== AGENTVAULT PAYMENT RECOVERY ===");
  console.log("Network:", NETWORK);
  console.log("Authorization:", mode);
  console.log("Request:", requestId);
  console.log("Signature:", signature);
  console.log("Amount:", record.amountBaseUnits);
  console.log("Nonce:", record.nonce);
  console.log("Saved bytes:", raw.length);
  console.log("Current block height:", currentBlockHeight);
  console.log("Last valid block height:", record.lastValidBlockHeight);

  console.log("\nRecovery state:", recoveryState);

  switch (recoveryState) {
    case "CONFIRMED":
      console.log("Solana reports a successful confirmed transaction.");
      break;

    case "FAILED_ON_CHAIN":
      console.log("Solana reports failure. Review transaction logs.");
      break;

    case "OBSERVED_UNCONFIRMED":
      console.log("Transaction observed; confirmation remains pending.");
      break;

    case "PENDING":
      console.log("Blockhash remains valid. Preserve exact signed bytes.");
      console.log(
        "Only the original transaction may be considered for rebroadcast."
      );
      break;

    case "EXPIRED_UNRESOLVED":
      console.log("Blockhash expired without a definitive RPC result.");
      console.log("KEEP REQUEST LOCKED. Do not create a new payment.");
      break;
  }

  console.log("\nMODE: READ ONLY");
  console.log("No transaction broadcast or journal mutation.");
}

main().catch((error) => {
  console.error(
    "Recovery check failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
