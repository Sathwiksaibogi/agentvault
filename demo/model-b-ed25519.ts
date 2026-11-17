import {
  Ed25519Program,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import * as nacl from "tweetnacl";

import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

export function buildModelBOwnerVerificationInstruction(
  approval: PaymentApprovalV2,
  ownerSignature: Uint8Array
): TransactionInstruction {
  // Reconstruct the canonical signed bytes.
  const message = encodePaymentApprovalV2(approval);

  const owner = new PublicKey(approval.owner);

  if (
    !(ownerSignature instanceof Uint8Array) ||
    ownerSignature.length !== nacl.sign.signatureLength
  ) {
    throw new Error("Invalid Model B signature length");
  }

  // Validate the exact owner signature before submitting
  // a transaction to the validator.
  const valid = nacl.sign.detached.verify(
    message,
    ownerSignature,
    owner.toBytes()
  );

  if (!valid) {
    throw new Error("Invalid Model B owner signature");
  }

  // Solana verifies this signature natively.
  // The AgentVault program then checks the exact
  // message, owner and canonical instruction layout.
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: owner.toBytes(),
    message,
    signature: ownerSignature,
  });
}
