import test from "node:test";
import assert from "node:assert/strict";

import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import {
  encodePaymentApprovalV2,
  verifyPaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

const owner = Keypair.generate();

const address = () => Keypair.generate().publicKey.toBase58();

const approval: PaymentApprovalV2 = {
  version: 2,
  genesisHash: address(),
  programId: address(),
  vault: address(),
  owner: owner.publicKey.toBase58(),
  mint: address(),
  agent: address(),
  agentAuthority: address(),
  task: address(),
  recipient: address(),
  amountBaseUnits: "10000",
  nonce: "0",
  expiresAtUnix: "2000000000",
  requestId: "procurement-001",
};

function sign(input: PaymentApprovalV2): string {
  return Buffer.from(
    nacl.sign.detached(encodePaymentApprovalV2(input), owner.secretKey)
  ).toString("base64");
}

test("encodes the same approval deterministically", () => {
  const first = encodePaymentApprovalV2(approval);
  const second = encodePaymentApprovalV2({ ...approval });

  assert.deepEqual(first, second);
});

test("verifies a valid owner signature", () => {
  assert.equal(
    verifyPaymentApprovalV2(approval, sign(approval), owner.publicKey),
    true
  );
});

test("rejects signatures from an unauthorized owner", () => {
  const attacker = Keypair.generate();

  assert.equal(
    verifyPaymentApprovalV2(
      approval,
      Buffer.from(
        nacl.sign.detached(
          encodePaymentApprovalV2(approval),
          attacker.secretKey
        )
      ).toString("base64"),
      owner.publicKey
    ),
    false
  );
});

for (const field of [
  "amountBaseUnits",
  "nonce",
  "task",
  "agent",
  "recipient",
  "genesisHash",
  "requestId",
] as const) {
  test(`rejects tampering with ${field}`, () => {
    const originalSignature = sign(approval);

    const changed = {
      ...approval,
      [field]:
        field === "amountBaseUnits"
          ? "20000"
          : field === "nonce"
          ? "1"
          : field === "requestId"
          ? "procurement-002"
          : address(),
    };

    assert.equal(
      verifyPaymentApprovalV2(changed, originalSignature, owner.publicKey),
      false
    );
  });
}

test("rejects invalid numeric ranges", () => {
  assert.throws(() =>
    encodePaymentApprovalV2({
      ...approval,
      amountBaseUnits: "0",
    })
  );

  assert.throws(() =>
    encodePaymentApprovalV2({
      ...approval,
      amountBaseUnits: "18446744073709551616",
    })
  );

  assert.throws(() =>
    encodePaymentApprovalV2({
      ...approval,
      nonce: "-1",
    })
  );
});

test("rejects unexpected approval fields", () => {
  assert.throws(() =>
    encodePaymentApprovalV2({
      ...approval,
      unexpectedField: "not signed",
    })
  );
});

test("matches the fixed Rust v2 serialization vector", () => {
  const key = (byte: number) =>
    new PublicKey(new Uint8Array(32).fill(byte)).toBase58();

  const message = encodePaymentApprovalV2({
    version: 2,
    genesisHash: key(1),
    programId: key(2),
    vault: key(3),
    owner: key(4),
    mint: key(5),
    agent: key(6),
    agentAuthority: key(7),
    task: key(8),
    recipient: key(9),
    amountBaseUnits: "10000",
    nonce: "7",
    expiresAtUnix: "2000000000",
    requestId: "procurement-001",
  });

  assert.equal(message.length, 375);

  assert.equal(
    createHash("sha256").update(message).digest("hex"),
    "56b2c11912920eaa9f7156bd5e35cb8963dae1cebfefb5a9d9e23dc133f96721"
  );
});
