import { classifyPayment } from "./payment-recovery-state";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection } from "@solana/web3.js";
import bs58 from "bs58";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";
import { loadPreparedPayment } from "./prepared-payment";
import type { RequestJournalRecord } from "./request-journal";

async function main() {
  const requestId = process.argv[2];

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Usage: payment-recovery.ts <request-id>"
  );

  // Load the exact previously signed transaction.
  // This verifies its digest and cryptographic signature.
  const { record, transaction, raw } = loadPreparedPayment(
    RUNTIME_DIR,
    requestId
  );

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  );

  const claim = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "journal", `${requestId}.json`), "utf8")
  ) as RequestJournalRecord;

  assert.strictEqual(record.network, NETWORK);
  assert.strictEqual(claim.network, NETWORK);
  assert.strictEqual(claim.genesisHash, state.genesisHash);
  assert.strictEqual(claim.vault, state.vault);
  assert.strictEqual(claim.owner, state.owner);

  // Compare the saved transaction signature with its
  // restored signature before querying Solana.
  assert.ok(transaction.signature);

  const signature = bs58.encode(transaction.signature);

  assert.strictEqual(
    Buffer.from(transaction.signature).toString("base64"),
    record.signatureBase64
  );

  const connection = new Connection(RPC_URL, "confirmed");

  assert.strictEqual(
    await connection.getGenesisHash(),
    state.genesisHash,
    "RPC belongs to the wrong ledger"
  );

  // Search historical status as well as recent status.
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
  console.log("Request:", requestId);
  console.log("Agent:", record.agent);
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
      console.log("Blockhash remains valid. Preserve the exact signed bytes.");
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
