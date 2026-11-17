import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import { encodeWorkflowV2, signedWorkflowV2Schema } from "./signed-workflow-v2";

const DIGEST_DOMAIN = "agentvault:model-b-workflow-digest:v1\0";

/**
 * Binds a Model B journal claim to the exact
 * owner-signed workflow v2 message and signature.
 *
 * Historical verification deliberately does not
 * require the workflow to remain unexpired.
 *
 * Scope, expiry and on-chain state must be checked
 * separately by the workflow binding.
 */
export function computeModelBWorkflowDigest(input: unknown): string {
  const signed = signedWorkflowV2Schema.parse(input);

  const signature = Buffer.from(signed.signature, "base64");

  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signed.signature
  ) {
    throw new Error("Malformed Model B workflow signature");
  }

  const message = encodeWorkflowV2(signed.workflow);

  if (
    !nacl.sign.detached.verify(
      message,
      signature,
      new PublicKey(signed.workflow.owner).toBytes()
    )
  ) {
    throw new Error("Invalid Model B workflow signature");
  }

  return createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update(message)
    .update(signature)
    .digest("hex");
}
