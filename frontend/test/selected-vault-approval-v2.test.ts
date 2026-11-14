import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  encodePaymentApprovalV2Browser,
  type PaymentApprovalV2,
} from "../src/selected-vault-approval-v2";
import { encodePaymentApprovalV2 } from "../../demo/payment-approval-v2";

test("browser encoder for PaymentApprovalV2 matches demo/payment-approval-v2 byte-for-byte", async () => {
  const approval: PaymentApprovalV2 = {
    version: 2,
    genesisHash: Keypair.generate().publicKey.toBase58(),
    programId: "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d",
    vault: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    agentAuthority: Keypair.generate().publicKey.toBase58(),
    task: Keypair.generate().publicKey.toBase58(),
    recipient: Keypair.generate().publicKey.toBase58(),
    amountBaseUnits: "123456789",
    nonce: "42",
    expiresAtUnix: "1731600000",
    requestId: "req_test_browser_approval_01",
  };

  const browserBytes = await encodePaymentApprovalV2Browser(approval);
  const nodeBytes = encodePaymentApprovalV2(approval);

  assert.equal(browserBytes.length, 375);
  assert.equal(nodeBytes.length, 375);
  assert.deepEqual(Buffer.from(browserBytes), nodeBytes);
});
