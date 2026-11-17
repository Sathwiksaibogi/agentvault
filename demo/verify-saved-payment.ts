import * as anchor from "@anchor-lang/core";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection } from "@solana/web3.js";

import type { Agentvault } from "../target/types/agentvault";

import {
  NETWORK,
  RPC_URL,
  RUNTIME_DIR,
} from "./runtime-config";

import { verifySavedPaymentIntegrity } from "./saved-payment-integrity";

async function main() {
  const requestId = process.argv[2];

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Usage: verify-saved-payment.ts <request-id>"
  );

  const state = JSON.parse(
    readFileSync(
      join(RUNTIME_DIR, "state.json"),
      "utf8"
    )
  );

  const idl = JSON.parse(
    readFileSync(
      join(process.cwd(), "target/idl/agentvault.json"),
      "utf8"
    )
  ) as Agentvault;

  // Constructing the connection does not make an RPC request.
  const program = new anchor.Program<Agentvault>(idl, {
    connection: new Connection(RPC_URL, "confirmed"),
  });

  const verified = await verifySavedPaymentIntegrity(
    RUNTIME_DIR,
    requestId,
    {
      network: NETWORK,
      genesisHash: state.genesisHash,
      programId: state.programId,
      vault: state.vault,
      owner: state.owner,
      mint: state.mint,
      treasury: state.treasury,
    },
    program
  );

  console.log("\n=== SAVED PAYMENT VERIFICATION PASSED ===");
  console.log("Request:", verified.requestId);
  console.log("Agent:", verified.agent);
  console.log("Amount:", verified.amountBaseUnits);
  console.log("Nonce:", verified.nonce);
  console.log("Signature:", verified.signature);
  console.log("Owner signature: VERIFIED");
  console.log("Saved signature: VERIFIED");
  console.log("Compiled message: VERIFIED");
  console.log("\nMODE: OFFLINE VERIFICATION");
  console.log("No payment broadcast.");
}

main().catch((error) => {
  console.error(
    "Saved payment verification failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});