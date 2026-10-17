/**
 * READ-ONLY recovery inspection for Phantom Vault 2 payment journals.
 * Never broadcasts, resends, unlocks or removes anything.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import { Connection } from "@solana/web3.js";

import { NETWORK, RPC_URL } from "./runtime-config";
import { classifyPayment } from "./payment-recovery-state";
import { loadPreparedPayment } from "./prepared-payment";
import {
  WEB_EXECUTION_DIR,
  assertWebDevnetConfig,
  expectedWebGenesisHash,
} from "./web-executor-config";

async function main(): Promise<void> {
  assertWebDevnetConfig();
  const requestId = process.argv[2];
  assert.ok(requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId));
  assert.equal(NETWORK, "devnet");

  const connection = new Connection(RPC_URL, "confirmed");
  assert.equal(await connection.getGenesisHash(), expectedWebGenesisHash());

  const claimPath = join(WEB_EXECUTION_DIR, "journal", `${requestId}.json`);
  const signedPath = join(
    WEB_EXECUTION_DIR,
    "journal",
    `${requestId}.signed.json`
  );

  console.log("=== VAULT 2 PAYMENT RECOVERY — READ ONLY ===");
  console.log("Request:", requestId);

  if (!existsSync(claimPath)) {
    assert.ok(!existsSync(signedPath), "Signed transaction without claim");
    console.log("No execution claim exists; no transaction was journaled.");
    return;
  }

  if (!existsSync(signedPath)) {
    console.log("CLAIMED_WITHOUT_SIGNED_TRANSACTION");
    console.log("Do NOT retry automatically; investigate before proceeding.");
    return;
  }

  // Verifies saved serialized bytes, original claim digest and signature.
  const { record, transaction } = loadPreparedPayment(
    WEB_EXECUTION_DIR,
    requestId
  );
  assert.equal(record.network, NETWORK);
  assert.ok(transaction.signature);

  const signature = bs58.encode(transaction.signature);
  const [statuses, blockHeight] = await Promise.all([
    connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    }),
    connection.getBlockHeight("confirmed"),
  ]);

  const status = classifyPayment(
    statuses.value[0],
    blockHeight,
    record.lastValidBlockHeight
  );

  console.log("Signature:", signature);
  console.log("Agent:", record.agent);
  console.log("Amount base units:", record.amountBaseUnits);
  console.log("Nonce:", record.nonce);
  console.log("Recovery classification:", status);
  console.log(
    `Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
  console.log("No transaction signed or broadcast by this script.");
  console.log(
    "Never delete this journal or rerun execution for a claimed request."
  );
}

main().catch((cause: unknown) => {
  console.error("Recovery inspection failed:", cause);
  process.exitCode = 1;
});
