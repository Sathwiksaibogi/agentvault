import { classifyPayment } from "./payment-recovery-state";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection } from "@solana/web3.js";
import bs58 from "bs58";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

import { loadPreparedPayment } from "./prepared-payment";
import { recoveryModeFromClaim } from "./payment-recovery-mode";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { inspectModelBRecovery } from "./model-b-read-only-recovery";

type RecoveryState = {
  genesisHash: string;
  vault: string;
  owner: string;
  mint?: string;
  programId?: string;
};

type RecoverySummary = {
  network: string;
  authorization: string;
  requestId: string;
  signature: string;
  amountBaseUnits: number;
  nonce: string;
  savedBytes: number;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  recoveryState: ReturnType<typeof classifyPayment>;
};

function printRecoverySummary(result: RecoverySummary): void {
  console.log("\n=== AGENTVAULT PAYMENT RECOVERY ===");
  console.log("Network:", result.network);
  console.log("Authorization:", result.authorization);
  console.log("Request:", result.requestId);
  console.log("Signature:", result.signature);
  console.log("Amount:", result.amountBaseUnits);
  console.log("Nonce:", result.nonce);
  console.log("Saved bytes:", result.savedBytes);
  console.log("Current block height:", result.currentBlockHeight);
  console.log("Last valid block height:", result.lastValidBlockHeight);
  console.log("\nRecovery state:", result.recoveryState);

  switch (result.recoveryState) {
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

  // Model B uses a separately verified v2 claim, canonical saved bytes and
  // read-only signature-status inspection. It never falls through to Model A.
  if (mode === "model-b") {
    assert.ok(
      typeof state.mint === "string",
      "Model B recovery requires a configured mint"
    );
    const result = await inspectModelBRecovery(
      RUNTIME_DIR,
      requestId,
      {
        network: NETWORK,
        genesisHash: state.genesisHash,
        programId: AGENTVAULT_PROGRAM_ID.toBase58(),
        vault: state.vault,
        owner: state.owner,
        mint: state.mint,
      },
      new Connection(RPC_URL, "confirmed")
    );
    printRecoverySummary({ ...result, authorization: mode });
    return;
  }

  // Preserve the existing Model A recovery path and its original journal.
  const { record, transaction, raw } = loadPreparedPayment(
    RUNTIME_DIR,
    requestId
  );
  assert.equal(record.network, NETWORK);
  assert.ok(transaction.signature);
  const signature = bs58.encode(transaction.signature);
  assert.equal(
    Buffer.from(transaction.signature).toString("base64"),
    record.signatureBase64,
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

  printRecoverySummary({
    network: NETWORK,
    authorization: mode,
    requestId,
    signature,
    amountBaseUnits: record.amountBaseUnits,
    nonce: record.nonce,
    savedBytes: raw.length,
    currentBlockHeight,
    lastValidBlockHeight: record.lastValidBlockHeight,
    recoveryState,
  });
}

main().catch((error) => {
  console.error(
    "Recovery check failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
