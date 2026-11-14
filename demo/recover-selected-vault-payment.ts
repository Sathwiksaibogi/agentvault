/** Read-only recovery of a selected-vault payment. Never signs or broadcasts. */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import { Connection } from "@solana/web3.js";
import { NETWORK, RPC_URL } from "./runtime-config";
import {
  canonicalVault,
  selectedVaultExecutionDir,
} from "./selected-vault-execution-scope";
import { loadPreparedPayment } from "./prepared-payment";

async function main() {
  assert.equal(NETWORK, "devnet", "Recovery is Devnet only");
  assert.equal(
    process.argv.length,
    4,
    "Usage: recover-selected-vault-payment.ts <vault> <request-id>"
  );
  const vault = canonicalVault(process.argv[2]);
  const request = process.argv[3];
  assert.match(request, /^[a-zA-Z0-9_-]{8,64}$/);
  const dir = selectedVaultExecutionDir(vault);
  const claimPath = join(dir, "journal", `${request}.json`);
  if (!existsSync(claimPath)) {
    console.log(
      "No claim in selected-vault journal. No transaction in this journal."
    );
    return;
  }
  const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
    vault: string;
    requestId: string;
    status: string;
  };
  assert.equal(claim.vault, vault.toBase58(), "Claim is for another vault");
  assert.equal(claim.requestId, request);
  console.log("Request:", request, "Claim:", claim.status);
  if (!existsSync(join(dir, "journal", `${request}.signed.json`))) {
    console.log(
      "No prepared signed transaction in journal; investigate before any retry."
    );
    return;
  }
  const prepared = loadPreparedPayment(dir, request);
  const signature = bs58.encode(prepared.transaction.signature!);
  console.log("Prepared transaction signature:", signature);
  console.log(
    `Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const result = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = result.value[0];
  if (status === null)
    console.log(
      "RPC status unknown; do not assume failure. Inspect Explorer/RPC history."
    );
  else console.log("On-chain status:", JSON.stringify(status));
  console.log("READ ONLY. Nothing was signed or retransmitted.");
}
main().catch((error) => {
  console.error(
    "RECOVERY BLOCKED:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
