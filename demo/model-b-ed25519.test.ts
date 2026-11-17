import test from "node:test";
import assert from "node:assert/strict";

import { Ed25519Program, Keypair } from "@solana/web3.js";

import * as nacl from "tweetnacl";

import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

import { buildModelBOwnerVerificationInstruction } from "./model-b-ed25519";

function fixture() {
  const owner = Keypair.generate();
  const key = () => Keypair.generate().publicKey.toBase58();

  const approval: PaymentApprovalV2 = {
    version: 2,
    genesisHash: key(),
    programId: key(),
    vault: key(),
    owner: owner.publicKey.toBase58(),
    mint: key(),
    agent: key(),
    agentAuthority: key(),
    task: key(),
    recipient: key(),
    amountBaseUnits: "1000",
    nonce: "0",
    expiresAtUnix: "2000000000",
    requestId: "model-b-integration-001",
  };

  const message = encodePaymentApprovalV2(approval);
  const signature = nacl.sign.detached(message, owner.secretKey);

  return { owner, approval, message, signature };
}

test("creates a canonical Ed25519 instruction from a valid approval", () => {
  const { approval, message, signature } = fixture();

  const ix = buildModelBOwnerVerificationInstruction(approval, signature);

  assert.ok(ix.programId.equals(Ed25519Program.programId));
  assert.equal(ix.keys.length, 0);

  // Require embedded-data references (0xffff).
  assert.equal(ix.data.readUInt16LE(4), 0xffff);
  assert.equal(ix.data.readUInt16LE(8), 0xffff);
  assert.equal(ix.data.readUInt16LE(14), 0xffff);

  assert.deepEqual(ix.data.subarray(112), message);
});

test("rejects a signature from the wrong owner", () => {
  const { approval, message } = fixture();

  const attacker = Keypair.generate();
  const signature = nacl.sign.detached(message, attacker.secretKey);

  assert.throws(
    () => buildModelBOwnerVerificationInstruction(approval, signature),
    /Invalid Model B owner signature/
  );
});

test("rejects payment details modified after signing", () => {
  const { approval, signature } = fixture();

  assert.throws(
    () =>
      buildModelBOwnerVerificationInstruction(
        {
          ...approval,
          amountBaseUnits: "2000",
        },
        signature
      ),
    /Invalid Model B owner signature/
  );
});

test("rejects malformed signatures", () => {
  const { approval } = fixture();

  assert.throws(
    () => buildModelBOwnerVerificationInstruction(approval, new Uint8Array(32)),
    /Invalid Model B signature length/
  );
});
